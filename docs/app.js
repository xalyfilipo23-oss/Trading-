// app.js
// Logica principal: pide velas OHLC reales a Twelve Data (no screenshots),
// las manda como datos de texto a Gemini con criterio SMC, y muestra el
// veredicto + plan de trade. El Modo Automatico repite esto cada X minutos
// mientras la app este abierta.

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'qwen/qwen3.8-27b:free';
const TWELVEDATA_BASE = 'https://api.twelvedata.com/time_series';

// ---------------------------------------------------------------
// PROMPT DEL SISTEMA (adaptado para datos numericos, no imagen)
// ---------------------------------------------------------------
const SYSTEM_PROMPT = `Eres un trader profesional intradiario experto en Smart Money Concepts (SMC), analizando velas OHLC reales (no una imagen, datos numericos exactos) de un instrumento de Forex/Oro, para operaciones RAPIDAS (scalping, duracion tipica de minutos).

Se te van a dar TRES conjuntos de velas del MISMO instrumento, en tres temporalidades distintas, cada una con un proposito especifico dentro de tu analisis (metodologia top-down, de mayor a menor):

- VELAS 1H (CONTEXTO): usalas SOLO para determinar el sesgo/tendencia mayor (alcista, bajista o rango) mirando la secuencia de maximos y minimos. Este sesgo condiciona todo lo demas: si el contexto de 1H es claramente alcista, evita buscar entradas en corto salvo evidencia muy fuerte de reversion mayor, y viceversa.

- VELAS 15M (ZONA): usalas para identificar la zona de interes operativa dentro del contexto de 1H: el Order Block o zona de oferta/demanda mas relevante, priorizando los que no han sido mitigados (el precio no volvio a esa zona despues de formarse). Tambien identifica FVG (Fair Value Gaps) relevantes como zonas secundarias o imanes de precio. Esta es la zona donde esperarias que el precio reaccione, EN LA DIRECCION QUE INDICA EL CONTEXTO DE 1H.

- VELAS 5M (GATILLO): usalas para confirmar si, DENTRO de la zona de 15M identificada, ya ocurrio el gatillo de entrada: un sweep de liquidez con rechazo, o un impulso de displacement, que confirme que el precio efectivamente reacciono ahi. Si el precio de las velas 5M mas recientes no esta ni cerca de la zona de 15M, o esta en la zona pero SIN gatillo de confirmacion todavia, el veredicto debe ser NO APTO — no adivines ni te adelantes al gatillo.

Tu veredicto final APTO solo debe darse cuando las TRES capas esten alineadas: el sesgo de 1H, la zona de 15M, y el gatillo confirmado en 5M — igual que como un trader profesional analiza de mayor a menor temporalidad antes de ejecutar.

Se estricto y honesto: la mayoria de los momentos NO son una entrada valida. Solo marca APTO cuando la confluencia de las tres temporalidades sea realmente convincente. Si tienes dudas razonables, marca NO APTO.

SI Y SOLO SI el veredicto es APTO, ademas debes proponer un plan de trade concreto y ejecutable usando los precios EXACTOS de las velas de 5M (la temporalidad de ejecucion):
- gatillo: la condicion exacta que confirmo la entrada en 5M.
- entrada: precio numerico de entrada, basado en los datos reales de 5M.
- stopLoss: precio numerico del stop loss, ubicado logicamente fuera de la zona de 15M o del extremo de 5M que genero el gatillo.
- takeProfit: precio numerico del take profit, apuntando a una relacion riesgo:beneficio cercana a 3:1.
- rrReal: la relacion riesgo:beneficio real resultante (ej. "2.8:1").

Si el veredicto es NO APTO, deja gatillo, entrada, stopLoss, takeProfit y rrReal como null.

Responde EXCLUSIVAMENTE en el siguiente formato JSON, sin texto adicional antes ni despues, sin bloques de markdown:

{
  "veredicto": "APTO" o "NO APTO",
  "direccion": "LONG", "SHORT", o "NINGUNA",
  "confianza": numero del 1 al 10,
  "analisis": "Explicacion breve (4-6 frases) que mencione: el sesgo de 1H, la zona de 15M identificada, y si hubo o no gatillo confirmado en 5M — y por que llegas a este veredicto.",
  "zona": "Descripcion breve de la zona de 15M con precios.",
  "gatillo": "string o null",
  "entrada": "numero (string) o null",
  "stopLoss": "numero (string) o null",
  "takeProfit": "numero (string) o null",
  "rrReal": "string o null"
}`;

