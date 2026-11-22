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
const OPENAI_BASE = 'https://api.openai.com/v1/chat/completions';
const TWELVEDATA_BASE = 'https://api.twelvedata.com/time_series';

// ---------------------------------------------------------------
// PROMPT DEL SISTEMA (adaptado para datos numericos, no imagen)
// ---------------------------------------------------------------
// Marcos de tiempo del analisis (3 capas: macro -> medio -> gatillo).
// 'scalp': macro 15M / zona 5M / gatillo 1M (para mas operaciones al dia).
// 'intra': macro 1H / zona 15M / gatillo 5M (el esquema original).
// evalInterval: con que velas se evalua despues si la señal llego a TP o SL.
const TF_MODES = {
  scalp: { label: 'Scalping: 15M (macro) → 5M (zona) → 1M (gatillo)', macro: '15M', mid: '5M', trig: '1M', evalInterval: '1min' },
  intra: { label: 'Intradia: 1H (macro) → 15M (zona) → 5M (gatillo)', macro: '1H', mid: '15M', trig: '5M', evalInterval: '5min' }
};

function getTfMode() {
  const m = localStorage.getItem('tfMode');
  return TF_MODES[m] ? m : 'scalp';
}

function buildSystemPrompt(L) {
  const M = L.macro, E = L.mid, G = L.trig;
  return `Eres un analista de trading intradiario experto en Smart Money Concepts (SMC). Analizas velas OHLC reales (datos numericos exactos, no una imagen) de un instrumento de Forex u Oro, para operaciones rapidas en temporalidades bajas (scalping / intradia). Tu tarea es decidir si existe AHORA una entrada valida segun el METODO DEL USUARIO, descrito abajo con precision. Se estricto y honesto: la mayoria de los momentos NO son una entrada valida.

DATOS QUE RECIBES
- VELAS ${M} (contexto macro), VELAS ${E} (movimiento y order block) y VELAS ${G} (confirmacion / gatillo), del MISMO instrumento, en orden cronologico (la ultima es la mas reciente).
- Una seccion NIVELES CALCULADOS POR CODIGO: swings, FVG sin rellenar, order blocks candidatos, maximo/minimo del dia previo y de los ultimos dias, rangos de Asia y Londres, ATR, sesion y dia de la semana (hora de Nueva York). Son datos objetivos calculados con reglas fijas: usalos para ubicar zonas, liquidez (maximos/minimos que el precio podria barrer) y el tamano realista de SL/TP segun el ATR. Los order blocks de esa lista son solo candidatos por una regla simple: tu decides si son validos segun el metodo. Si las velas contradicen un nivel calculado, confia en las velas.

EL METODO (top-down: ${M} -> ${E} -> ${G})
El usuario opera CAMBIOS DE TENDENCIA (reversiones) que nacen en una zona macro importante: compra desde zonas de demanda tras barrer liquidez de minimos, y vende desde zonas de oferta tras barrer liquidez de maximos. La direccion del trade la define la reaccion en la zona, no una tendencia previa.

PASO 1 - ZONA MACRO EN ${M}
Busca un nivel horizontal de precio (un maximo o un minimo) que el precio haya TESTEADO varias veces (2 o mas toques o rechazos) sin romperlo con claridad: es una zona con liquidez y un order block macro valido. Tambien cuenta cuando hay varios picos o minimos alineados en la misma zona que ninguno ha atravesado. Si el precio actual no esta en o cerca de una zona asi, no hay operacion.

PASO 2 - ORDER BLOCK EN ${E}
Dentro o junto a la zona de ${M}, el order block de ${E} es la ULTIMA vela contraria (bajista para compras, alcista para ventas) justo antes de un movimiento fuerte e impulsivo. Es VALIDO solo si:
- el movimiento posterior fue fuerte y decidido: una o muy pocas velas grandes con cuerpo dominante, sin mucha resistencia (un movimiento "de una");
- es la ultima vela contraria antes de ese movimiento (no una anterior);
- hay liquidez cerca (maximos o minimos iguales, swings cercanos) y el precio todavia no ha vuelto a mitigarlo.
Es INVALIDO si el movimiento fue gradual: una "escalera" con muchas velas del mismo color, pausas y reanudaciones, poca decision. Es normal que el precio regrese a esa zona; ahi se espera la reaccion.

PASO 3 - GATILLO Y CONFIRMACION EN ${G}
Con el precio en la zona (${M} / ${E}) debe haber ocurrido en ${G}, en este orden:
(a) una barrida de liquidez: el precio rompe un minimo (o maximo) reciente y lo recupera, y
(b) la CONFIRMACION: una vela de ${G} cierra CON CUERPO (cuerpo de al menos 50% del rango; no una vela de pura mecha) mas alla del ultimo extremo relevante, en la direccion del trade (compras: cierra por encima del ultimo maximo; ventas: por debajo del ultimo minimo), idealmente con un desplazamiento fuerte que deje un FVG a favor. Es un CHoCH confirmado por cierre.
El usuario entra A MERCADO en la vela siguiente a esa confirmacion: la entrada es aproximadamente el cierre de la vela de confirmacion.
Sin barrida y confirmacion por cierre NO hay entrada. Si el contexto es valido y la barrida ya ocurrio (o esta ocurriendo) pero la vela de confirmacion todavia no cierra, el veredicto es NO APTO pero activa "seguimiento" (ver abajo).

PATRONES DE LLEGADA A LA ZONA (la seccion NIVELES CALCULADOS trae el patron medido por codigo; usalo)
- DIFICULTAD: el precio llega al nivel que necesita romper con velas pequeñas y lentas, con muchas mechas de rechazo. Segun el usuario es toma de liquidez: la ruptura aparente suele fallar y el movimiento real es el CONTRARIO. No entres en la direccion de esa ruptura.
- ZONA EN PRUEBA: velas casi enteras (casi sin mecha) tocan la zona, la cruzan poco y vuelven, varias veces. Es un amague para que la gente tome el lado equivocado; despues suele venir una vela grande con mecha enorme que barre el nivel, cierra de vuelta y el precio se va al lado contrario. Mientras solo haya toques NO hay entrada; la señal es el barrido final con cierre de vuelta + la confirmacion.
- BARRIDO: ya hubo una vela con mecha larga que paso la zona y cerro de vuelta: busca la vela de confirmacion.
- LIMPIO: sin señales de trampa.
Son hipotesis del usuario basadas en su experiencia: aplicalas, pero juzga con las velas.

PASO 4 - PLAN DE TRADE (solo si hay APTO)
- Entrada: a mercado, en el cierre de la vela de confirmacion de ${G} (tipoEntrada = "mercado"). Si la vela de confirmacion es enorme (rango mayor a unas 2.5 veces el ATR de ${G}), no persigas: NO APTO.
- Stop loss: mas alla del ultimo extremo: debajo del ultimo minimo (el de la barrida) para compras, encima del ultimo maximo para ventas, en un precio que el mercado aun no ha alcanzado, con un pequeno margen para que no lo toque una mecha normal (referencia: 0.1 a 0.25 ATR de ${E}). Si no hay un ultimo extremo claro, ponlo mas alla del order block.
- Take profit: el FVG o el order block opuesto mas cercano en la direccion del trade (primera meta). Relacion riesgo:beneficio MINIMA de 1:2 calculada desde la entrada a mercado (lo ideal es de 1:2 a 1:3). Si la primera meta no da 1:2, usa la siguiente meta alcanzable; si ninguna alcanzable da al menos 1:2, NO APTO. Nunca propongas 1:1. Menciona las metas siguientes.

CRITERIOS: CRITICOS Y DESEABLES (no dejes pasar una buena entrada por exigir la perfeccion)
- CRITICOS (si falta alguno: NO APTO): zona macro testeada; barrida de liquidez + confirmacion por cierre con cuerpo; SL logico mas alla del extremo; R:R de al menos 1:2; el mercado NO esta en acumulacion; el patron de llegada no es DIFICULTAD / ZONA EN PRUEBA sin barrido final.
- DESEABLES (restan calidad pero NO bloquean): FVG dejado por el desplazamiento; order block perfecto en ${E}; buena sesion/horario; confluencia extra (liquidez del dia o de sesion barrida); meta de TP clara en un FVG/OB.
- Calidad "A": criticos + todos o casi todos los deseables. Calidad "B": criticos cumplidos pero faltan 1 o 2 deseables. Una B ES una buena entrada: marcala APTO, y en "faltantes" di exactamente que le falta. Si hay duda de que cumpla los CRITICOS, entonces es NO APTO.

SEGUIMIENTO (cuando falta solo la confirmacion)
Si zona, barrida/contexto son validos pero la vela de confirmacion aun no cerro: veredicto NO APTO y "seguimiento": {"activar": true, "direccion": "LONG" o "SHORT", "nivel": precio que la vela de ${G} debe CERRAR mas alla (con cuerpo), "condicion": frase breve}. El codigo vigilara ${G} y te volvera a llamar cuando ocurra. Si no aplica, "seguimiento": null.

CUANDO NO OPERAR (NO APTO)
- Mercado en ACUMULACION o rango sin direccion clara: precio comprimido, velas pequeñas, sin desplazamientos, swings sin progresion. Segun el usuario esto es habitual el lunes, el martes y el miercoles hasta la tarde; los movimientos direccionales (distribucion) suelen empezar el miercoles por la tarde, hora de Nueva York. El mensaje del usuario indica la exigencia del dia.
- No hay zona macro valida, order block valido o gatillo completo.
- La relacion riesgo:beneficio posible es menor a 1:2.
- El precio esta lejos de la zona, o el setup ya se invalido, o los datos son insuficientes o contradictorios.

Responde EXCLUSIVAMENTE en el siguiente formato JSON, sin texto adicional antes ni despues, sin bloques de markdown. Si el veredicto es NO APTO, deja gatillo, entrada, stopLoss, takeProfit, rrReal, tipoEntrada y faltantes como null.

{
  "veredicto": "APTO" o "NO APTO",
  "direccion": "LONG", "SHORT", o "NINGUNA",
  "confianza": numero del 1 al 10,
  "calidad": "A", "B", o null si es NO APTO,
  "patron": "limpio", "dificultad", "zona_en_prueba" o "barrido" (el patron de llegada que observas),
  "analisis": "Explicacion breve (4-6 frases): la zona macro de ${M}, el order block de ${E} y si es valido, el patron de llegada, si hubo barrida y confirmacion en ${G}, si el mercado parece en acumulacion, y por que llegas a este veredicto.",
  "zona": "Descripcion breve de la zona (${M} / ${E}) con precios.",
  "gatillo": "la condicion exacta que confirmo la entrada (barrida + cierre con cuerpo, con precios) o null",
  "tipoEntrada": "mercado" o null,
  "entrada": "numero (string) o null",
  "stopLoss": "numero (string) o null",
  "takeProfit": "numero (string) o null",
  "rrReal": "string (ej. 2.5:1) o null",
  "faltantes": "string con los criterios deseables que faltan (calidad B) o null",
  "seguimiento": null o {"activar": true, "direccion": "LONG"/"SHORT", "nivel": "numero (string)", "condicion": "string"}
}`;
}

