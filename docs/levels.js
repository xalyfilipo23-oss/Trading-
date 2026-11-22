// levels.js
// Niveles calculados por CODIGO con reglas fijas (no son una opinion de la IA):
// swings, FVG, order blocks candidatos, maximo/minimo del dia previo y de los
// ultimos 5 dias, rangos de sesiones (Asia / Londres, en hora de Nueva York) y ATR.
// Se le entregan a la IA como datos objetivos de referencia junto con las velas.
(function (root) {
  const NY = 'America/New_York';
  const fmtNY = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  function parseT(dt) { return Date.parse(String(dt).replace(' ', 'T') + 'Z'); }

  function nyParts(ms) {
    const p = {};
    fmtNY.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
  }

  // Dia de trading de forex: empieza a las 17:00 de Nueva York
  function tradingDay(ms) { return nyParts(ms + 7 * 3600000).date; }

  function toNum(candles) {
    return candles
      .map((c) => ({ t: parseT(c.datetime), o: +c.open, h: +c.high, l: +c.low, c: +c.close }))
      .filter((c) => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite));
  }

  function atr(cs, n = 14) {
    if (cs.length < 2) return null;
    const trs = [];
    for (let i = 1; i < cs.length; i++) {
      const p = cs[i - 1], c = cs[i];
      trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    }
    const last = trs.slice(-n);
    return last.reduce((a, b) => a + b, 0) / last.length;
  }

  // Swing high/low: maximo (minimo) mayor (menor) que las k velas de cada lado
  function swings(cs, k = 2) {
    const highs = [], lows = [];
    for (let i = k; i < cs.length - k; i++) {
      let isH = true, isL = true;
      for (let j = 1; j <= k; j++) {
        if (!(cs[i].h > cs[i - j].h && cs[i].h > cs[i + j].h)) isH = false;
        if (!(cs[i].l < cs[i - j].l && cs[i].l < cs[i + j].l)) isL = false;
      }
      if (isH) highs.push({ t: cs[i].t, price: cs[i].h });
      if (isL) lows.push({ t: cs[i].t, price: cs[i].l });
    }
    return { highs, lows };
  }

  // FVG: hueco entre el maximo de la vela 1 y el minimo de la vela 3 (alcista), o al reves (bajista).
  // Solo se listan los que no se han rellenado por completo; se muestra la parte que sigue abierta.
  function fvgs(cs, minSize) {
    const out = [];
    for (let i = 0; i + 2 < cs.length; i++) {
      const a = cs[i], c = cs[i + 2];
      if (c.l > a.h && c.l - a.h >= minSize) {
        let top = c.l; const bottom = a.h; let filled = false;
        for (let j = i + 3; j < cs.length; j++) {
          if (cs[j].l <= bottom) { filled = true; break; }
          top = Math.min(top, cs[j].l);
        }
        if (!filled) out.push({ dir: 'alcista', bottom, top, t: cs[i + 1].t });
      }
      if (c.h < a.l && a.l - c.h >= minSize) {
        let bottom = c.h; const top = a.l; let filled = false;
        for (let j = i + 3; j < cs.length; j++) {
          if (cs[j].h >= top) { filled = true; break; }
          bottom = Math.max(bottom, cs[j].h);
        }
        if (!filled) out.push({ dir: 'bajista', bottom, top, t: cs[i + 1].t });
      }
    }
    return out;
  }

  // Order block candidato: ultima vela contraria justo antes de una vela de desplazamiento
  // (rango >= 1.8 ATR y cuerpo >= 60% del rango). Solo se listan los que el precio no ha vuelto a tocar.
  function orderBlocks(cs, a) {
    const out = [];
    if (!a) return out;
    for (let i = 1; i < cs.length; i++) {
      const c = cs[i];
      const rng = c.h - c.l, body = Math.abs(c.c - c.o);
      if (rng < 1.8 * a || body < 0.6 * rng) continue;
      const bull = c.c > c.o;
      let ob = null;
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const p = cs[j];
        if (bull ? p.c < p.o : p.c > p.o) { ob = p; break; }
      }
      if (!ob) continue;
      let mitigated = false;
      for (let j = i + 1; j < cs.length; j++) {
        if (bull ? cs[j].l <= ob.h : cs[j].h >= ob.l) { mitigated = true; break; }
      }
      if (!mitigated) out.push({ dir: bull ? 'alcista' : 'bajista', bottom: ob.l, top: ob.h, t: ob.t });
    }
    return out;
  }

  // Niveles horizontales testeados varias veces: agrupa swings con precio parecido (dentro de tol)
  function testedLevels(points, tol) {
    const sorted = points.slice().sort((a, b) => a.price - b.price);
    const clusters = [];
    sorted.forEach((p) => {
      const last = clusters[clusters.length - 1];
      if (last && p.price - last.max <= tol) {
        last.sum += p.price; last.count += 1; last.max = p.price; last.lastT = Math.max(last.lastT, p.t);
      } else {
        clusters.push({ sum: p.price, count: 1, max: p.price, lastT: p.t });
      }
    });
    return clusters
      .filter((c) => c.count >= 2)
      .map((c) => ({ price: c.sum / c.count, count: c.count, lastT: c.lastT }))
      .sort((a, b) => b.lastT - a.lastT)
      .slice(0, 3);
  }


  // Quita la ultima vela si todavia se esta formando (su hora + duracion es posterior a "ahora").
  // Asi todo el analisis trabaja solo con velas CERRADAS.
  function closedOnly(candles, stepMs, nowMs) {
    const now = nowMs === undefined ? Date.now() : nowMs;
    if (!candles || !candles.length) return candles || [];
    const t = parseT(candles[candles.length - 1].datetime);
    return (Number.isFinite(t) && t + stepMs > now) ? candles.slice(0, -1) : candles;
  }

  // Estado del mercado calculado por CODIGO (sin IA): ¿acumulacion?, ¿cerca de una zona testeada?,
  // y como llega el precio a esa zona (los dos patrones del usuario):
  //  - 'dificultad': velas pequeñas y lentas con muchas mechas -> probable barrido de liquidez
  //  - 'zona_en_prueba': velas casi enteras que tocan la zona, la cruzan poco y vuelven (2+ veces) -> amague
  //  - 'barrido': una vela con mecha larga paso la zona y cerro de vuelta (posible gatillo)
  //  - 'limpio': ninguno de los anteriores
  // macroRaw: velas del marco macro (ATR, rango, niveles). midRaw: velas del marco medio (llegada al nivel).
  function marketState(macroRaw, midRaw) {
    const macro = toNum(macroRaw), mid = toNum(midRaw);
    if (macro.length < 30 || mid.length < 12) return null;
    const a = atr(macro);
    if (!a) return null;
    const am = atr(mid) || a * 0.4;
    const price = mid[mid.length - 1].c;

    const r16 = range(macro.slice(-16));
    const rangeAtr = (r16.high - r16.low) / a;
    const disp = macro.slice(-12).filter((c) => (c.h - c.l) >= 1.6 * a && Math.abs(c.c - c.o) >= 0.55 * (c.h - c.l)).length;
    const accumulation = rangeAtr < 3.5 && disp === 0;

    const sw = swings(macro);
    const tol = 0.3 * a;
    const levels = testedLevels(sw.highs, tol).map((x) => ({ ...x, type: 'maximo' }))
      .concat(testedLevels(sw.lows, tol).map((x) => ({ ...x, type: 'minimo' })));
    let level = null;
    levels.forEach((lv) => {
      const d = Math.abs(price - lv.price) / a;
      if (!level || d < level.dist) level = { ...lv, dist: d };
    });
    const near = !!level && level.dist <= 1.2;

    let pattern = 'limpio', touches = 0, sweep = false, bodyNear = null;
    if (level) {
      const L = level.price, high = level.type === 'maximo';
      const last = mid.slice(-12);
      const ext = (c) => (high ? c.h : c.l);
      const near05 = last.filter((c) => Math.abs(ext(c) - L) <= 0.5 * am);
      touches = near05.length;
      const bodyRatio = (c) => ((c.h - c.l) > 0 ? Math.abs(c.c - c.o) / (c.h - c.l) : 0);
      bodyNear = near05.length ? near05.reduce((x, c) => x + bodyRatio(c), 0) / near05.length : null;
      sweep = mid.slice(-3).some((c) => {
        const rng = c.h - c.l;
        if (rng <= 0) return false;
        const wick = high ? c.h - Math.max(c.o, c.c) : Math.min(c.o, c.c) - c.l;
        const through = high ? (c.h > L && c.c < L) : (c.l < L && c.c > L);
        return through && wick / rng >= 0.55;
      });
      const last6 = mid.slice(-6);
      const body6 = last6.reduce((x, c) => x + bodyRatio(c), 0) / last6.length;
      const close6 = last6.filter((c) => Math.abs(ext(c) - L) <= 1.2 * am).length;
      if (sweep) pattern = 'barrido';
      else if (touches >= 2 && bodyNear !== null && bodyNear >= 0.6) pattern = 'zona_en_prueba';
      else if (body6 <= 0.42 && close6 >= 4) pattern = 'dificultad';
    }

    const pass = !accumulation && (near || sweep);
    let score = 0;
    if (!accumulation) score += Math.min(rangeAtr / 6, 1) + Math.min(disp, 2) * 0.5;
    if (level && near) score += 2 * (1.2 - level.dist) / 1.2;
    if (sweep) score += 1;
    let reason;
    if (accumulation) reason = `acumulacion (rango ${rangeAtr.toFixed(1)} ATR, sin desplazamientos)`;
    else if (!near && !sweep) reason = 'lejos de zonas testeadas';
    else reason = `cerca de zona ${level.price.toFixed(5).replace(/0+$/, '')} (${level.count} toques)`;
    return { accumulation, rangeAtr, disp, atr: a, price, level, near, sweep, touches, pattern, bodyNear, pass, score, reason };
  }

  const PATTERN_TXT = {
    limpio: 'limpio (llegada sin señales de trampa)',
    dificultad: 'DIFICULTAD (velas pequeñas y lentas con mechas: probable barrido de liquidez, no confies en la ruptura)',
    zona_en_prueba: 'ZONA EN PRUEBA (velas casi enteras que tocan la zona, la cruzan poco y vuelven: posible amague antes de un barrido)',
    barrido: 'BARRIDO (mecha larga que paso la zona y cerro de vuelta: posible gatillo, busca la confirmacion)'
  };

  // Confirmacion de entrada en el marco de gatillo (1M en scalping): la ULTIMA vela cerrada cierra con
  // cuerpo mas alla del nivel en la direccion del trade, y la anterior no habia cerrado ya de ese lado.
  // "big" = la vela es enorme (rango > 2.5 ATR): perseguirla arruina el R:R (noticias / inyeccion de capital).
  function confirmation(trigRaw, level, dir) {
    const cs = toNum(trigRaw);
    if (cs.length < 16) return null;
    const a = atr(cs.slice(0, -1));
    const c = cs[cs.length - 1], p = cs[cs.length - 2];
    const rng = c.h - c.l, body = Math.abs(c.c - c.o);
    const long = dir === 'LONG';
    const beyond = long ? (c.c > level && c.c > c.o) : (c.c < level && c.c < c.o);
    const bodyOk = rng > 0 && body / rng >= 0.5;
    const fresh = long ? p.c <= level : p.c >= level;
    return { t: c.t, close: c.c, confirmed: beyond && bodyOk && fresh, big: a ? rng > 2.5 * a : false, rngAtr: a ? rng / a : null, atr: a };
  }

  function range(cs) {
    if (!cs.length) return null;
    return { high: Math.max(...cs.map((c) => c.h)), low: Math.min(...cs.map((c) => c.l)) };
  }

  function sessionLabel(ms) {
    const h = nyParts(ms).hour;
    if (h >= 20 || h < 2) return 'Asia (20:00-02:00 NY)';
    if (h < 5) return 'Londres (02:00-05:00 NY)';
    if (h < 8) return 'Pre-NY / Londres tardia (05:00-08:00 NY)';
    if (h < 12) return 'Nueva York manana (08:00-12:00 NY)';
    if (h < 17) return 'Nueva York tarde (12:00-17:00 NY)';
    return 'Cierre / fuera de sesion (17:00-20:00 NY)';
  }

  function decimalsOf(candles) {
    let d = 0;
    candles.slice(-10).forEach((c) => { d = Math.max(d, (String(c.close).split('.')[1] || '').length); });
    return Math.min(Math.max(d, 2), 6);
  }

  // opts: { h1, macro, mid, trig, labels: {macro, mid, trig} }  (velas crudas de Twelve Data)
  // h1 se usa SIEMPRE para niveles diarios/sesiones; macro/mid/trig son las 3 temporalidades del analisis.
  function buildLevelsText(opts) {
    try {
      const { labels } = opts;
      const h1 = toNum(opts.h1), macro = toNum(opts.macro), mid = toNum(opts.mid), trig = toNum(opts.trig);
      if (!h1.length || !macro.length || !mid.length || !trig.length) return '';
      const dec = decimalsOf(opts.trig);
      const f = (n) => Number(n).toFixed(dec);
      const nowT = trig[trig.length - 1].t;
      const price = trig[trig.length - 1].c;
      const lines = [];
      const L = labels;

      const np = nyParts(nowT);
      const dias = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
      const wd = new Date(`${np.date}T12:00:00Z`).getUTCDay();
      lines.push(`Hora en Nueva York: ${dias[wd]} ${String(np.hour).padStart(2, '0')}:${String(np.minute).padStart(2, '0')}`);
      lines.push(`Precio actual (ultimo cierre ${L.trig}): ${f(price)}`);
      lines.push(`Sesion actual: ${sessionLabel(nowT)}`);

      const atrMacro = atr(macro), atrMid = atr(mid), atrTrig = atr(trig), atr1h = atr(h1);
      const af = (v) => (v ? f(v) : '-');
      lines.push(`ATR(14): ${L.macro}=${af(atrMacro)}, ${L.mid}=${af(atrMid)}, ${L.trig}=${af(atrTrig)}, 1H=${af(atr1h)}  (sirve para juzgar si un SL/TP es realista)`);

      // Rango de las ultimas 24 velas de 1H frente al ATR de 1H (valores bajos sugieren acumulacion)
      if (atr1h && h1.length >= 24) {
        const r24 = range(h1.slice(-24));
        lines.push(`Rango ultimas 24h (1H): ${f(r24.high - r24.low)} = ${((r24.high - r24.low) / atr1h).toFixed(1)} x ATR(1H) (un valor bajo sugiere acumulacion / mercado comprimido)`);
      }

      // Dias de trading (con 1H)
      const byDay = {};
      h1.forEach((c) => { const d = tradingDay(c.t); (byDay[d] = byDay[d] || []).push(c); });
      const days = Object.keys(byDay).sort();
      const curDay = tradingDay(nowT);
      const prevDays = days.filter((d) => d < curDay && byDay[d].length >= 12);
      const today = byDay[curDay] ? range(byDay[curDay]) : null;
      if (prevDays.length) {
        const pd = range(byDay[prevDays[prevDays.length - 1]]);
        lines.push(`Dia previo: maximo ${f(pd.high)}, minimo ${f(pd.low)}`);
      }
      if (today) lines.push(`Dia actual hasta ahora: maximo ${f(today.high)}, minimo ${f(today.low)}`);
      const last5 = prevDays.slice(-5);
      if (last5.length >= 3) {
        const r5 = range([].concat(...last5.map((d) => byDay[d])));
        lines.push(`Ultimos ${last5.length} dias previos: maximo ${f(r5.high)}, minimo ${f(r5.low)}`);
      }

      // Sesiones del dia de trading actual (1H, hora de NY)
      const todays = byDay[curDay] || [];
      const asia = range(todays.filter((c) => { const h = nyParts(c.t).hour; return h >= 20 && h <= 23; }));
      const lon = range(todays.filter((c) => { const h = nyParts(c.t).hour; return h >= 2 && h <= 4; }));
      if (asia) lines.push(`Rango Asia (20:00-00:00 NY): maximo ${f(asia.high)}, minimo ${f(asia.low)}`);
      if (lon) lines.push(`Rango Londres (02:00-05:00 NY) hasta ahora: maximo ${f(lon.high)}, minimo ${f(lon.low)}`);

      // Swings y niveles testeados varias veces en el marco macro (paso 1 del metodo)
      const fmtSw = (arr) => arr.slice(-3).map((s) => f(s.price)).join(', ') || '-';
      const sMacro = swings(macro), sMid = swings(mid);
      const tol = 0.3 * (atrMacro || 0);
      const lvTxt = (arr) => testedLevels(arr, tol).map((x) => `${f(x.price)} (${x.count} toques)`).join(' | ') || 'ninguno';
      lines.push(`Niveles testeados 2+ veces en ${L.macro} - maximos: ${lvTxt(sMacro.highs)}`);
      lines.push(`Niveles testeados 2+ veces en ${L.macro} - minimos: ${lvTxt(sMacro.lows)}`);
      lines.push(`Swing highs ${L.macro} (de mas viejo a mas nuevo): ${fmtSw(sMacro.highs)}`);
      lines.push(`Swing lows ${L.macro}: ${fmtSw(sMacro.lows)}`);
      lines.push(`Swing highs ${L.mid}: ${fmtSw(sMid.highs)}`);
      lines.push(`Swing lows ${L.mid}: ${fmtSw(sMid.lows)}`);

      // FVG y order blocks (macro y medio)
      const gapTxt = (gaps, dir) => gaps.filter((g) => g.dir === dir).slice(-3).map((g) => `${f(g.bottom)}-${f(g.top)}`).join(' | ') || 'ninguno';
      const obTxt = (obs, dir) => obs.filter((o) => o.dir === dir).slice(-2).map((o) => `${f(o.bottom)}-${f(o.top)}`).join(' | ') || 'ninguno';
      [[L.macro, macro, atrMacro], [L.mid, mid, atrMid]].forEach(([name, cs, a]) => {
        const gaps = fvgs(cs, (a || 0) * 0.25);
        const obs = orderBlocks(cs, a);
        lines.push(`FVG ${name} alcistas sin rellenar (parte abierta): ${gapTxt(gaps, 'alcista')}`);
        lines.push(`FVG ${name} bajistas sin rellenar (parte abierta): ${gapTxt(gaps, 'bajista')}`);
        lines.push(`Order blocks ${name} candidatos alcistas no mitigados: ${obTxt(obs, 'alcista')}`);
        lines.push(`Order blocks ${name} candidatos bajistas no mitigados: ${obTxt(obs, 'bajista')}`);
      });

      const st = marketState(opts.macro, opts.mid);
      if (st) {
        lines.push(`ESTADO DEL MERCADO (codigo): ${st.accumulation ? 'ACUMULACION / rango comprimido' : 'con movimiento'} (rango ultimas 16 velas ${L.macro} = ${st.rangeAtr.toFixed(1)} x ATR, ${st.disp} desplazamientos recientes)`);
        if (st.level) {
          lines.push(`Zona testeada mas cercana: ${f(st.level.price)} (${st.level.type}, ${st.level.count} toques), a ${st.level.dist.toFixed(2)} ATR(${L.macro}) del precio`);
          lines.push(`Patron de llegada al nivel (${L.mid}, ${st.touches} velas tocando la zona): ${PATTERN_TXT[st.pattern]}`);
        }
      }
      return `=== NIVELES CALCULADOS POR CODIGO (reglas fijas, datos objetivos) ===\n${lines.join('\n')}`;
    } catch (e) {
      return ''; // si algo falla, el analisis sigue sin esta seccion
    }
  }

  const api = { buildLevelsText, testedLevels, atr, swings, fvgs, orderBlocks, tradingDay, toNum, parseT, sessionLabel, closedOnly, marketState, confirmation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SMCLevels = api;
})(typeof window !== 'undefined' ? window : globalThis);