// ---------------------------------------------------------------
// ALMACENAMIENTO (localStorage, funciona igual en cualquier navegador)
// ---------------------------------------------------------------
function getSettings() {
  return {
    geminiKey: localStorage.getItem('geminiKey') || '',
    model: localStorage.getItem('model') || 'gemini-3.6-flash',
    twelveKey: localStorage.getItem('twelveKey') || '',
    openrouterKey: localStorage.getItem('openrouterKey') || ''
  };
}

function saveSettings(geminiKey, model, twelveKey, openrouterKey) {
  localStorage.setItem('geminiKey', geminiKey);
  localStorage.setItem('model', model);
  localStorage.setItem('twelveKey', twelveKey);
  localStorage.setItem('openrouterKey', openrouterKey);
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem('history') || '[]');
  } catch (e) {
    return [];
  }
}

function addToHistory(entry) {
  const history = getHistory();
  history.unshift(entry);
  localStorage.setItem('history', JSON.stringify(history.slice(0, 10)));
}

// ---------------------------------------------------------------
// DATOS DE MERCADO (Twelve Data)
// ---------------------------------------------------------------
async function fetchCandles(symbol, interval, apiKey) {
  const url = `${TWELVEDATA_BASE}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=60&apikey=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.status === 'error' || !data.values) {
    throw new Error('Error de Twelve Data: ' + (data.message || 'No se recibieron velas.'));
  }

  // Twelve Data devuelve mas reciente primero — lo invertimos a orden cronologico
  return data.values.slice().reverse();
}

function candlesToText(candles) {
  return candles
    .map((c, i) => `${i + 1}, ${c.datetime}, O:${c.open}, H:${c.high}, L:${c.low}, C:${c.close}`)
    .join('\n');
}

function buildMultiTimeframeText(symbol, candles1h, candles15m, candles5m) {
  return `Instrumento: ${symbol}

=== VELAS 1H (CONTEXTO - sesgo mayor) ===
${candlesToText(candles1h)}

=== VELAS 15M (ZONA - Order Block / FVG) ===
${candlesToText(candles15m)}

=== VELAS 5M (GATILLO - confirmacion de entrada) ===
${candlesToText(candles5m)}

Analiza las tres temporalidades con criterio SMC top-down (1H contexto, 15M zona, 5M gatillo) y responde en el formato JSON indicado.`;
}

// ---------------------------------------------------------------
// ANALISIS CON GEMINI
// ---------------------------------------------------------------
async function analyzeCandles(promptText, apiKey, model) {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: promptText }]
      }
    ],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: { temperature: 0.3 }
  };

  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Error de la API (${response.status}): ${errText || response.statusText}`);
  }

  const data = await response.json();
  const rawContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawContent) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new Error(blockReason ? `Respuesta bloqueada (${blockReason})` : 'La API no devolvio contenido.');
  }

  return parseModelJson(rawContent);
}

