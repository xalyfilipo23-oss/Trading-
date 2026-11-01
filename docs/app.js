// app.js
// Logica principal: pide velas OHLC reales a Twelve Data (no screenshots),
// las manda como datos de texto a Gemini con criterio SMC, y muestra el
// veredicto + plan de trade. El Modo Automatico repite esto cada X minutos
// mientras la app este abierta.

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'qwen/qwen3.8-27b:free';
const CLAUDE_BASE = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-5';
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
    openrouterKey: localStorage.getItem('openrouterKey') || '',
    claudeKey: localStorage.getItem('claudeKey') || ''
  };
}

function saveSettings(geminiKey, model, twelveKey, openrouterKey, claudeKey) {
  localStorage.setItem('geminiKey', geminiKey);
  localStorage.setItem('model', model);
  localStorage.setItem('twelveKey', twelveKey);
  localStorage.setItem('openrouterKey', openrouterKey);
  localStorage.setItem('claudeKey', claudeKey);
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem('history') || '[]');
  } catch (e) {
    return [];
  }
}

const HISTORY_MAX = 60; // suficiente para cubrir varios dias de pruebas sin perder registros

function addToHistory(entry) {
  const history = getHistory();
  history.unshift(entry);
  localStorage.setItem('history', JSON.stringify(history.slice(0, HISTORY_MAX)));
}

// ---------------------------------------------------------------
// REGISTRO DE SEÑALES (diario de pruebas, sin cuenta demo)
// Cada señal APTO con plan completo se guarda como una "proyeccion"
// (entrada / SL / TP). Despues la app revisa las velas de 5M que vinieron
// DESPUES de la señal y decide si la proyeccion se cumplio o no.
// Estados: pendiente (esperando que el precio llegue a la entrada),
// activa (entrada tocada, esperando TP o SL), TP, SL,
// invalidada (el precio llego al TP sin tocar la entrada: se fue sin ti),
// no_activada (la entrada nunca se toco), expirada (activa sin resolver).
// ---------------------------------------------------------------
const JOURNAL_KEY = 'journal';
const JOURNAL_MAX = 500;
const FIVE_MIN = 5 * 60 * 1000;
const PENDING_EXPIRE_MS = 2 * 60 * 60 * 1000;  // si en 2h no toca la entrada, no se dio
const ACTIVE_EXPIRE_MS = 12 * 60 * 60 * 1000;  // si en 12h no toca TP ni SL, se cierra al precio de ese momento

function getJournal() {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveJournal(journal) {
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal.slice(0, JOURNAL_MAX)));
}

function isOpenSignal(j) {
  return j.status === 'pendiente' || j.status === 'activa';
}

function addSignalToJournal(result, symbol, provider) {
  if (!result || result.veredicto !== 'APTO') return false;
  const dir = result.direccion;
  if (dir !== 'LONG' && dir !== 'SHORT') return false;
  const entry = parseFloat(result.entrada);
  const sl = parseFloat(result.stopLoss);
  const tp = parseFloat(result.takeProfit);
  if (![entry, sl, tp].every(Number.isFinite)) return false;
  // Un plan incoherente (ej. LONG con SL por encima de la entrada) no se registra
  if (dir === 'LONG' && !(sl < entry && tp > entry)) return false;
  if (dir === 'SHORT' && !(sl > entry && tp < entry)) return false;

  const journal = getJournal();
  // Si ya hay una señal abierta del mismo instrumento y direccion, no la duplicamos:
  // el analisis cada 15 min suele repetir el mismo setup mientras sigue vigente.
  if (journal.some((j) => j.symbol === symbol && j.direccion === dir && isOpenSignal(j))) return false;

  const risk = Math.abs(entry - sl);
  journal.unshift({
    id: Date.now(),
    createdAt: Date.now(),
    symbol,
    direccion: dir,
    entry,
    sl,
    tp,
    rrPlan: Math.abs(tp - entry) / risk,
    zona: result.zona || '',
    gatillo: result.gatillo || '',
    confianza: result.confianza || null,
    provider: provider || '',
    status: 'pendiente',
    activatedAt: null,
    closedAt: null,
    resultR: null,
    ambigua: false
  });
  saveJournal(journal);
  return true;
}