function getSystemPrompt() {
  return buildSystemPrompt(TF_MODES[getTfMode()]);
}


// ---------------------------------------------------------------
// ALMACENAMIENTO (localStorage, funciona igual en cualquier navegador)
// ---------------------------------------------------------------
function getSettings() {
  return {
    geminiKey: localStorage.getItem('geminiKey') || '',
    model: localStorage.getItem('model') || 'gemini-3.6-flash',
    twelveKey: localStorage.getItem('twelveKey') || '',
    openrouterKey: localStorage.getItem('openrouterKey') || '',
    claudeKey: localStorage.getItem('claudeKey') || '',
    openaiKey: localStorage.getItem('openaiKey') || '',
    openaiModel: localStorage.getItem('openaiModel') || 'gpt-6.1-sol',
    consensusOn: localStorage.getItem('consensusOn') === 'true'
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

function addSignalToJournal(result, symbol, provider, windowKey = null, flexible = false, evalInterval = '5min', extra = {}) {
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
    calidad: result.calidad || (flexible ? 'B' : 'A'),
    consenso: result.consenso || '',
    evalInterval,
    dayKey: (typeof getDayKey === 'function') ? getDayKey() : null,
    tfMode: (typeof getTfMode === 'function') ? getTfMode() : '',
    windowKey,
    provider: provider || '',
    patron: result.patron || extra.patron || '',
    tipoEntrada: result.tipoEntrada || 'limite',
    faltantes: result.faltantes || '',
    estricto: extra.estricto || '',
    origen: extra.origen || '',
    status: (result.tipoEntrada === 'mercado') ? 'activa' : 'pendiente',
    activatedAt: (result.tipoEntrada === 'mercado') ? Date.now() : null,
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
  const step = j.evalInterval === '1min' ? 60 * 1000 : FIVE_MIN; // tamano de las velas con las que se evalua
  const long = j.direccion === 'LONG';
  const risk = Math.abs(j.entry - j.sl);
  const startMs = (Math.floor(j.createdAt / step) + 1) * step; // primera vela completa DESPUES de la señal
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
        if (hitSL) { j.ambigua = true; close('SL', t + step, -1); }
        else if (hitTP) { j.ambigua = true; close('TP', t + step, j.rrPlan); }
      } else if (hitTP) {
        close('invalidada', t + step, null); // llego al TP sin darte la entrada
      }
    } else if (j.status === 'activa') {
      if (t - j.activatedAt > ACTIVE_EXPIRE_MS) {
        const ref = prevClose !== null ? prevClose : j.entry;
        close('expirada', t, (long ? ref - j.entry : j.entry - ref) / risk);
        break;
      }
      if (hitSL) { j.ambigua = hitTP; close('SL', t + step, -1); }
      else if (hitTP) { close('TP', t + step, j.rrPlan); }
    }
    prevClose = cl;
  }
}

// Pide 5M suficientes para cubrir desde la señal abierta mas vieja hasta ahora
// Limitador de peticiones: el plan gratis de Twelve Data permite 8 creditos por minuto (1 por peticion).
// Se mide con performance.now() para no depender del reloj del sistema. Tambien cuenta los creditos del dia.
const tdStamps = [];
const STEP_MS = { '1min': 60000, '5min': 300000, '15min': 900000, '1h': 3600000 };

function bumpCredit() {
  const day = new Date().toISOString().slice(0, 10);
  let c = { day, n: 0 };
  try { const x = JSON.parse(localStorage.getItem('tdCredits') || 'null'); if (x && x.day === day) c = x; } catch (e) { /* nuevo dia */ }
  c.n += 1;
  localStorage.setItem('tdCredits', JSON.stringify(c));
  if (typeof renderCredits === 'function') renderCredits();
}

async function tdThrottle() {
  const per = Number(localStorage.getItem('tdPerMin')) || 8;
  for (;;) {
    const now = performance.now();
    while (tdStamps.length && now - tdStamps[0] > 60000) tdStamps.shift();
    if (tdStamps.length < per) break;
    await new Promise((r) => setTimeout(r, Math.max(300, 60000 - (now - tdStamps[0]) + 200)));
  }
  tdStamps.push(performance.now());
  bumpCredit();
}

async function tdGet(url) {
  await tdThrottle();
  const response = await fetch(url);
  return response.json();
}