// ---------------------------------------------------------------
// ANALISIS CON OPENROUTER (respaldo si Gemini falla)
// ---------------------------------------------------------------
async function analyzeCandlesOpenRouter(promptText, apiKey) {
  const body = {
    model: OPENROUTER_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: promptText }
    ],
    temperature: 0.3
  };

  const response = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://xalyfilipo23-oss.github.io/Trading-/',
      'X-Title': 'SMC Copilot'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Error de OpenRouter (${response.status}): ${errText || response.statusText}`);
  }

  const data = await response.json();
  const rawContent = data?.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error('OpenRouter no devolvio contenido.');
  }

  return parseModelJson(rawContent);
}

// ---------------------------------------------------------------
// PARSEO COMPARTIDO DE LA RESPUESTA JSON (Gemini u OpenRouter)
// ---------------------------------------------------------------
function parseModelJson(rawContent) {
  let cleaned = rawContent.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

  try {
    const parsed = JSON.parse(cleaned);
    return {
      veredicto: parsed.veredicto || 'NO APTO',
      direccion: parsed.direccion || 'NINGUNA',
      confianza: parsed.confianza || null,
      analisis: parsed.analisis || '(sin analisis)',
      zona: parsed.zona || '(sin zona)',
      gatillo: parsed.gatillo || null,
      entrada: parsed.entrada || null,
      stopLoss: parsed.stopLoss || null,
      takeProfit: parsed.takeProfit || null,
      rrReal: parsed.rrReal || null
    };
  } catch (e) {
    return {
      veredicto: 'NO APTO', direccion: 'NINGUNA', confianza: null,
      analisis: rawContent, zona: '(formato inesperado)',
      gatillo: null, entrada: null, stopLoss: null, takeProfit: null, rrReal: null
    };
  }
}

// ---------------------------------------------------------------
// ANALISIS CON FALLBACK AUTOMATICO: Gemini primero, OpenRouter si falla
// ---------------------------------------------------------------
async function analyzeWithFallback(promptText, settings, statusFn) {
  try {
    return { result: await analyzeCandles(promptText, settings.geminiKey, settings.model), usedProvider: 'Gemini' };
  } catch (geminiErr) {
    console.log('SMC Copilot: Gemini fallo, intentando con OpenRouter...', geminiErr);
    if (!settings.openrouterKey) {
      throw geminiErr; // sin key de respaldo, propaga el error original
    }
    if (statusFn) statusFn('Gemini no respondio, reintentando con OpenRouter...', '');
    try {
      return { result: await analyzeCandlesOpenRouter(promptText, settings.openrouterKey), usedProvider: 'OpenRouter' };
    } catch (orErr) {
      throw new Error(`Gemini fallo (${geminiErr.message}) y OpenRouter tambien fallo (${orErr.message})`);
    }
  }
}

// ---------------------------------------------------------------
// UI
// ---------------------------------------------------------------
const mainView = document.getElementById('mainView');
const settingsView = document.getElementById('settingsView');
const settingsBtn = document.getElementById('settingsBtn');
const backBtn = document.getElementById('backBtn');
const analyzeBtn = document.getElementById('analyzeBtn');
const statusMsg = document.getElementById('statusMsg');
const resultBox = document.getElementById('resultBox');
const verdictBadge = document.getElementById('verdictBadge');
const analysisText = document.getElementById('analysisText');
const zoneText = document.getElementById('zoneText');
const geminiKeyInput = document.getElementById('geminiKeyInput');
const modelSelect = document.getElementById('modelSelect');
const twelveKeyInput = document.getElementById('twelveKeyInput');
const openrouterKeyInput = document.getElementById('openrouterKeyInput');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const settingsStatus = document.getElementById('settingsStatus');
const instrumentSelect = document.getElementById('instrumentSelect');
const timeframeSelect = document.getElementById('timeframeSelect');
const autoModeToggle = document.getElementById('autoModeToggle');
const intervalSelect = document.getElementById('intervalSelect');
const autoModeHint = document.getElementById('autoModeHint');
const tradePlanBox = document.getElementById('tradePlanBox');
const tpGatillo = document.getElementById('tpGatillo');
const tpEntrada = document.getElementById('tpEntrada');
const tpSL = document.getElementById('tpSL');
const tpTP = document.getElementById('tpTP');
const tpRR = document.getElementById('tpRR');
const historyList = document.getElementById('historyList');

function setStatus(msg, type) {
  statusMsg.textContent = msg;
  statusMsg.className = 'status-msg' + (type ? ' ' + type : '');
}

function showSettings() {
  mainView.classList.add('hidden');
  settingsView.classList.remove('hidden');
}
function showMain() {
  settingsView.classList.add('hidden');
  mainView.classList.remove('hidden');
}

function displayResult(result) {
  verdictBadge.textContent = result.veredicto + (result.direccion !== 'NINGUNA' ? ' — ' + result.direccion : '');
  verdictBadge.className = 'verdict-badge ' + (result.veredicto === 'APTO' ? 'apto' : 'no-apto');
  analysisText.textContent = result.analisis + (result.confianza ? `\n\nConfianza: ${result.confianza}/10` : '');
  zoneText.textContent = result.zona;

  if (result.veredicto === 'APTO' && result.entrada) {
    tpGatillo.textContent = result.gatillo || '—';
    tpEntrada.textContent = result.entrada;
    tpSL.textContent = result.stopLoss || '—';
    tpTP.textContent = result.takeProfit || '—';
    tpRR.textContent = result.rrReal || '—';
    tradePlanBox.classList.remove('hidden');
  } else {
    tradePlanBox.classList.add('hidden');
  }
  resultBox.classList.remove('hidden');
}

function renderHistory() {
  const history = getHistory();
  historyList.innerHTML = '';
  if (history.length === 0) {
    historyList.innerHTML = '<p class="hint">Sin analisis todavia.</p>';
    return;
  }
  history.forEach((h) => {
    const div = document.createElement('div');
    div.className = 'history-item';
    const time = new Date(h.timestamp).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      <div>
        <div class="hist-verdict ${h.veredicto === 'APTO' ? 'apto' : 'no-apto'}">${h.veredicto} ${h.direccion !== 'NINGUNA' ? h.direccion : ''}</div>
        <div class="hist-meta">${h.symbol} · ${time}</div>
      </div>
    `;
    historyList.appendChild(div);
  });
}