function parseCandleTime(dt) {
  // Twelve Data devuelve 'YYYY-MM-DD HH:mm:ss'; lo pedimos en UTC
  return Date.parse(String(dt).replace(' ', 'T') + 'Z');
}

// Evalua UNA señal con las velas de 5M (orden cronologico). Modifica j en sitio.
// Reglas conservadoras: si en la misma vela se tocan SL y TP, se cuenta como SL
// (y se marca "ambigua"), porque con velas de 5M no se sabe cual fue primero.
function evaluateSignal(j, candles) {
  const long = j.direccion === 'LONG';
  const risk = Math.abs(j.entry - j.sl);
  const startMs = (Math.floor(j.createdAt / FIVE_MIN) + 1) * FIVE_MIN; // primera vela completa DESPUES de la señal
  let prevClose = null;

  const close = (status, t, resultR) => {
    j.status = status;
    j.closedAt = t;
    j.resultR = resultR;
  };

  for (const c of candles) {
    if (!isOpenSignal(j)) break;
    const t = parseCandleTime(c.datetime);
    if (!Number.isFinite(t) || t < startMs) continue;
    const high = parseFloat(c.high);
    const low = parseFloat(c.low);
    const cl = parseFloat(c.close);
    if (![high, low, cl].every(Number.isFinite)) continue;
    const hitSL = long ? low <= j.sl : high >= j.sl;
    const hitTP = long ? high >= j.tp : low <= j.tp;

    if (j.status === 'pendiente') {
      if (t - j.createdAt > PENDING_EXPIRE_MS) { close('no_activada', t, null); break; }
      const touched = long ? low <= j.entry : high >= j.entry;
      if (touched) {
        j.status = 'activa';
        j.activatedAt = t;
        // Misma vela de activacion: SL manda (conservador); TP cuenta pero queda marcado como ambiguo
        if (hitSL) { j.ambigua = true; close('SL', t + FIVE_MIN, -1); }
        else if (hitTP) { j.ambigua = true; close('TP', t + FIVE_MIN, j.rrPlan); }
      } else if (hitTP) {
        close('invalidada', t + FIVE_MIN, null); // llego al TP sin darte la entrada
      }
    } else if (j.status === 'activa') {
      if (t - j.activatedAt > ACTIVE_EXPIRE_MS) {
        const ref = prevClose !== null ? prevClose : j.entry;
        close('expirada', t, (long ? ref - j.entry : j.entry - ref) / risk);
        break;
      }
      if (hitSL) { j.ambigua = hitTP; close('SL', t + FIVE_MIN, -1); }
      else if (hitTP) { close('TP', t + FIVE_MIN, j.rrPlan); }
    }
    prevClose = cl;
  }
}

// Pide 5M suficientes para cubrir desde la señal abierta mas vieja hasta ahora
async function fetchCandlesSince(symbol, sinceMs, apiKey) {
  const startMs = (Math.floor(sinceMs / FIVE_MIN) + 1) * FIVE_MIN;
  const count = Math.min(5000, Math.ceil((Date.now() - startMs) / FIVE_MIN) + 5);
  const url = `${TWELVEDATA_BASE}?symbol=${encodeURIComponent(symbol)}&interval=5min&outputsize=${Math.max(count, 10)}&timezone=UTC&apikey=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.status === 'error' || !data.values) {
    throw new Error('Error de Twelve Data: ' + (data.message || 'No se recibieron velas.'));
  }
  return data.values.slice().reverse();
}

let evaluatingSignals = false;

async function evaluateOpenSignals({ silent = true } = {}) {
  if (evaluatingSignals) return;
  const settings = getSettings();
  if (!settings.twelveKey) return;
  const openNow = getJournal().filter(isOpenSignal);
  if (openNow.length === 0) return;

  evaluatingSignals = true;
  try {
    const symbols = [...new Set(openNow.map((j) => j.symbol))];
    const candlesBySymbol = {};
    for (const s of symbols) {
      const oldest = Math.min(...openNow.filter((j) => j.symbol === s).map((j) => j.createdAt));
      candlesBySymbol[s] = await fetchCandlesSince(s, oldest, settings.twelveKey);
    }
    // Releemos el registro DESPUES de las peticiones, por si se agrego una señal mientras esperabamos
    const journal = getJournal();
    journal.filter(isOpenSignal).forEach((j) => {
      if (candlesBySymbol[j.symbol]) evaluateSignal(j, candlesBySymbol[j.symbol]);
    });
    saveJournal(journal);
    renderJournal();
    if (!silent) setStatus('Registro actualizado.', 'success');
  } catch (err) {
    if (!silent) setStatus(err.message || 'No se pudo actualizar el registro.', 'error');
    console.log('SMC Copilot evaluacion error:', err);
  } finally {
    evaluatingSignals = false;
  }
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
// ANALISIS CON CLAUDE (Anthropic) — proveedor principal de pago
// ---------------------------------------------------------------
async function analyzeCandlesClaude(promptText, apiKey) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: promptText }]
  };

  const response = await fetch(CLAUDE_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Necesario para poder llamar la API de Anthropic directo desde el navegador
      // (sin esto, el navegador bloquea la peticion por CORS).
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Error de Claude (${response.status}): ${errText || response.statusText}`);
  }

  const data = await response.json();
  const rawContent = data?.content?.[0]?.text;
  if (!rawContent) {
    throw new Error('Claude no devolvio contenido.');
  }

  return parseModelJson(rawContent);
}