async function fetchCandlesSince(symbol, sinceMs, apiKey, interval = '5min') {
  const step = interval === '1min' ? 60 * 1000 : FIVE_MIN;
  const startMs = (Math.floor(sinceMs / step) + 1) * step;
  const count = Math.min(5000, Math.ceil((Date.now() - startMs) / step) + 5);
  const url = `${TWELVEDATA_BASE}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${Math.max(count, 10)}&timezone=UTC&apikey=${apiKey}`;
  const data = await tdGet(url);
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
    // Una peticion por instrumento y por tamano de vela de evaluacion (1 credito cada una)
    const groupKey = (j) => `${j.symbol}|${j.evalInterval || '5min'}`;
    const groups = [...new Set(openNow.map(groupKey))];
    const candlesByGroup = {};
    for (const g of groups) {
      const [sym, interval] = g.split('|');
      const oldest = Math.min(...openNow.filter((j) => groupKey(j) === g).map((j) => j.createdAt));
      candlesByGroup[g] = await fetchCandlesSince(sym, oldest, settings.twelveKey, interval);
    }
    // Releemos el registro DESPUES de las peticiones, por si se agrego una señal mientras esperabamos
    const journal = getJournal();
    journal.filter(isOpenSignal).forEach((j) => {
      const cs = candlesByGroup[groupKey(j)];
      if (cs) evaluateSignal(j, cs);
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
async function fetchCandles(symbol, interval, apiKey, outputsize = 60) {
  // timezone=UTC para que las horas de las velas sean siempre UTC (los niveles por sesion dependen de eso)
  const url = `${TWELVEDATA_BASE}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&timezone=UTC&apikey=${apiKey}`;
  const data = await tdGet(url);

  if (data.status === 'error' || !data.values) {
    throw new Error('Error de Twelve Data: ' + (data.message || 'No se recibieron velas.'));
  }

  // Twelve Data devuelve mas reciente primero — lo invertimos a orden cronologico.
  // Se descarta la ultima vela si aun se esta formando: el analisis solo usa velas CERRADAS.
  const ordered = data.values.slice().reverse();
  return window.SMCLevels ? window.SMCLevels.closedOnly(ordered, STEP_MS[interval] || 60000) : ordered;
}

function candlesToText(candles) {
  return candles
    .map((c, i) => `${i + 1}, ${c.datetime}, O:${c.open}, H:${c.high}, L:${c.low}, C:${c.close}`)
    .join('\n');
}

function buildMultiTimeframeText(symbol, candlesMacro, candlesMid, candlesTrig, note = '', levelsText = '', L = TF_MODES.intra) {
  return `Instrumento: ${symbol}

=== VELAS ${L.macro} (MACRO - zona de liquidez / order block macro) ===
${candlesToText(candlesMacro)}

=== VELAS ${L.mid} (MEDIO - order block / FVG / movimiento) ===
${candlesToText(candlesMid)}

=== VELAS ${L.trig} (GATILLO - confirmacion de entrada) ===
${candlesToText(candlesTrig)}
${levelsText ? '\n' + levelsText + '\n' : ''}
Analiza las tres temporalidades con el metodo indicado, de mayor a menor (${L.macro} macro, ${L.mid} medio, ${L.trig} gatillo), y responde en el formato JSON indicado.${note ? '\n\n' + note : ''}`;
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
    systemInstruction: { parts: [{ text: getSystemPrompt() }] },
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
      { role: 'system', content: getSystemPrompt() },
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
    system: getSystemPrompt(),
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
      calidad: parsed.calidad === 'B' ? 'B' : (parsed.calidad === 'A' ? 'A' : null),
      analisis: parsed.analisis || '(sin analisis)',
      zona: parsed.zona || '(sin zona)',
      gatillo: parsed.gatillo || null,
      entrada: parsed.entrada || null,
      stopLoss: parsed.stopLoss || null,
      takeProfit: parsed.takeProfit || null,
      rrReal: parsed.rrReal || null,
      patron: ['limpio', 'dificultad', 'zona_en_prueba', 'barrido'].includes(parsed.patron) ? parsed.patron : null,
      tipoEntrada: parsed.tipoEntrada === 'mercado' ? 'mercado' : (parsed.tipoEntrada === 'limite' ? 'limite' : null),
      faltantes: parsed.faltantes || null,
      seguimiento: (parsed.seguimiento && parsed.seguimiento.activar)
        ? { activar: true, direccion: parsed.seguimiento.direccion, nivel: String(parsed.seguimiento.nivel), condicion: parsed.seguimiento.condicion || '' }
        : null
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
// ANALISIS CON CHATGPT (OpenAI)
// ---------------------------------------------------------------
async function openaiRequest(messages, apiKey, model, maxTokens) {
  let response;
  try {
    response = await fetch(OPENAI_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || 'gpt-6.1-sol',
        messages,
        response_format: { type: 'json_object' },
        max_completion_tokens: maxTokens
      })
    });
  } catch (e) {
    // Un TypeError aqui suele ser CORS / bloqueo del navegador o sin internet
    throw new Error('No se pudo conectar con OpenAI desde el navegador (puede estar bloqueado por CORS o sin internet).');
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Error de ChatGPT (${response.status}): ${errText || response.statusText}`);
  }
  const data = await response.json();
  const rawContent = data?.choices?.[0]?.message?.content;
  if (!rawContent) throw new Error('ChatGPT no devolvio contenido.');
  return rawContent;
}

async function analyzeCandlesOpenAI(promptText, apiKey, model) {
  const raw = await openaiRequest(
    [{ role: 'system', content: getSystemPrompt() }, { role: 'user', content: promptText }],
    apiKey, model, 4000
  );
  return parseModelJson(raw);
}

// ---------------------------------------------------------------
// MODO CONSENSO (Claude + ChatGPT)
// 1) Cada uno analiza por separado, sin ver al otro.
// 2) Si coinciden (ambos NO APTO, o ambos APTO con la misma direccion y entrada/SL
//    parecidos) esa es la conclusion.
// 3) Si no coinciden, UNA sola ronda: cada uno lee la opinion del otro y revisa
//    la suya (puede corregirse o mantenerse).
// 4) Si aun asi no coinciden, el resultado final es NO APTO (sin consenso).
// Solo se muestra la conclusion final; lo que opino cada uno queda resumido en el analisis.
// ---------------------------------------------------------------
const AGREE_TOL = 0.5; // la entrada y el SL de ambos deben estar a menos de 0.5x el riesgo de diferencia

function consensusEnabled(s) {
  return !!(s.consensusOn && s.claudeKey && s.openaiKey);
}

function bothNo(a, b) {
  return a.veredicto !== 'APTO' && b.veredicto !== 'APTO';
}

function plansAgree(a, b) {
  if (a.veredicto !== 'APTO' || b.veredicto !== 'APTO') return false;
  if (a.direccion !== b.direccion || (a.direccion !== 'LONG' && a.direccion !== 'SHORT')) return false;
  const ea = parseFloat(a.entrada), eb = parseFloat(b.entrada);
  const sa = parseFloat(a.stopLoss), sb = parseFloat(b.stopLoss);
  if (![ea, eb, sa, sb].every(Number.isFinite)) return false;
  const risk = Math.abs(ea - sa);
  if (risk === 0) return false;
  return Math.abs(ea - eb) <= AGREE_TOL * risk && Math.abs(sa - sb) <= AGREE_TOL * risk;
}

function posStr(r) {
  return r.veredicto === 'APTO' ? `APTO ${r.direccion}` : 'NO APTO';
}

function slimResult(r) {
  return {
    veredicto: r.veredicto, direccion: r.direccion, analisis: r.analisis, zona: r.zona,
    gatillo: r.gatillo, entrada: r.entrada, stopLoss: r.stopLoss, takeProfit: r.takeProfit, rrReal: r.rrReal,
    calidad: r.calidad, patron: r.patron, faltantes: r.faltantes, seguimiento: r.seguimiento
  };
}

function buildDebatePrompt(original, other, otherName) {
  return `${original}

=== SEGUNDA OPINION ===
Otro analista independiente (${otherName}) analizo los MISMOS datos y concluyo esto (JSON):
${JSON.stringify(slimResult(other))}

Revisa tu propio analisis con honestidad. Si su argumento es correcto y los datos lo respaldan, corrigelo; si no, mantén tu postura y explica brevemente por que. No cedas solo por presion: decide unicamente con los datos. Responde con el mismo formato JSON de siempre.`;
}

function mergeAgreed(c, o, via, trail) {
  const long = c.direccion === 'LONG';
  const entry = parseFloat(c.entrada), sl = parseFloat(c.stopLoss);
  const tpC = parseFloat(c.takeProfit), tpO = parseFloat(o.takeProfit);
  // TP: el mas cercano de los dos (mas conservador)
  let tp = tpC;
  if (Number.isFinite(tpO) && Number.isFinite(tpC)) tp = long ? Math.min(tpC, tpO) : Math.max(tpC, tpO);
  const dec = (String(c.entrada).split('.')[1] || '').length;
  const risk = Math.abs(entry - sl);
  const rr = Number.isFinite(tp) && risk > 0 ? Math.abs(tp - entry) / risk : null;
  const conf = [c.confianza, o.confianza].filter((x) => Number.isFinite(Number(x))).map(Number);
  return {
    veredicto: 'APTO',
    direccion: c.direccion,
    confianza: conf.length ? Math.round(conf.reduce((a, b) => a + b, 0) / conf.length) : null,
    calidad: (c.calidad === 'B' || o.calidad === 'B') ? 'B' : 'A',
    analisis: `CONSENSO ${via}: Claude y ChatGPT coinciden en ${posStr(c)}. ${trail}\n\n${c.analisis}`,
    zona: c.zona,
    gatillo: c.gatillo,
    patron: c.patron || o.patron || null,
    tipoEntrada: c.tipoEntrada || o.tipoEntrada || null,
    faltantes: c.faltantes || o.faltantes || null,
    entrada: c.entrada,
    stopLoss: c.stopLoss,
    takeProfit: Number.isFinite(tp) ? tp.toFixed(dec) : c.takeProfit,
    rrReal: rr !== null ? `${(Math.round(rr * 10) / 10)}:1` : c.rrReal,
    consenso: via
  };
}

// Seguimiento (vigilar la confirmacion): se activa si alguno lo pide; si los dos lo piden en direcciones distintas, no.
function validSeg(r) {
  const sg = r && r.seguimiento;
  return !!(sg && sg.activar && (sg.direccion === 'LONG' || sg.direccion === 'SHORT') && Number.isFinite(parseFloat(sg.nivel)));
}
function pickSeguimiento(c, o) {
  if (validSeg(c) && validSeg(o)) return c.seguimiento.direccion === o.seguimiento.direccion ? c.seguimiento : null;
  return validSeg(c) ? c.seguimiento : (validSeg(o) ? o.seguimiento : null);
}

function mergeNoApto(c, o, via, trail, label) {
  return {
    veredicto: 'NO APTO',
    direccion: 'NINGUNA',
    confianza: null,
    calidad: null,
    analisis: `${label} ${via}: ${trail}\n\nClaude: ${c.analisis}\n\nChatGPT: ${o.analisis}`,
    zona: c.zona,
    gatillo: null, entrada: null, stopLoss: null, takeProfit: null, rrReal: null,
    patron: c.patron || o.patron || null,
    seguimiento: pickSeguimiento(c, o),
    consenso: via
  };
}

async function analyzeWithConsensus(promptText, settings, statusFn) {
  const runC = (text) => analyzeCandlesClaude(text, settings.claudeKey);
  const runO = (text) => analyzeCandlesOpenAI(text, settings.openaiKey, settings.openaiModel);

  if (statusFn) statusFn('Claude y ChatGPT analizando por separado...', '');
  const [rc, ro] = await Promise.allSettled([runC(promptText), runO(promptText)]);

  if (rc.status === 'rejected' && ro.status === 'rejected') {
    // Ninguno de los dos respondio: probamos los proveedores de respaldo (Gemini / OpenRouter)
    const fb = await analyzeWithFallback(promptText, { ...settings, claudeKey: '' }, statusFn);
    return { ...fb, result: { ...fb.result, consenso: 'sin consenso (Claude y ChatGPT fallaron)' } };
  }
  if (rc.status === 'rejected' || ro.status === 'rejected') {
    const okC = rc.status === 'fulfilled';
    const name = okC ? 'Claude' : 'ChatGPT';
    const failed = okC ? 'ChatGPT' : 'Claude';
    const why = (okC ? ro : rc).reason?.message || '';
    console.log(`SMC Copilot: ${failed} fallo en consenso`, why);
    return { result: { ...(okC ? rc.value : ro.value), consenso: `sin segunda opinion (${failed} fallo)` }, usedProvider: name };
  }

  const c1 = rc.value, o1 = ro.value;
  const provider = 'Consenso Claude+ChatGPT';

  if (bothNo(c1, o1)) {
    return { result: mergeNoApto(c1, o1, 'directo', 'ambos coinciden en NO APTO.', 'CONSENSO'), usedProvider: provider };
  }
  if (plansAgree(c1, o1)) {
    return { result: mergeAgreed(c1, o1, 'directo', ''), usedProvider: provider };
  }

  // No coinciden: una sola ronda de revision cruzada
  if (statusFn) statusFn('No coinciden: cada uno revisa la opinion del otro...', '');
  const [rc2, ro2] = await Promise.allSettled([
    runC(buildDebatePrompt(promptText, o1, 'ChatGPT')),
    runO(buildDebatePrompt(promptText, c1, 'Claude'))
  ]);
  const c2 = rc2.status === 'fulfilled' ? rc2.value : c1;
  const o2 = ro2.status === 'fulfilled' ? ro2.value : o1;
  const trail = `Postura inicial → final: Claude ${posStr(c1)} → ${posStr(c2)}; ChatGPT ${posStr(o1)} → ${posStr(o2)}.`;

  if (bothNo(c2, o2)) {
    return { result: mergeNoApto(c2, o2, 'tras revision', `ambos terminan en NO APTO. ${trail}`, 'CONSENSO'), usedProvider: provider };
  }
  if (plansAgree(c2, o2)) {
    return { result: mergeAgreed(c2, o2, 'tras revision', trail), usedProvider: provider };
  }
  return { result: mergeNoApto(c2, o2, 'sin consenso', `no se pusieron de acuerdo, asi que NO se opera. ${trail}`, 'SIN CONSENSO'), usedProvider: provider };
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
  if (settings.geminiKey) {
    providers.push({ name: 'Gemini', run: () => analyzeCandles(promptText, settings.geminiKey, settings.model) });
  }
  if (settings.openrouterKey) {
    providers.push({ name: 'OpenRouter', run: () => analyzeCandlesOpenRouter(promptText, settings.openrouterKey) });
  }

  if (providers.length === 0) throw new Error('No hay ninguna clave de IA configurada (icono ⚙).');
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
const openaiKeyInput = document.getElementById('openaiKeyInput');
const openaiModelSelect = document.getElementById('openaiModelSelect');
const consensusToggle = document.getElementById('consensusToggle');
const testOpenaiBtn = document.getElementById('testOpenaiBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const settingsStatus = document.getElementById('settingsStatus');
const instrumentSelect = document.getElementById('instrumentSelect');
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
const resultMeta = document.getElementById('resultMeta');
const qualityChip = document.getElementById('qualityChip');
const patternChip = document.getElementById('patternChip');
const faltantesText = document.getElementById('faltantesText');
const followText = document.getElementById('followText');
const planLadder = document.getElementById('planLadder');
const nyClock = document.getElementById('nyClock');
const marketPill = document.getElementById('marketPill');
const creditsChip = document.getElementById('creditsChip');
const todayPips = document.getElementById('todayPips');
const todayCount = document.getElementById('todayCount');
const sessionLabelEl = document.getElementById('sessionLabel');
const strictHint = document.getElementById('strictHint');
const scanList = document.getElementById('scanList');
const watchList = document.getElementById('watchList');
const rotationToggle = document.getElementById('rotationToggle');
const newsInput = document.getElementById('newsInput');
const newsHint = document.getElementById('newsHint');

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

const PATTERN_LABEL = { limpio: 'Llegada limpia', dificultad: 'Llegada con dificultad', zona_en_prueba: 'Zona en prueba', barrido: 'Barrido hecho' };

function displayResult(result, symbol) {
  const apto = result.veredicto === 'APTO';
  verdictBadge.textContent = result.veredicto + (result.direccion !== 'NINGUNA' ? ' — ' + result.direccion : '');
  verdictBadge.className = 'verdict-badge ' + (apto ? 'apto' : 'no-apto') + (apto && result.direccion === 'SHORT' ? ' short' : '');
  resultMeta.textContent = `${symbol || instrumentSelect.value} · ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}${result.consenso ? ' · ' + result.consenso : ''}`;
  analysisText.textContent = result.analisis + (result.confianza ? `\n\nConfianza: ${result.confianza}/10` : '');
  zoneText.textContent = result.zona || '—';

  qualityChip.textContent = result.calidad ? `Calidad ${result.calidad}` : '';
  qualityChip.className = 'chip ' + (result.calidad === 'A' ? 'chip-a' : result.calidad === 'B' ? 'chip-b' : 'hidden');
  patternChip.textContent = PATTERN_LABEL[result.patron] || '';
  patternChip.className = 'chip chip-p-' + (result.patron || 'none') + (PATTERN_LABEL[result.patron] ? '' : ' hidden');
  faltantesText.textContent = result.faltantes ? `Le falta: ${result.faltantes}` : '';
  faltantesText.classList.toggle('hidden', !result.faltantes);
  const sg = (!apto && validSeg(result)) ? result.seguimiento : null;
  followText.textContent = sg ? `👁 Vigilando 1M: ${sg.direccion} si una vela cierra con cuerpo ${sg.direccion === 'LONG' ? 'sobre' : 'bajo'} ${sg.nivel}. ${sg.condicion || ''}` : '';
  followText.classList.toggle('hidden', !sg);

  if (apto && result.entrada) {
    tpGatillo.textContent = result.gatillo || '—';
    tpEntrada.textContent = result.entrada + (result.tipoEntrada === 'mercado' ? '  (a mercado)' : '');
    tpSL.textContent = result.stopLoss || '—';
    tpTP.textContent = result.takeProfit || '—';
    tpRR.textContent = result.rrReal || '—';
    renderLadder(result);
    tradePlanBox.classList.remove('hidden');
  } else {
    tradePlanBox.classList.add('hidden');
  }
  resultBox.classList.remove('hidden');
}

// Escalera visual TP / Entrada / SL (altura proporcional al precio)
function renderLadder(r) {
  const e = parseFloat(r.entrada), sl = parseFloat(r.stopLoss), tp = parseFloat(r.takeProfit);
  planLadder.innerHTML = '';
  if (![e, sl, tp].every(Number.isFinite)) return;
  const hi = Math.max(e, sl, tp), lo = Math.min(e, sl, tp), span = hi - lo || 1;
  [['TP', tp, 'lad-tp'], ['Entrada', e, 'lad-e'], ['SL', sl, 'lad-sl']].forEach(([label, price, cls]) => {
    const row = el('div', 'lad ' + cls);
    row.style.top = (10 + ((hi - price) / span) * 80).toFixed(1) + '%';
    row.appendChild(el('span', 'lad-l', label));
    row.appendChild(el('span', 'lad-p', fmtPrice(price)));
    planLadder.appendChild(row);
  });
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
        <div class="hist-verdict ${esApto ? 'apto' : 'no-apto'}">${h.veredicto} ${h.direccion !== 'NINGUNA' ? h.direccion : ''}${h.calidad ? ' · ' + h.calidad : ''}</div>
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

  const tpsl = (q) => `${journal.filter((j) => j.status === 'TP' && (j.calidad || 'A') === q).length} / ${journal.filter((j) => j.status === 'SL' && (j.calidad || 'A') === q).length}`;
  const analyzedWindows = Object.keys(getWindowLog()).length;
  const windowsWithSignal = new Set(journal.map(entryDayKey).filter(Boolean)).size;
  const stats = [
    ['Señales', journal.length],
    ['TP / SL', `${wins} / ${losses}`],
    ['Acierto', winrate],
    ['R neto', fmtR(netR) || '0R'],
    ['Abiertas', open],
    ['Sin entrada', missed],
    ['Dias con señal', `${windowsWithSignal} / ${Math.max(analyzedWindows, windowsWithSignal)}`],
    ['Calidad A (TP/SL)', tpsl('A')],
    ['Calidad B (TP/SL)', tpsl('B')]
  ];
  // TP/SL por patron de llegada (para comprobar con datos si las hipotesis del metodo se cumplen)
  Object.keys(PATTERN_LABEL).forEach((pt) => {
    const w = journal.filter((j) => j.patron === pt && j.status === 'TP').length;
    const l = journal.filter((j) => j.patron === pt && j.status === 'SL').length;
    if (w + l > 0) stats.push([`${PATTERN_LABEL[pt]} (TP/SL)`, `${w} / ${l}`]);
  });
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
    item.appendChild(el('div', 'hist-meta', `${fechaStr} · ${j.provider || ''} · Calidad ${j.calidad || 'A'}${j.patron ? ' · ' + (PATTERN_LABEL[j.patron] || j.patron) : ''}${j.tipoEntrada === 'mercado' ? ' · a mercado' : ''}${j.origen === 'seguimiento' ? ' · seguimiento' : ''}${j.consenso ? ' · ' + j.consenso : ''}`));

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
  const head = ['fecha_local', 'instrumento', 'direccion', 'entrada', 'sl', 'tp', 'rr_plan', 'estado', 'resultado_R', 'ambigua', 'calidad', 'consenso', 'ventana', 'confianza', 'proveedor', 'zona', 'gatillo', 'patron', 'tipo_entrada', 'faltantes', 'exigencia_dia', 'origen'];
  const q = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
  const rows = journal.map((j) => [
    new Date(j.createdAt).toLocaleString('es'), j.symbol, j.direccion, j.entry, j.sl, j.tp,
    Math.round(j.rrPlan * 100) / 100, j.status, j.resultR === null ? '' : Math.round(j.resultR * 100) / 100,
    j.ambigua ? 'si' : 'no', j.calidad || 'A', j.consenso || '', j.windowKey || '', j.confianza, j.provider, j.zona, j.gatillo,
    j.patron || '', j.tipoEntrada || '', j.faltantes || '', j.estricto || '', j.origen || ''
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
let analysisRunning = false;

// ---------------------------------------------------------------
// FILTROS FINALES EN CODIGO (se aplican sobre el veredicto de la IA)
// ---------------------------------------------------------------
function toNoApto(r, why) {
  return {
    ...r, veredicto: 'NO APTO', direccion: 'NINGUNA', calidad: null, tipoEntrada: null, gatillo: null,
    entrada: null, stopLoss: null, takeProfit: null, rrReal: null, faltantes: null,
    analisis: `${r.analisis || ''}\n\n[Filtro de codigo] ${why}`, bloqueada: why
  };
}

// Exigencia segun el dia (hora de Nueva York): lunes/martes y miercoles por la manana suelen ser acumulacion
function dayStrictness() {
  const ny = nowIn('America/New_York');
  const wd = ny.weekday;
  if (wd === 1 || wd === 2 || (wd === 0 && ny.minutes >= 17 * 60)) {
    return { mode: 'soloA', label: 'Lun/Mar: solo calidad A', text: 'EXIGENCIA DEL DIA: lunes/martes (acumulacion habitual). Solo se aceptan setups de calidad A; exige evidencia fuerte de que NO es acumulacion.' };
  }
  if (wd === 3 && ny.minutes < 12 * 60) {
    return { mode: 'Balta', label: 'Mie (mañana): B solo con confianza 7+', text: 'EXIGENCIA DEL DIA: miercoles por la mañana (aun suele ser acumulacion). Las calidad B solo valen con confianza 7 o mas.' };
  }
  return { mode: 'normal', label: 'Exigencia normal', text: 'EXIGENCIA DEL DIA: normal (la distribucion suele estar activa).' };
}

function applyGuards(result, ctx) {
  const aiPatron = result.patron;
  let r = { ...result };
  if (ctx.state) r.patron = ctx.state.pattern; // el patron medido por codigo manda
  if (r.veredicto !== 'APTO') return r;
  const dir = r.direccion;
  const sl = parseFloat(r.stopLoss), tp = parseFloat(r.takeProfit);
  if (!(dir === 'LONG' || dir === 'SHORT') || !Number.isFinite(sl) || !Number.isFinite(tp)) return r;

  // Pasos 1 y 2 solo para entradas a mercado (el prompt siempre las pide asi; 'limite' queda como compatibilidad)
  if (r.tipoEntrada === 'mercado') {
    // 1) No perseguir una vela de confirmacion enorme
    const nums = window.SMCLevels.toNum(ctx.trigClosed);
    const a = window.SMCLevels.atr(nums.slice(0, -1));
    const lc = nums[nums.length - 1];
    if (a && lc && (lc.h - lc.l) > 2.5 * a) {
      return toNoApto(r, `la ultima vela cerrada mide ${((lc.h - lc.l) / a).toFixed(1)} x ATR (noticia o inyeccion de capital): no se persigue la entrada.`);
    }

    // 2) Entrada a mercado = cierre de la ultima vela cerrada del marco de gatillo
    if (lc) {
      const entry = lc.c;
      const raw = ctx.trigClosed[ctx.trigClosed.length - 1].close;
      const dec = Math.max((String(raw).split('.')[1] || '').length, 2);
      const okSide = dir === 'LONG' ? (sl < entry && tp > entry) : (sl > entry && tp < entry);
      if (!okSide) return toNoApto(r, 'con la entrada a mercado (cierre actual) el SL o el TP quedan del lado equivocado: el precio ya se movio.');
      const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
      if (rr < 1.95) return toNoApto(r, `con la entrada a mercado el R:R real es ${rr.toFixed(1)}:1 (minimo 2:1): el precio ya se alejo del punto ideal.`);
      r.tipoEntrada = 'mercado';
      r.entrada = entry.toFixed(dec);
      r.rrReal = `${Math.round(rr * 10) / 10}:1`;
    }

  }

  // 3) Patron de llegada sin barrido final (hipotesis del usuario)
  if (ctx.state && (ctx.state.pattern === 'dificultad' || ctx.state.pattern === 'zona_en_prueba') && aiPatron !== 'barrido') {
    return toNoApto(r, `patron de llegada "${ctx.state.pattern}" sin barrido final: se espera el barrido y el cierre de vuelta antes de entrar.`);
  }

  // 4) Exigencia segun el dia
  const st = ctx.strict;
  if (st && st.mode === 'soloA' && r.calidad === 'B') return toNoApto(r, 'calidad B descartada: lunes/martes solo se operan setups A.');
  if (st && st.mode === 'Balta' && r.calidad === 'B' && !(Number(r.confianza) >= 7)) return toNoApto(r, 'calidad B descartada: el miercoles por la mañana exige confianza 7 o mas.');
  return r;
}

// ---------------------------------------------------------------
// SEGUIMIENTO: cuando solo falta la vela de confirmacion, el codigo vigila el marco de gatillo (1M)
// y vuelve a llamar a la IA en cuanto una vela cierra con cuerpo mas alla del nivel.
// ---------------------------------------------------------------
const WATCH_TTL = 90 * 60 * 1000;

function getWatches() {
  try { return JSON.parse(localStorage.getItem('watches') || '[]'); } catch (e) { return []; }
}
function saveWatches(w) {
  localStorage.setItem('watches', JSON.stringify(w));
  if (typeof renderWatch === 'function') renderWatch();
}
function addWatch(symbol, sg, zona) {
  const w = getWatches().filter((x) => x.symbol !== symbol);
  w.unshift({
    id: Date.now(), symbol, dir: sg.direccion, nivel: parseFloat(sg.nivel), condicion: sg.condicion || '',
    zona: zona || '', createdAt: Date.now(), lastT: Date.now() - 60000
  });
  saveWatches(w.slice(0, 3));
}
function updateWatch(id, patch) {
  saveWatches(getWatches().map((x) => (x.id === id ? { ...x, ...patch } : x)));
}
function removeWatch(id) {
  saveWatches(getWatches().filter((x) => x.id !== id));
}

async function watchTick() {
  const settings = getSettings();
  if (!settings.twelveKey || analysisRunning) return;
  let ws = getWatches();
  const alive = ws.filter((w) => Date.now() - w.createdAt < WATCH_TTL);
  if (alive.length !== ws.length) { saveWatches(alive); ws = alive; }
  if (!ws.length || !shouldAnalyzeNow()) return;
  for (const w of ws.slice(0, 2)) {
    try {
      const cs = await fetchCandles(w.symbol, '1min', settings.twelveKey, 40);
      const c = window.SMCLevels.confirmation(cs, w.nivel, w.dir);
      if (!c || c.t <= w.lastT) continue;
      updateWatch(w.id, { lastT: c.t });
      if (!c.confirmed) continue;
      removeWatch(w.id);
      if (c.big) {
        setStatus(`${w.symbol}: la vela de confirmacion es enorme (${c.rngAtr.toFixed(1)} x ATR), no se persigue.`, '');
        continue;
      }
      const hh = new Date(c.t).toISOString().slice(11, 16) + ' UTC';
      const note = `CONFIRMACION DETECTADA POR CODIGO: la vela de 1M de las ${hh} cerro con cuerpo ${w.dir === 'LONG' ? 'por encima' : 'por debajo'} de ${w.nivel} (cierre ${c.close}). Verifica que el resto del metodo se cumple; si es asi, la entrada es a mercado en el cierre de esa vela.`;
      await runAnalysis({ silent: true, symbol: w.symbol, note, origen: 'seguimiento' });
      break; // una por vuelta para cuidar los creditos
    } catch (err) {
      console.log('SMC Copilot vigilancia error:', err);
    }
  }
}

// ---------------------------------------------------------------
// ANALISIS COMPLETO DE UN INSTRUMENTO
// ---------------------------------------------------------------
async function runAnalysis({ silent = false, symbol = null, pre = null, note = '', origen = '' } = {}) {
  const settings = getSettings();
  const hasAnyAiKey = settings.claudeKey || settings.geminiKey || settings.openaiKey || settings.openrouterKey;
  if (!settings.twelveKey || !hasAnyAiKey) {
    if (!silent) setStatus('Configura Twelve Data y al menos una clave de IA primero (icono ⚙).', 'error');
    return null;
  }
  if (analysisRunning) {
    if (!silent) setStatus('Ya hay un analisis en curso, espera a que termine.', '');
    return null;
  }
  analysisRunning = true;

  const sym = symbol || instrumentSelect.value;
  let outResult = null;

  try {
    if (!silent) setStatus('Obteniendo velas...', '');
    // Marco de tiempo elegido (scalping 15M/5M/1M o intradia 1H/15M/5M). Siempre pedimos 130 velas
    // de 1H (~5 dias) para calcular niveles diarios y de sesion; al modelo solo se le mandan las ultimas 60 de cada marco.
    // "pre" = velas de 15M y 5M ya descargadas por el escaneo de la rotacion (se reutilizan para ahorrar creditos).
    const tfMode = getTfMode();
    const L = TF_MODES[tfMode];
    const key = settings.twelveKey;
    let candles1h, candlesMacro, candlesMid, candlesTrig;
    if (tfMode === 'scalp') {
      [candles1h, candlesMacro, candlesMid, candlesTrig] = await Promise.all([
        fetchCandles(sym, '1h', key, 130),
        pre ? pre.macro : fetchCandles(sym, '15min', key, 100),
        pre ? pre.mid : fetchCandles(sym, '5min', key, 60),
        fetchCandles(sym, '1min', key, 60)
      ]);
    } else {
      [candles1h, candlesMid, candlesTrig] = await Promise.all([
        fetchCandles(sym, '1h', key, 130),
        fetchCandles(sym, '15min', key, 60),
        fetchCandles(sym, '5min', key, 60)
      ]);
      candlesMacro = candles1h;
    }

    const winInfo = getWindowInfo();
    const strict = dayStrictness();
    const levelsText = window.SMCLevels
      ? window.SMCLevels.buildLevelsText({ h1: candles1h, macro: candlesMacro, mid: candlesMid, trig: candlesTrig, labels: L })
      : '';
    const noteAll = [strict.text, note].filter(Boolean).join('\n');
    const promptText = buildMultiTimeframeText(sym, candlesMacro.slice(-60), candlesMid, candlesTrig, noteAll, levelsText, L);

    if (!silent) setStatus('Analizando las 3 temporalidades...', '');
    const statusFn = silent ? null : (msg, type) => setStatus(msg, type);
    const { result: aiResult, usedProvider } = consensusEnabled(settings)
      ? await analyzeWithConsensus(promptText, settings, statusFn)
      : await analyzeWithFallback(promptText, settings, statusFn);

    const state = window.SMCLevels ? window.SMCLevels.marketState(candlesMacro, candlesMid) : null;
    const result = applyGuards(aiResult, { trigClosed: candlesTrig, strict, state });
    outResult = result;

    displayResult(result, sym);
    addToHistory({ ...result, timestamp: Date.now(), symbol: sym });
    renderHistory();
    if (winInfo) logWindowAnalysis(winInfo.dayKey);
    if (addSignalToJournal(result, sym, usedProvider, winInfo ? winInfo.key : null, false, L.evalInterval,
      { estricto: strict.mode, origen, patron: result.patron })) renderJournal();
    if (result.veredicto !== 'APTO' && validSeg(result)) addWatch(sym, result.seguimiento, result.zona);

    if (result.veredicto === 'APTO') {
      notifyApto(result, sym);
    }

    // Siempre limpiamos/actualizamos el estado (incluso en corridas silenciosas del
    // modo automatico) para que un exito posterior borre un error viejo que haya
    // quedado pegado en pantalla de un intento manual anterior que fallo.
    const hora = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const esProveedorPrincipal = usedProvider === 'Claude' || usedProvider.startsWith('Consenso') || (usedProvider === 'Gemini' && !settings.claudeKey);
    setStatus(
      esProveedorPrincipal ? `${sym}: analisis completo${result.consenso ? ' (' + result.consenso + ')' : ''} — ${hora}` : `${sym}: analisis completo (via ${usedProvider}, respaldo) — ${hora}`,
      'success'
    );
  } catch (err) {
    if (!silent) setStatus(err.message || 'Error inesperado.', 'error');
    console.log('SMC Copilot error:', err);
  } finally {
    analysisRunning = false;
    // Siempre revisamos si alguna señal abierta ya llego a su TP o SL (1 credito de Twelve Data por instrumento)
    evaluateOpenSignals();
  }
  return outResult;
}

// ---------------------------------------------------------------
// ROTACION DE INSTRUMENTOS: escaneo barato en CODIGO de todos los instrumentos (15M + 5M);
// la IA solo analiza el que tiene zona y movimiento (si el oro esta en acumulacion, pasa al siguiente).
// ---------------------------------------------------------------
const ROTATION = ['XAU/USD', 'EUR/USD', 'GBP/JPY', 'USD/JPY'];
const scanState = {};

function rotationOn() {
  return localStorage.getItem('rotation') !== 'false';
}

async function scanInstruments(key) {
  for (const sym of ROTATION) {
    try {
      const [m, d] = await Promise.all([fetchCandles(sym, '15min', key, 100), fetchCandles(sym, '5min', key, 60)]);
      scanState[sym] = { state: window.SMCLevels.marketState(m, d), macro: m, mid: d, at: Date.now(), error: null };
    } catch (err) {
      scanState[sym] = { state: null, at: Date.now(), error: err.message || 'error' };
    }
    if (typeof renderScan === 'function') renderScan();
  }
}

async function runCycle() {
  const settings = getSettings();
  if (!settings.twelveKey) return;
  if (!rotationOn()) { await runAnalysis({ silent: true }); return; }
  if (analysisRunning) return;
  await scanInstruments(settings.twelveKey);
  const cands = ROTATION
    .map((sym, i) => ({ sym, i, sc: scanState[sym] }))
    .filter((x) => x.sc && x.sc.state && x.sc.state.pass)
    .sort((a, b) => (b.sc.state.score - a.sc.state.score) || (a.i - b.i));
  if (!cands.length) {
    setStatus('Rotacion: ningun instrumento tiene zona y movimiento ahora (no se gasta IA).', '');
    return;
  }
  // Hasta 2 candidatos por vuelta: el segundo solo si el primero salio NO APTO sin seguimiento
  for (const c of cands.slice(0, 2)) {
    if (!shouldAnalyzeNow()) break;
    const r = await runAnalysis({ silent: true, symbol: c.sym, pre: { macro: c.sc.macro, mid: c.sc.mid }, origen: 'rotacion' });
    if (r && (r.veredicto === 'APTO' || validSeg(r))) break;
  }
}

// ---------------------------------------------------------------
// MODO AUTOMATICO (setInterval mientras la app este abierta)
// ---------------------------------------------------------------
let autoModeTimer = null;
let watchTimer = null;

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

// Fecha YYYY-MM-DD en una zona horaria
function dateIn(tz) {
  const opts = tz === 'local' ? {} : { timeZone: tz };
  return new Intl.DateTimeFormat('en-CA', { ...opts, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function getMaxSignals() {
  const n = Number(localStorage.getItem('maxSignals'));
  return [1, 2, 3, 5].includes(n) ? n : 2;
}

// Dia de trading de las señales: la fecha en la zona horaria de los horarios (o la de tu dispositivo
// si los horarios estan apagados). El tope de señales es POR DIA, sumando todas las ventanas.
function getDayKey() {
  return dateIn(schedule.on ? schedule.tz : 'local');
}

// Ventana de trading en la que estamos ahora (o null si estamos fuera de todas).
// Con horarios apagados, el dia completo cuenta como una sola ventana.
function getWindowInfo() {
  const dayKey = getDayKey();
  if (!schedule.on) return { key: 'dia|' + dayKey, dayKey, idx: null, isLast: true, elapsedFrac: null };
  const { minutes } = nowIn(schedule.tz);
  // La "ultima ventana del dia" es la que empieza mas tarde
  let lastIdx = 0;
  schedule.windows.forEach((w, i) => {
    if (timeToMinutes(w.start) > timeToMinutes(schedule.windows[lastIdx].start)) lastIdx = i;
  });
  for (let i = 0; i < schedule.windows.length; i++) {
    const w = schedule.windows[i];
    const start = timeToMinutes(w.start);
    const end = timeToMinutes(w.end);
    const inside = start <= end ? (minutes >= start && minutes <= end) : (minutes >= start || minutes <= end);
    if (!inside) continue;
    const len = ((end - start + 1440) % 1440) || 1;
    const elapsed = (minutes - start + 1440) % 1440;
    return { key: `${dayKey}|${i}|${w.start}-${w.end}`, dayKey, idx: i, isLast: i === lastIdx, elapsedFrac: Math.min(elapsed / len, 1) };
  }
  return null;
}

function entryDayKey(j) {
  if (j.dayKey) return j.dayKey;
  const m = /\d{4}-\d{2}-\d{2}/.exec(j.windowKey || '');
  return m ? m[0] : null;
}

function signalsToday(dayKey) {
  return getJournal().filter((j) => entryDayKey(j) === dayKey).length;
}

function quotaReached() {
  return signalsToday(getDayKey()) >= getMaxSignals();
}

// Cuantos analisis se hicieron cada dia (para saber en cuantos dias hubo y no hubo señal)
function logWindowAnalysis(key) {
  let log = {};
  try { log = JSON.parse(localStorage.getItem('windowLog') || '{}'); } catch (e) { log = {}; }
  log[key] = (log[key] || 0) + 1;
  const keys = Object.keys(log);
  if (keys.length > 120) keys.slice(0, keys.length - 120).forEach((k) => delete log[k]);
  localStorage.setItem('windowLog', JSON.stringify(log));
}

function getWindowLog() {
  try { return JSON.parse(localStorage.getItem('windowLog') || '{}'); } catch (e) { return {}; }
}

// Noticias fuertes del dia (se escriben a mano, hora de Nueva York): el bot no analiza 15 min antes ni despues
function getNewsText() {
  try {
    const n = JSON.parse(localStorage.getItem('news') || 'null');
    if (n && n.day === dateIn('America/New_York')) return n.text || '';
  } catch (e) { /* sin noticias */ }
  return '';
}

function newsBlackout() {
  const txt = getNewsText();
  if (!txt) return null;
  const nowMin = nowIn('America/New_York').minutes;
  for (const line of txt.split('\n')) {
    const m = /(\d{1,2}):(\d{2})/.exec(line);
    if (!m) continue;
    const t = Number(m[1]) * 60 + Number(m[2]);
    if (nowMin >= t - 15 && nowMin <= t + 15) return line.trim();
  }
  return null;
}

function shouldAnalyzeNow() {
  return isMarketOpen() && isWithinActiveHours() && !quotaReached() && !newsBlackout();
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
  if (typeof renderToday === 'function' && typeof todayCount !== 'undefined' && todayCount) { renderToday(); updateClock(); renderNewsHint(); }
  if (!autoModeToggle.checked) {
    autoModeHint.textContent = 'Apagado. Analiza manualmente con el boton de abajo.';
    return;
  }
  const max = getMaxSignals();
  const n = signalsToday(getDayKey());
  const meta = ` Señales hoy: ${n}/${max}.`;
  const base = `Activo — ${rotationOn() ? 'rotacion de instrumentos' : 'analizando ' + instrumentSelect.value} cada ${intervalSelect.value} minutos.${meta}`;
  if (n >= max) {
    autoModeHint.textContent = `${base} Tope del dia alcanzado: en pausa hasta manana.`;
  } else if (!isMarketOpen()) {
    autoModeHint.textContent = `${base} Mercado cerrado ahora: en pausa hasta que abra.`;
  } else if (newsBlackout()) {
    autoModeHint.textContent = `${base} Pausa por noticia: ${newsBlackout()}.`;
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
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = setInterval(watchTick, 60 * 1000); // vigila la confirmacion en 1M cada minuto
  autoModeTimer = setInterval(() => {
    if (shouldAnalyzeNow()) {
      runCycle();
    } else {
      // Aunque no toque analizar, igual revisamos si alguna señal abierta ya se resolvio
      evaluateOpenSignals();
    }
    updateAutoModeHint(); // refresca el texto por si acaba de entrar/salir del rango
  }, minutes * 60 * 1000);
  localStorage.setItem('autoModeOn', 'true');
  localStorage.setItem('autoModeInterval', String(minutes));
  if (shouldAnalyzeNow()) {
    runCycle(); // primer analisis inmediato, solo si ya estamos en horario
  }
  updateAutoModeHint();
}

function stopAutoMode() {
  if (autoModeTimer) clearInterval(autoModeTimer);
  autoModeTimer = null;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
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

const tfModeSelect = document.getElementById('tfModeSelect');
const mtfBadge = document.getElementById('mtfBadge');
function renderTfMode() {
  const m = getTfMode();
  tfModeSelect.value = m;
  const L = TF_MODES[m];
  mtfBadge.textContent = `${L.macro} (macro) → ${L.mid} (zona) → ${L.trig} (gatillo)`;
}
tfModeSelect.addEventListener('change', () => {
  localStorage.setItem('tfMode', tfModeSelect.value);
  renderTfMode();
});
renderTfMode();

const maxSignalsSelect = document.getElementById('maxSignalsSelect');
maxSignalsSelect.value = String(getMaxSignals());
maxSignalsSelect.addEventListener('change', () => {
  localStorage.setItem('maxSignals', maxSignalsSelect.value);
  updateAutoModeHint();
});


// ---------------------------------------------------------------
// PANEL: reloj, hoy, escaneo, vigilancia, creditos, noticias, pestañas
// ---------------------------------------------------------------
const WD_ES = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];

function updateClock() {
  const ny = nowIn('America/New_York');
  const hh = String(Math.floor(ny.minutes / 60)).padStart(2, '0');
  const mm = String(ny.minutes % 60).padStart(2, '0');
  nyClock.textContent = `NY ${WD_ES[ny.weekday]} ${hh}:${mm}`;
  const open = isMarketOpen();
  marketPill.textContent = open ? 'Mercado abierto' : 'Mercado cerrado';
  marketPill.className = 'pill ' + (open ? 'pill-on' : 'pill-off');
  sessionLabelEl.textContent = window.SMCLevels ? window.SMCLevels.sessionLabel(Date.now()) : '';
  const st = dayStrictness();
  strictHint.textContent = st.label;
  strictHint.className = 'chip ' + (st.mode === 'normal' ? 'chip-a' : 'chip-b');
}

function renderCredits() {
  let n = 0;
  try {
    const c = JSON.parse(localStorage.getItem('tdCredits') || 'null');
    if (c && c.day === new Date().toISOString().slice(0, 10)) n = c.n;
  } catch (e) { /* sin datos */ }
  creditsChip.textContent = `${n}/800 créditos hoy`;
  creditsChip.classList.toggle('chip-b', n > 600);
}

function renderToday() {
  const max = getMaxSignals();
  const n = signalsToday(getDayKey());
  todayCount.textContent = `${n}/${max}`;
  todayPips.innerHTML = '';
  for (let i = 0; i < max; i++) todayPips.appendChild(el('span', 'pip' + (i < n ? ' on' : '')));
}

function renderScan() {
  scanList.innerHTML = '';
  ROTATION.forEach((sym) => {
    const sc = scanState[sym];
    const row = el('div', 'scan-row');
    row.appendChild(el('div', 'scan-sym', sym));
    let label = 'sin escanear', cls = 'chip-n', detail = '';
    if (sc && sc.error) { label = 'error'; cls = 'chip-b'; detail = sc.error; }
    else if (sc && sc.state) {
      const st = sc.state;
      if (st.accumulation) { label = 'Acumulación'; cls = 'chip-n'; }
      else if (st.pass) { label = st.sweep ? 'Barrido' : 'En zona'; cls = 'chip-a'; }
      else { label = 'Lejos de zona'; cls = 'chip-n'; }
      detail = st.reason + (st.level && st.pass ? ` · ${PATTERN_LABEL[st.pattern]}` : '');
    }
    row.appendChild(el('span', 'chip ' + cls, label));
    const d = el('div', 'scan-detail', detail);
    row.appendChild(d);
    if (sc && sc.state && sc.state.pass) {
      const bar = el('div', 'scan-bar');
      const fill = el('span');
      fill.style.width = Math.min(100, Math.round(sc.state.score / 4 * 100)) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
    }
    scanList.appendChild(row);
  });
}

function renderWatch() {
  const ws = getWatches();
  watchList.innerHTML = '';
  watchList.classList.toggle('hidden', ws.length === 0);
  ws.forEach((w) => {
    const mins = Math.max(0, Math.round((WATCH_TTL - (Date.now() - w.createdAt)) / 60000));
    const row = el('div', 'watch-row');
    row.appendChild(el('span', 'watch-eye', '👁'));
    row.appendChild(el('span', 'watch-txt', `${w.symbol} ${w.dir}: vigilando 1M ${w.dir === 'LONG' ? 'sobre' : 'bajo'} ${w.nivel} (${mins} min)`));
    const x = el('button', 'icon-btn small', '✕');
    x.type = 'button'; x.title = 'Dejar de vigilar';
    x.addEventListener('click', () => removeWatch(w.id));
    row.appendChild(x);
    watchList.appendChild(row);
  });
}

function renderNewsHint() {
  const b = newsBlackout();
  newsHint.textContent = b ? `⏸ Pausa por noticia: ${b}` : (getNewsText() ? 'El bot se pausa 15 min antes y 15 min despues de cada hora.' : 'Opcional. Ej.: 08:30 NFP');
}

newsInput.value = getNewsText();
newsInput.addEventListener('change', () => {
  localStorage.setItem('news', JSON.stringify({ day: dateIn('America/New_York'), text: newsInput.value }));
  renderNewsHint();
  updateAutoModeHint();
});

rotationToggle.checked = rotationOn();
rotationToggle.addEventListener('change', () => {
  localStorage.setItem('rotation', rotationToggle.checked ? 'true' : 'false');
  updateAutoModeHint();
});

// Pestañas: Panel / Diario
const tabs = { home: document.getElementById('paneHome'), journal: document.getElementById('paneJournal') };
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    Object.entries(tabs).forEach(([k, pane]) => pane.classList.toggle('hidden', k !== btn.dataset.tab));
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    window.scrollTo(0, 0);
  });
});

setInterval(() => { updateClock(); renderToday(); renderWatch(); renderNewsHint(); }, 15000);
updateClock(); renderCredits(); renderToday(); renderScan(); renderWatch(); renderNewsHint();

// ---------------------------------------------------------------
// MANTENER PANTALLA ENCENDIDA (Screen Wake Lock)
// Evita que el equipo apague la pantalla / se suspenda mientras la app esta visible.
// ---------------------------------------------------------------
const wakeLockToggle = document.getElementById('wakeLockToggle');
let wakeLock = null;

async function requestWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return false;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    return true;
  } catch (e) {
    wakeLock = null;
    return false;
  }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

wakeLockToggle.addEventListener('change', async () => {
  if (wakeLockToggle.checked) {
    const ok = await requestWakeLock();
    if (!ok) {
      wakeLockToggle.checked = false;
      setStatus('Este navegador no permitio mantener la pantalla encendida.', 'error');
      return;
    }
    localStorage.setItem('wakeLockOn', 'true');
  } else {
    releaseWakeLock();
    localStorage.setItem('wakeLockOn', 'false');
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLockToggle.checked && !wakeLock) requestWakeLock();
});

// ---------------------------------------------------------------
// INSTALAR COMO APP (boton para pantalla de inicio / escritorio)
// ---------------------------------------------------------------
const installBtn = document.getElementById('installBtn');
let deferredInstallPrompt = null;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!isStandalone) installBtn.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  installBtn.classList.add('hidden');
});
if (isIOS && !isStandalone) installBtn.classList.remove('hidden');

installBtn.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.classList.add('hidden');
  } else if (isIOS) {
    alert('En Safari: toca el boton Compartir y luego "Agregar a pantalla de inicio".');
  }
});

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
  openaiKeyInput.value = s.openaiKey;
  openaiModelSelect.value = s.openaiModel;
  consensusToggle.checked = s.consensusOn;
  showSettings();
});

backBtn.addEventListener('click', showMain);

saveSettingsBtn.addEventListener('click', () => {
  const geminiKey = geminiKeyInput.value.trim();
  const twelveKey = twelveKeyInput.value.trim();
  const openrouterKey = openrouterKeyInput.value.trim();
  const claudeKey = claudeKeyInput.value.trim();
  const openaiKey = openaiKeyInput.value.trim();
  if (!twelveKey || !(claudeKey || geminiKey || openaiKey || openrouterKey)) {
    settingsStatus.textContent = 'Falta Twelve Data (obligatoria) y al menos una clave de IA (Claude, ChatGPT, Gemini u OpenRouter).';
    settingsStatus.className = 'status-msg error';
    return;
  }
  if (consensusToggle.checked && !(claudeKey && openaiKey)) {
    settingsStatus.textContent = 'El modo consenso necesita las claves de Claude y de ChatGPT.';
    settingsStatus.className = 'status-msg error';
    return;
  }
  saveSettings(geminiKey, modelSelect.value, twelveKey, openrouterKey, claudeKey);
  localStorage.setItem('openaiKey', openaiKey);
  localStorage.setItem('openaiModel', openaiModelSelect.value);
  localStorage.setItem('consensusOn', consensusToggle.checked ? 'true' : 'false');
  settingsStatus.textContent = 'Guardado correctamente.';
  settingsStatus.className = 'status-msg success';
  setTimeout(() => { settingsStatus.textContent = ''; showMain(); }, 800);
});

// Prueba rapida de la clave de OpenAI (tambien revela si el navegador bloquea la conexion)
testOpenaiBtn.addEventListener('click', async () => {
  const key = openaiKeyInput.value.trim();
  if (!key) {
    settingsStatus.textContent = 'Pega primero tu clave de OpenAI.';
    settingsStatus.className = 'status-msg error';
    return;
  }
  settingsStatus.textContent = 'Probando conexion con ChatGPT...';
  settingsStatus.className = 'status-msg';
  try {
    await openaiRequest(
      [{ role: 'user', content: 'Responde unicamente con este JSON: {"ok": true}' }],
      key, openaiModelSelect.value, 200
    );
    settingsStatus.textContent = 'Conexion con ChatGPT correcta.';
    settingsStatus.className = 'status-msg success';
  } catch (err) {
    settingsStatus.textContent = err.message;
    settingsStatus.className = 'status-msg error';
  }
});

analyzeBtn.addEventListener('click', () => runAnalysis());

// ---------------------------------------------------------------
// INICIALIZACION
// ---------------------------------------------------------------
(async function init() {
  const settings = getSettings();
  if (!settings.twelveKey || !(settings.claudeKey || settings.geminiKey || settings.openaiKey || settings.openrouterKey)) {
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

  if (localStorage.getItem('wakeLockOn') === 'true') {
    wakeLockToggle.checked = true;
    requestWakeLock().then((ok) => { if (!ok) wakeLockToggle.checked = false; });
  }

  // Al abrir la app, ponemos al dia las señales que quedaron abiertas mientras estaba cerrada
  evaluateOpenSignals();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