// ---------------------------------------------------------------
// NOTIFICACIONES LOCALES
// ---------------------------------------------------------------
async function ensureNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const perm = await Notification.requestPermission();
  return perm === 'granted';
}

function notifyApto(result, symbol) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const detalle = result.entrada
    ? `${result.direccion} | Entrada: ${result.entrada} | SL: ${result.stopLoss} | TP: ${result.takeProfit} (R:R ${result.rrReal})`
    : result.zona;
  new Notification(`SMC Copilot: APTO ${symbol}`, { body: detalle, icon: 'icons/icon192.png' });
}

// ---------------------------------------------------------------
// FLUJO PRINCIPAL DE ANALISIS
// ---------------------------------------------------------------
async function runAnalysis({ silent = false } = {}) {
  const settings = getSettings();
  if (!settings.geminiKey || !settings.twelveKey) {
    if (!silent) setStatus('Configura ambas API keys primero (icono ⚙).', 'error');
    return;
  }

  const symbol = instrumentSelect.value;

  try {
    if (!silent) setStatus('Obteniendo velas de 1H, 15M y 5M...', '');
    // Las 3 temporalidades se piden en paralelo para no triplicar el tiempo de espera
    const [candles1h, candles15m, candles5m] = await Promise.all([
      fetchCandles(symbol, '1h', settings.twelveKey),
      fetchCandles(symbol, '15min', settings.twelveKey),
      fetchCandles(symbol, '5min', settings.twelveKey)
    ]);

    const promptText = buildMultiTimeframeText(symbol, candles1h, candles15m, candles5m);

    if (!silent) setStatus('Analizando 1H (contexto) + 15M (zona) + 5M (gatillo)...', '');
    const { result, usedProvider } = await analyzeWithFallback(
      promptText,
      settings,
      silent ? null : (msg, type) => setStatus(msg, type)
    );

    displayResult(result);
    addToHistory({ ...result, timestamp: Date.now(), symbol });
    renderHistory();

    if (result.veredicto === 'APTO') {
      notifyApto(result, symbol);
    }

    if (!silent) {
      setStatus(
        usedProvider === 'OpenRouter' ? 'Analisis completo (via OpenRouter, respaldo).' : 'Analisis completo.',
        'success'
      );
    }
  } catch (err) {
    if (!silent) setStatus(err.message || 'Error inesperado.', 'error');
    console.log('SMC Copilot error:', err);
  }
}