// ---------------------------------------------------------------
// PARSEO COMPARTIDO DE LA RESPUESTA JSON (Claude, Gemini u OpenRouter)
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
// ANALISIS CON FALLBACK AUTOMATICO EN CADENA
// Orden: Claude (si tienes clave de pago configurada) -> Gemini -> OpenRouter.
// Claude va primero porque es el proveedor de pago, mucho menos propenso a
// los errores de "alta demanda" que dan los niveles gratis de Gemini/OpenRouter.
// Si Claude falla o no tienes clave, sigue probando los siguientes en la lista.
// ---------------------------------------------------------------
async function analyzeWithFallback(promptText, settings, statusFn) {
  const providers = [];
  if (settings.claudeKey) {
    providers.push({ name: 'Claude', run: () => analyzeCandlesClaude(promptText, settings.claudeKey) });
  }
  providers.push({ name: 'Gemini', run: () => analyzeCandles(promptText, settings.geminiKey, settings.model) });
  if (settings.openrouterKey) {
    providers.push({ name: 'OpenRouter', run: () => analyzeCandlesOpenRouter(promptText, settings.openrouterKey) });
  }

  const errores = [];
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      if (i > 0 && statusFn) statusFn(`Reintentando con ${provider.name}...`, '');
      const result = await provider.run();
      return { result, usedProvider: provider.name };
    } catch (err) {
      console.log(`SMC Copilot: ${provider.name} fallo`, err);
      errores.push(`${provider.name} fallo (${err.message})`);
    }
  }

  throw new Error(errores.join(' — '));
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
const claudeKeyInput = document.getElementById('claudeKeyInput');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const settingsStatus = document.getElementById('settingsStatus');
const instrumentSelect = document.getElementById('instrumentSelect');
const timeframeSelect = document.getElementById('timeframeSelect');
const autoModeToggle = document.getElementById('autoModeToggle');
const intervalSelect = document.getElementById('intervalSelect');
const activeHoursToggle = document.getElementById('activeHoursToggle');
const activeHoursFields = document.getElementById('activeHoursFields');
const scheduleTz = document.getElementById('scheduleTz');
const windowsList = document.getElementById('windowsList');
const addWindowBtn = document.getElementById('addWindowBtn');
const scheduleNow = document.getElementById('scheduleNow');
const journalSummary = document.getElementById('journalSummary');
const journalList = document.getElementById('journalList');
const refreshJournalBtn = document.getElementById('refreshJournalBtn');
const exportJournalBtn = document.getElementById('exportJournalBtn');
const clearJournalBtn = document.getElementById('clearJournalBtn');
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
    const fecha = new Date(h.timestamp);
    const fechaStr = fecha.toLocaleDateString('es', { day: '2-digit', month: '2-digit' });
    const horaStr = fecha.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const esApto = h.veredicto === 'APTO';

    // Para las entradas APTO con plan de trade, guardamos el detalle completo
    // (entrada/SL/TP/zona) para poder revisarlo despues en TradingView y ver
    // si hubiera sido una entrada valida, aunque no la hayas alcanzado a operar.
    const planHtml = (esApto && h.entrada)
      ? `
        <div class="hist-plan">
          <div class="hist-plan-row"><span>Zona</span><span>${h.zona || '-'}</span></div>
          <div class="hist-plan-row"><span>Gatillo</span><span>${h.gatillo || '-'}</span></div>
          <div class="hist-plan-row"><span>Entrada</span><span>${h.entrada}</span></div>
          <div class="hist-plan-row"><span>Stop Loss</span><span>${h.stopLoss || '-'}</span></div>
          <div class="hist-plan-row"><span>Take Profit</span><span>${h.takeProfit || '-'}</span></div>
          <div class="hist-plan-row"><span>R:R</span><span>${h.rrReal || '-'}</span></div>
        </div>
      `
      : '';

    div.innerHTML = `
      <div class="hist-top">
        <div class="hist-verdict ${esApto ? 'apto' : 'no-apto'}">${h.veredicto} ${h.direccion !== 'NINGUNA' ? h.direccion : ''}</div>
        <div class="hist-meta">${h.symbol} · ${fechaStr} ${horaStr}</div>
      </div>
      ${planHtml}
    `;
    historyList.appendChild(div);
  });
}

