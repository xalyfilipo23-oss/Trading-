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

  function buildLevelsText(c1hRaw, c15Raw, c5Raw) {
    try {
      const h1 = toNum(c1hRaw), m15 = toNum(c15Raw), m5 = toNum(c5Raw);
      if (!m5.length || !m15.length || !h1.length) return '';
      const dec = decimalsOf(c5Raw);
      const f = (n) => Number(n).toFixed(dec);
      const nowT = m5[m5.length - 1].t;
      const price = m5[m5.length - 1].c;
      const lines = [];

      const atr5 = atr(m5), atr15 = atr(m15), atr1h = atr(h1);
      lines.push(`Precio actual (ultimo cierre 5M): ${f(price)}`);
      lines.push(`Sesion actual: ${sessionLabel(nowT)}`);
      lines.push(`ATR(14): 5M=${atr5 ? f(atr5) : '-'}, 15M=${atr15 ? f(atr15) : '-'}, 1H=${atr1h ? f(atr1h) : '-'}  (sirve para juzgar si un SL/TP es realista)`);

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

      // Swings
      const fmtSw = (arr) => arr.slice(-3).map((s) => f(s.price)).join(', ') || '-';
      const s15 = swings(m15), s1h = swings(h1);
      lines.push(`Swing highs 15M (recientes, de mas viejo a mas nuevo): ${fmtSw(s15.highs)}`);
      lines.push(`Swing lows 15M: ${fmtSw(s15.lows)}`);
      lines.push(`Swing highs 1H: ${fmtSw(s1h.highs)}`);
      lines.push(`Swing lows 1H: ${fmtSw(s1h.lows)}`);

      // FVG y OB en 15M
      const gaps = fvgs(m15, (atr15 || 0) * 0.25);
      const gapTxt = (dir) => gaps.filter((g) => g.dir === dir).slice(-3).map((g) => `${f(g.bottom)}-${f(g.top)}`).join(' | ') || 'ninguno';
      lines.push(`FVG 15M alcistas sin rellenar (parte abierta): ${gapTxt('alcista')}`);
      lines.push(`FVG 15M bajistas sin rellenar (parte abierta): ${gapTxt('bajista')}`);
      const obs = orderBlocks(m15, atr15);
      const obTxt = (dir) => obs.filter((o) => o.dir === dir).slice(-2).map((o) => `${f(o.bottom)}-${f(o.top)}`).join(' | ') || 'ninguno';
      lines.push(`Order blocks 15M candidatos alcistas no mitigados: ${obTxt('alcista')}`);
      lines.push(`Order blocks 15M candidatos bajistas no mitigados: ${obTxt('bajista')}`);

      return `=== NIVELES CALCULADOS POR CODIGO (reglas fijas, datos objetivos) ===\n${lines.join('\n')}`;
    } catch (e) {
      return ''; // si algo falla, el analisis sigue sin esta seccion
    }
  }

  const api = { buildLevelsText, atr, swings, fvgs, orderBlocks, tradingDay, toNum, parseT, sessionLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SMCLevels = api;
})(typeof window !== 'undefined' ? window : globalThis);