// ---------------------------------------------------------------
// MODO AUTOMATICO (setInterval mientras la app este abierta)
// ---------------------------------------------------------------
let autoModeTimer = null;

function updateAutoModeHint() {
  autoModeHint.textContent = autoModeToggle.checked
    ? `Activo — analizando ${instrumentSelect.value} cada ${intervalSelect.value} minutos.`
    : 'Apagado. Analiza manualmente con el boton de abajo.';
}

async function startAutoMode() {
  const granted = await ensureNotificationPermission();
  if (!granted) {
    setStatus('Activa las notificaciones para recibir avisos del modo automatico.', 'error');
  }
  if (autoModeTimer) clearInterval(autoModeTimer);
  const minutes = Number(intervalSelect.value);
  autoModeTimer = setInterval(() => runAnalysis({ silent: true }), minutes * 60 * 1000);
  localStorage.setItem('autoModeOn', 'true');
  localStorage.setItem('autoModeInterval', String(minutes));
  runAnalysis({ silent: true }); // primer analisis inmediato
  updateAutoModeHint();
}

function stopAutoMode() {
  if (autoModeTimer) clearInterval(autoModeTimer);
  autoModeTimer = null;
  localStorage.setItem('autoModeOn', 'false');
  updateAutoModeHint();
}

autoModeToggle.addEventListener('change', () => {
  if (autoModeToggle.checked) startAutoMode();
  else stopAutoMode();
});

intervalSelect.addEventListener('change', () => {
  if (autoModeToggle.checked) startAutoMode();
});

instrumentSelect.addEventListener('change', updateAutoModeHint);

// ---------------------------------------------------------------
// EVENTOS GENERALES
// ---------------------------------------------------------------
settingsBtn.addEventListener('click', () => {
  const s = getSettings();
  geminiKeyInput.value = s.geminiKey;
  modelSelect.value = s.model;
  twelveKeyInput.value = s.twelveKey;
  openrouterKeyInput.value = s.openrouterKey;
  showSettings();
});

backBtn.addEventListener('click', showMain);

saveSettingsBtn.addEventListener('click', () => {
  const geminiKey = geminiKeyInput.value.trim();
  const twelveKey = twelveKeyInput.value.trim();
  const openrouterKey = openrouterKeyInput.value.trim();
  if (!geminiKey || !twelveKey) {
    settingsStatus.textContent = 'Completa Gemini y Twelve Data (obligatorias). OpenRouter es opcional.';
    settingsStatus.className = 'status-msg error';
    return;
  }
  saveSettings(geminiKey, modelSelect.value, twelveKey, openrouterKey);
  settingsStatus.textContent = 'Guardado correctamente.';
  settingsStatus.className = 'status-msg success';
  setTimeout(() => { settingsStatus.textContent = ''; showMain(); }, 800);
});

analyzeBtn.addEventListener('click', () => runAnalysis());

// ---------------------------------------------------------------
// INICIALIZACION
// ---------------------------------------------------------------
(async function init() {
  const settings = getSettings();
  if (!settings.geminiKey || !settings.twelveKey) {
    setStatus('Configura tus API keys para empezar (icono ⚙).', '');
  }
  renderHistory();

  if (localStorage.getItem('autoModeOn') === 'true') {
    autoModeToggle.checked = true;
    const savedInterval = localStorage.getItem('autoModeInterval');
    if (savedInterval) intervalSelect.value = savedInterval;
    startAutoMode();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