// ---------------------------------------------------------------
// VISTA DEL REGISTRO
// ---------------------------------------------------------------
const STATUS_LABEL = {
  pendiente: 'Pendiente',
  activa: 'Activa',
  TP: 'TP cumplido',
  SL: 'SL tocado',
  invalidada: 'Se fue sin entrada',
  no_activada: 'Entrada no se dio',
  expirada: 'Expirada'
};
const STATUS_CLASS = {
  pendiente: 'st-open', activa: 'st-open', TP: 'st-win', SL: 'st-loss',
  invalidada: 'st-neutral', no_activada: 'st-neutral', expirada: 'st-neutral'
};

function fmtPrice(n) {
  return Number.isFinite(n) ? String(Math.round(n * 100000) / 100000) : '-';
}

function fmtR(r) {
  if (r === null || r === undefined) return '';
  return (r > 0 ? '+' : '') + (Math.round(r * 100) / 100) + 'R';
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderJournal() {
  const journal = getJournal();
  journalSummary.innerHTML = '';
  journalList.innerHTML = '';

  if (journal.length === 0) {
    journalList.appendChild(el('p', 'hint', 'Aun no hay señales registradas. Se guardan solas cuando el bot marca APTO con plan completo.'));
    return;
  }

  const wins = journal.filter((j) => j.status === 'TP').length;
  const losses = journal.filter((j) => j.status === 'SL').length;
  const resolved = wins + losses;
  const open = journal.filter(isOpenSignal).length;
  const missed = journal.filter((j) => j.status === 'invalidada' || j.status === 'no_activada').length;
  const netR = journal.reduce((acc, j) => acc + ((j.status === 'TP' || j.status === 'SL' || j.status === 'expirada') && j.resultR !== null ? j.resultR : 0), 0);
  const winrate = resolved > 0 ? Math.round((wins / resolved) * 100) + '%' : '-';

  const stats = [
    ['Señales', journal.length],
    ['TP / SL', `${wins} / ${losses}`],
    ['Acierto', winrate],
    ['R neto', fmtR(netR) || '0R'],
    ['Abiertas', open],
    ['Sin entrada', missed]
  ];
  stats.forEach(([label, value]) => {
    const box = el('div', 'stat');
    box.appendChild(el('div', 'stat-value', String(value)));
    box.appendChild(el('div', 'stat-label', label));
    journalSummary.appendChild(box);
  });

  journal.slice(0, 40).forEach((j) => {
    const item = el('div', 'journal-item');
    const top = el('div', 'hist-top');
    const left = el('div', 'hist-verdict ' + (j.direccion === 'LONG' ? 'apto' : 'no-apto'), `${j.direccion} ${j.symbol}`);
    const badge = el('span', 'status-badge ' + (STATUS_CLASS[j.status] || ''), STATUS_LABEL[j.status] || j.status);
    top.appendChild(left);
    top.appendChild(badge);
    item.appendChild(top);

    const fecha = new Date(j.createdAt);
    const fechaStr = fecha.toLocaleDateString('es', { day: '2-digit', month: '2-digit' }) + ' ' +
      fecha.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    item.appendChild(el('div', 'hist-meta', `${fechaStr} · ${j.provider || ''}`.trim()));

    const plan = el('div', 'hist-plan');
    [
      ['Entrada', fmtPrice(j.entry)],
      ['Stop Loss', fmtPrice(j.sl)],
      ['Take Profit', fmtPrice(j.tp)],
      ['R:R plan', Math.round(j.rrPlan * 10) / 10 + ':1']
    ].forEach(([k, v]) => {
      const row = el('div', 'hist-plan-row');
      row.appendChild(el('span', '', k));
      row.appendChild(el('span', '', v));
      plan.appendChild(row);
    });
    if (j.resultR !== null && j.resultR !== undefined) {
      const row = el('div', 'hist-plan-row');
      row.appendChild(el('span', '', 'Resultado'));
      row.appendChild(el('span', '', fmtR(j.resultR) + (j.ambigua ? ' (ambigua)' : '')));
      plan.appendChild(row);
    }
    if (j.zona) {
      const row = el('div', 'hist-plan-row');
      row.appendChild(el('span', '', 'Zona'));
      row.appendChild(el('span', '', j.zona));
      plan.appendChild(row);
    }
    item.appendChild(plan);
    journalList.appendChild(item);
  });
}

function exportJournalCsv() {
  const journal = getJournal();
  if (journal.length === 0) {
    setStatus('No hay señales para exportar todavia.', 'error');
    return;
  }
  const head = ['fecha_local', 'instrumento', 'direccion', 'entrada', 'sl', 'tp', 'rr_plan', 'estado', 'resultado_R', 'ambigua', 'confianza', 'proveedor', 'zona', 'gatillo'];
  const q = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
  const rows = journal.map((j) => [
    new Date(j.createdAt).toLocaleString('es'), j.symbol, j.direccion, j.entry, j.sl, j.tp,
    Math.round(j.rrPlan * 100) / 100, j.status, j.resultR === null ? '' : Math.round(j.resultR * 100) / 100,
    j.ambigua ? 'si' : 'no', j.confianza, j.provider, j.zona, j.gatillo
  ].map(q).join(','));
  const csv = '﻿' + [head.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'registro-senales-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

refreshJournalBtn.addEventListener('click', async () => {
  setStatus('Revisando resultados de las señales abiertas...', '');
  await evaluateOpenSignals({ silent: false });
});
exportJournalBtn.addEventListener('click', exportJournalCsv);
clearJournalBtn.addEventListener('click', () => {
  if (confirm('¿Borrar TODO el registro de señales? No se puede deshacer. Exporta el CSV antes si lo quieres guardar.')) {
    saveJournal([]);
    renderJournal();
  }
});

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
    if (addSignalToJournal(result, symbol, usedProvider)) renderJournal();

    if (result.veredicto === 'APTO') {
      notifyApto(result, symbol);
    }

    // Siempre limpiamos/actualizamos el estado (incluso en corridas silenciosas del
    // modo automatico) para que un exito posterior borre un error viejo que haya
    // quedado pegado en pantalla de un intento manual anterior que fallo.
    const hora = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const esProveedorPrincipal = usedProvider === 'Claude' || (usedProvider === 'Gemini' && !settings.claudeKey);
    setStatus(
      esProveedorPrincipal ? `Analisis completo — ${hora}` : `Analisis completo (via ${usedProvider}, respaldo) — ${hora}`,
      'success'
    );
  } catch (err) {
    if (!silent) setStatus(err.message || 'Error inesperado.', 'error');
    console.log('SMC Copilot error:', err);
  } finally {
    // Siempre revisamos si alguna señal abierta ya llego a su TP o SL (1 credito de Twelve Data por instrumento)
    evaluateOpenSignals();
  }
}

// ---------------------------------------------------------------
// MODO AUTOMATICO (setInterval mientras la app este abierta)
// ---------------------------------------------------------------
let autoModeTimer = null;

// ---------------------------------------------------------------
// HORARIOS PROGRAMADOS: una o varias ventanas (Desde/Hasta) en la zona
// horaria elegida (por defecto Nueva York, donde se mueve el mercado).
// Fuera de ellas el Modo Automatico NO analiza (no gasta creditos) y se
// reanuda solo. Ademas, no analiza con el mercado de Forex cerrado.
// ---------------------------------------------------------------
const DEFAULT_SCHEDULE = {
  on: false,
  tz: 'America/New_York',
  windows: [
    { start: '09:00', end: '11:00' },
    { start: '16:00', end: '17:00' }
  ]
};

const TZ_NAMES = {
  'America/New_York': 'Nueva York',
  'Asia/Tokyo': 'Tokio',
  'Europe/London': 'Londres',
  local: 'tu hora'
};

function getSchedule() {
  try {
    const s = JSON.parse(localStorage.getItem('schedule') || 'null');
    if (s && Array.isArray(s.windows)) return s;
  } catch (e) { /* usamos el valor por defecto */ }
  return JSON.parse(JSON.stringify(DEFAULT_SCHEDULE));
}

let schedule = getSchedule();

function saveSchedule() {
  localStorage.setItem('schedule', JSON.stringify(schedule));
}

// Hora/minuto/dia de la semana "ahora" en una zona horaria
function nowIn(tz) {
  const d = new Date();
  if (tz === 'local') {
    return { minutes: d.getHours() * 60 + d.getMinutes(), weekday: d.getDay() };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type).value;
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')), weekday: days[get('weekday')] };
}

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Forex/Oro cierran desde el viernes ~17:00 hasta el domingo ~17:00 (hora de Nueva York)
function isMarketOpen() {
  const ny = nowIn('America/New_York');
  if (ny.weekday === 6) return false;
  if (ny.weekday === 5 && ny.minutes >= 17 * 60) return false;
  if (ny.weekday === 0 && ny.minutes < 17 * 60) return false;
  return true;
}

function isWithinActiveHours() {
  if (!schedule.on) return true; // sin horario = siempre activo
  if (schedule.windows.length === 0) return false;
  const { minutes } = nowIn(schedule.tz);
  return schedule.windows.some((w) => {
    const start = timeToMinutes(w.start);
    const end = timeToMinutes(w.end);
    if (start <= end) return minutes >= start && minutes <= end;
    return minutes >= start || minutes <= end; // cruza medianoche
  });
}

function shouldAnalyzeNow() {
  return isMarketOpen() && isWithinActiveHours();
}

function renderScheduleUI() {
  activeHoursToggle.checked = schedule.on;
  activeHoursFields.classList.toggle('hidden', !schedule.on);
  scheduleTz.value = schedule.tz;
  windowsList.innerHTML = '';
  schedule.windows.forEach((w, i) => {
    const row = el('div', 'window-row');
    const start = document.createElement('input');
    start.type = 'time'; start.value = w.start; start.dataset.i = i; start.dataset.field = 'start';
    const sep = el('span', '', 'a');
    const end = document.createElement('input');
    end.type = 'time'; end.value = w.end; end.dataset.i = i; end.dataset.field = 'end';
    const del = el('button', 'icon-btn small', '✕');
    del.type = 'button'; del.dataset.del = i; del.title = 'Quitar horario';
    row.append(start, sep, end, del);
    windowsList.appendChild(row);
  });
  const ny = nowIn('America/New_York');
  const hh = String(Math.floor(ny.minutes / 60)).padStart(2, '0');
  const mm = String(ny.minutes % 60).padStart(2, '0');
  scheduleNow.textContent = `Ahora en Nueva York son las ${hh}:${mm}. ` +
    (isMarketOpen() ? '' : 'El mercado de Forex esta cerrado (fin de semana): no se analiza. ');
}

function updateAutoModeHint() {
  renderScheduleUI();
  if (!autoModeToggle.checked) {
    autoModeHint.textContent = 'Apagado. Analiza manualmente con el boton de abajo.';
    return;
  }
  const base = `Activo — analizando ${instrumentSelect.value} cada ${intervalSelect.value} minutos.`;
  if (!isMarketOpen()) {
    autoModeHint.textContent = `${base} Mercado cerrado ahora: en pausa hasta que abra.`;
  } else if (schedule.on) {
    const rangos = schedule.windows.map((w) => `${w.start}-${w.end}`).join(' y ') || '(sin horarios)';
    const zona = TZ_NAMES[schedule.tz] || schedule.tz;
    autoModeHint.textContent = isWithinActiveHours()
      ? `${base} Horarios (${zona}): ${rangos}. Dentro del horario ahora.`
      : `${base} Horarios (${zona}): ${rangos}. Fuera de horario: en pausa hasta que entre en rango.`;
  } else {
    autoModeHint.textContent = base;
  }
}

async function startAutoMode() {
  const granted = await ensureNotificationPermission();
  if (!granted) {
    setStatus('Activa las notificaciones para recibir avisos del modo automatico.', 'error');
  }
  if (autoModeTimer) clearInterval(autoModeTimer);
  const minutes = Number(intervalSelect.value);
  autoModeTimer = setInterval(() => {
    if (shouldAnalyzeNow()) {
      runAnalysis({ silent: true });
    } else {
      // Aunque no toque analizar, igual revisamos si alguna señal abierta ya se resolvio
      evaluateOpenSignals();
    }
    updateAutoModeHint(); // refresca el texto por si acaba de entrar/salir del rango
  }, minutes * 60 * 1000);
  localStorage.setItem('autoModeOn', 'true');
  localStorage.setItem('autoModeInterval', String(minutes));
  if (shouldAnalyzeNow()) {
    runAnalysis({ silent: true }); // primer analisis inmediato, solo si ya estamos en horario
  }
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

activeHoursToggle.addEventListener('change', () => {
  schedule.on = activeHoursToggle.checked;
  saveSchedule();
  updateAutoModeHint();
});

scheduleTz.addEventListener('change', () => {
  schedule.tz = scheduleTz.value;
  saveSchedule();
  updateAutoModeHint();
});

windowsList.addEventListener('change', (e) => {
  const i = Number(e.target.dataset.i);
  const field = e.target.dataset.field;
  if (!Number.isInteger(i) || !field || !schedule.windows[i] || !e.target.value) return;
  schedule.windows[i][field] = e.target.value;
  saveSchedule();
  updateAutoModeHint();
});

windowsList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-del]');
  if (!btn) return;
  schedule.windows.splice(Number(btn.dataset.del), 1);
  saveSchedule();
  updateAutoModeHint();
});

function addWindow(start, end) {
  if (schedule.windows.length >= 5) return;
  schedule.windows.push({ start, end });
  saveSchedule();
  updateAutoModeHint();
}

addWindowBtn.addEventListener('click', () => addWindow('09:00', '11:00'));

// Atajos: ventanas clasicas de actividad, expresadas en hora de Nueva York
document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    schedule.tz = 'America/New_York';
    schedule.on = true;
    addWindow(btn.dataset.start, btn.dataset.end);
  });
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
  claudeKeyInput.value = s.claudeKey;
  showSettings();
});

backBtn.addEventListener('click', showMain);

saveSettingsBtn.addEventListener('click', () => {
  const geminiKey = geminiKeyInput.value.trim();
  const twelveKey = twelveKeyInput.value.trim();
  const openrouterKey = openrouterKeyInput.value.trim();
  const claudeKey = claudeKeyInput.value.trim();
  if (!geminiKey || !twelveKey) {
    settingsStatus.textContent = 'Completa Gemini y Twelve Data (obligatorias). Claude y OpenRouter son opcionales.';
    settingsStatus.className = 'status-msg error';
    return;
  }
  saveSettings(geminiKey, modelSelect.value, twelveKey, openrouterKey, claudeKey);
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

  // Migracion: si antes tenias un unico horario guardado (hora de tu dispositivo),
  // lo convertimos al nuevo formato de ventanas.
  if (!localStorage.getItem('schedule') && localStorage.getItem('activeHoursOn') === 'true') {
    schedule = {
      on: true,
      tz: 'local',
      windows: [{
        start: localStorage.getItem('activeStart') || '08:00',
        end: localStorage.getItem('activeEnd') || '12:00'
      }]
    };
    saveSchedule();
  }
  renderScheduleUI();
  renderJournal();

  if (localStorage.getItem('autoModeOn') === 'true') {
    autoModeToggle.checked = true;
    const savedInterval = localStorage.getItem('autoModeInterval');
    if (savedInterval) intervalSelect.value = savedInterval;
    startAutoMode();
  } else {
    updateAutoModeHint();
  }

  // Al abrir la app, ponemos al dia las señales que quedaron abiertas mientras estaba cerrada
  evaluateOpenSignals();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
