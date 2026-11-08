/* Educational chart read. Indicators are computed here.
   The browser calls /api/analyze first (Yahoo proxy + optional LLM).
   If that route is missing, it loads public candles itself and writes
   the rule-based summary. No API key is ever read in the browser. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LiveDeskAnalyze = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  "use strict";

  var INTERVALS = {
    "60": { label: "1h", ms: 60 * 60 * 1000 },
    "240": { label: "4h", ms: 4 * 60 * 60 * 1000 },
    D: { label: "1D", ms: 24 * 60 * 60 * 1000 },
    W: { label: "1W", ms: 7 * 24 * 60 * 60 * 1000 }
  };

  var DISCLAIMER = "Educational only — not financial advice. This describes recent price data. It is not a recommendation to buy or sell, and LiveDesk does not place trades.";

  var EX_SUF = { TO: 1, V: 1, CN: 1, NE: 1, L: 1, AX: 1, HK: 1, DE: 1, PA: 1, SW: 1, T: 1 };
  var TV_SUF = { TSX: "TO", TSXV: "V", CSE: "CN", NEO: "NE", LSE: "L", ASX: "AX", HKEX: "HK", XETR: "DE", EURONEXT: "PA", SIX: "SW", TSE: "T" };

  var SOURCE_LABEL = {
    binance: "Binance public candles",
    cryptocom: "Crypto.com public candles",
    yahoo: "Yahoo Finance chart",
    cnbc: "CNBC chart feed"
  };

  var ticket = 0;

  function chartApi() {
    if (typeof LiveDeskChart !== "undefined" && LiveDeskChart.resolveSymbol) return LiveDeskChart;
    if (typeof require === "function") return require("./chart.js").LiveDeskChart;
    return null;
  }

  function fail(message) {
    var err = new Error(message);
    err.expose = true;
    return err;
  }

  function fmt(n) {
    if (n == null || !isFinite(n)) return "—";
    var a = Math.abs(n);
    if (a >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var digits = 2;
    if (a < 1) digits = 4;
    if (a < 0.01) digits = 6;
    if (a < 0.0001) digits = 8;
    return n.toFixed(digits);
  }

  function fmtPct(n) {
    if (n == null || !isFinite(n)) return "—";
    return (n > 0 ? "+" : "") + n.toFixed(1) + "%";
  }

  function fmtTime(ms) {
    try {
      return new Date(ms).toLocaleString("en-CA", {
        timeZone: "America/Toronto",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }) + " ET";
    } catch (e) {
      return new Date(ms).toISOString();
    }
  }

  function lastDefined(arr) {
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] != null && isFinite(arr[i])) return arr[i];
    }
    return null;
  }

  function prevDefined(arr) {
    var seen = 0;
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] != null && isFinite(arr[i])) {
        seen++;
        if (seen === 2) return arr[i];
      }
    }
    return null;
  }

  function ema(values, period) {
    var out = new Array(values.length);
    var i;
    for (i = 0; i < out.length; i++) out[i] = null;
    if (values.length < period || period < 1) return out;
    var sum = 0;
    for (i = 0; i < period; i++) sum += values[i];
    var prev = sum / period;
    var k = 2 / (period + 1);
    out[period - 1] = prev;
    for (i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function rsi(values, period) {
    var out = new Array(values.length);
    var i;
    for (i = 0; i < out.length; i++) out[i] = null;
    if (values.length <= period) return out;
    var gain = 0;
    var loss = 0;
    for (i = 1; i <= period; i++) {
      var d = values[i] - values[i - 1];
      if (d >= 0) gain += d;
      else loss -= d;
    }
    var avgG = gain / period;
    var avgL = loss / period;
    out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (i = period + 1; i < values.length; i++) {
      var ch = values[i] - values[i - 1];
      var g = ch > 0 ? ch : 0;
      var l = ch < 0 ? -ch : 0;
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return out;
  }

  function macd(values) {
    var fast = ema(values, 12);
    var slow = ema(values, 26);
    var line = values.map(function (_, i) {
      if (fast[i] == null || slow[i] == null) return null;
      return fast[i] - slow[i];
    });
    var compact = [];
    var index = [];
    for (var i = 0; i < line.length; i++) {
      if (line[i] != null) {
        compact.push(line[i]);
        index.push(i);
      }
    }
    var sigCompact = ema(compact, 9);
    var signal = values.map(function () { return null; });
    var hist = values.map(function () { return null; });
    for (var j = 0; j < index.length; j++) {
      signal[index[j]] = sigCompact[j];
      if (sigCompact[j] != null) hist[index[j]] = line[index[j]] - sigCompact[j];
    }
    return { line: line, signal: signal, hist: hist };
  }

  function resample(candles, bucketMs) {
    var out = [];
    var cur = null;
    var bucket = null;
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var b = Math.floor(c.t / bucketMs) * bucketMs;
      if (!cur || b !== bucket) {
        if (cur) out.push(cur);
        bucket = b;
        cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 };
      } else {
        if (c.h > cur.h) cur.h = c.h;
        if (c.l < cur.l) cur.l = c.l;
        cur.c = c.c;
        cur.v += c.v || 0;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function dedupe(candles) {
    var sorted = candles.slice().sort(function (a, b) { return a.t - b.t; });
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      var c = sorted[i];
      if (!isFinite(c.t) || !isFinite(c.o) || !isFinite(c.h) || !isFinite(c.l) || !isFinite(c.c)) continue;
      if (c.h < c.l) continue;
      if (out.length && out[out.length - 1].t === c.t) out[out.length - 1] = c;
      else out.push({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 });
    }
    return out;
  }

  function etMinutes(ms) {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(ms));
    var hour = 0;
    var minute = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "hour") hour = Number(parts[i].value);
      if (parts[i].type === "minute") minute = Number(parts[i].value);
    }
    if (hour === 24) hour = 0;
    return hour * 60 + minute;
  }

  function inExtendedSession(ms) {
    var m = etMinutes(ms);
    return m >= 8 * 60 && m < 18 * 60;
  }

  function cluster(levels, tol) {
    var sorted = levels.slice().sort(function (a, b) { return a - b; });
    var groups = [];
    for (var i = 0; i < sorted.length; i++) {
      var x = sorted[i];
      var g = groups[groups.length - 1];
      if (!g || Math.abs(x - g.mean) / g.mean > tol) groups.push({ sum: x, n: 1, mean: x });
      else {
        g.sum += x;
        g.n += 1;
        g.mean = g.sum / g.n;
      }
    }
    return groups.map(function (g) { return g.mean; });
  }

  function supportResistance(candles) {
    var left = candles.length > 120 ? 3 : 2;
    var highs = [];
    var lows = [];
    var i, j;
    for (i = left; i < candles.length - left; i++) {
      var hi = true;
      var lo = true;
      for (j = 1; j <= left; j++) {
        if (!(candles[i].h > candles[i - j].h && candles[i].h >= candles[i + j].h)) hi = false;
        if (!(candles[i].l < candles[i - j].l && candles[i].l <= candles[i + j].l)) lo = false;
      }
      if (hi) highs.push(candles[i].h);
      if (lo) lows.push(candles[i].l);
    }
    var price = candles[candles.length - 1].c;
    var resistance = cluster(highs.slice(-12), 0.006).filter(function (x) { return x > price * 1.001; }).sort(function (a, b) { return a - b; });
    var support = cluster(lows.slice(-12), 0.006).filter(function (x) { return x < price * 0.999; }).sort(function (a, b) { return b - a; });
    var recent = candles.slice(-40);
    if (!support.length && recent.length) {
      var lo = Math.min.apply(null, recent.map(function (c) { return c.l; }));
      if (lo < price) support = [lo];
    }
    if (!resistance.length && recent.length) {
      var hi = Math.max.apply(null, recent.map(function (c) { return c.h; }));
      if (hi > price) resistance = [hi];
    }
    return { support: support.slice(0, 2), resistance: resistance.slice(0, 2) };
  }

  function describeMacd(m) {
    var hist = lastDefined(m.hist);
    var prev = prevDefined(m.hist);
    var line = lastDefined(m.line);
    var signal = lastDefined(m.signal);
    if (hist == null || line == null || signal == null) {
      return { text: "Not enough bars for MACD (12, 26, 9).", tone: "missing" };
    }
    var rising = prev == null ? hist > 0 : hist > prev;
    if (hist > 0 && rising) return { text: "MACD is above its signal line and the histogram is rising.", tone: "rising" };
    if (hist > 0) return { text: "MACD is above its signal line, but the histogram is fading.", tone: "fading" };
    if (hist < 0 && prev != null && hist < prev) return { text: "MACD is below its signal line and the histogram is falling.", tone: "falling" };
    if (hist < 0) return { text: "MACD is below its signal line.", tone: "falling" };
    return { text: "MACD is flat against its signal line.", tone: "flat" };
  }

  function describeRsi(value) {
    if (value == null) return "Not enough bars for RSI(14).";
    var n = value.toFixed(1);
    if (value >= 70) return "RSI(14) is " + n + ", stretched to the upside.";
    if (value <= 30) return "RSI(14) is " + n + ", washed out.";
    if (value >= 55) return "RSI(14) is " + n + ", on the strong side of neutral.";
    if (value <= 45) return "RSI(14) is " + n + ", on the soft side of neutral.";
    return "RSI(14) is " + n + ", neutral.";
  }

  function volumeRead(candles, intervalMs) {
    if (candles.length < 30) return "Volume is hard to read on this short sample.";
    var end = candles.length - 1;
    var forming = Date.now() < candles[end].t + intervalMs;
    if (forming && end > 0) end -= 1;
    var bar = candles[end];
    var start = Math.max(0, end - 20);
    var prev = candles.slice(start, end);
    if (!prev.length) return "Not enough bars for a volume read.";
    var avg = 0;
    for (var i = 0; i < prev.length; i++) avg += prev[i].v;
    avg /= prev.length;
    if (!avg) return "Recent bars did not report volume.";
    var ratio = bar.v / avg;
    var tone = ratio >= 1.3 ? "heavy" : ratio <= 0.75 ? "light" : "about average";
    var which = forming ? "The last completed bar" : "The latest bar";
    var dir = bar.c >= bar.o ? "up" : "down";
    return which + " was " + tone + " (" + ratio.toFixed(1) + "× the prior 20-bar average) and closed " + dir + ".";
  }

  function trendOf(closes, ema20, ema50) {
    var price = closes[closes.length - 1];
    var e20 = lastDefined(ema20);
    var e50 = lastDefined(ema50);
    if (e20 == null) {
      return { label: "Unclear", detail: "Not enough bars for the 20-period EMA." };
    }
    if (e50 != null && price > e20 && e20 > e50) {
      return { label: "Uptrend", detail: "Price is above the EMA20, and the EMA20 is above the EMA50." };
    }
    if (e50 != null && price < e20 && e20 < e50) {
      return { label: "Downtrend", detail: "Price is below the EMA20, and the EMA20 is below the EMA50." };
    }
    if (e50 == null && price > e20) {
      return { label: "Up", detail: "Price is above the EMA20. There are not enough bars for an EMA50." };
    }
    if (e50 == null && price < e20) {
      return { label: "Down", detail: "Price is below the EMA20. There are not enough bars for an EMA50." };
    }
    if (price >= e20) {
      return { label: "Mixed", detail: "Price is above the EMA20, but the EMA20 is not above the EMA50." };
    }
    return { label: "Mixed", detail: "Price is below the EMA20, but the longer averages are not stacked lower." };
  }

  function medianStep(candles) {
  if (!candles || candles.length < 2) return 0;
  var steps = [];
  for (var i = 1; i < candles.length; i++) steps.push(candles[i].t - candles[i - 1].t);
  steps.sort(function (a, b) { return a - b; });
  return steps[Math.floor(steps.length / 2)];
}

function dayKey(ms, mode) {
  if (mode === "stock") {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date(ms));
    } catch (e) { /* fall through */ }
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function collapseDays(candles, mode) {
  var days = [];
  var cur = null;
  var key = null;
  for (var i = 0; i < candles.length; i++) {
    var c = candles[i];
    var k = dayKey(c.t, mode);
    if (k !== key) {
      if (cur) days.push(cur);
      key = k;
      cur = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 };
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
      cur.v += c.v || 0;
    }
  }
  if (cur) days.push(cur);
  return days;
}

function dayStats(daily) {
    if (!daily || !daily.length) return null;
    var today = daily[daily.length - 1];
    var prev = daily.length > 1 ? daily[daily.length - 2] : null;
    var raw = prev && prev.c ? ((today.c - prev.c) / prev.c) * 100 : null;
    var rounded = raw == null ? null : Math.round(raw * 10) / 10;
    return {
      open: today.o,
      high: today.h,
      low: today.l,
      close: today.c,
      prevClose: prev ? prev.c : null,
      changePct: rounded
    };
  }

  function btcRegime(btcDaily) {
    if (!btcDaily || btcDaily.length < 50) {
      return { available: false, weak: null, close: null, ema50: null, note: "BTC daily history was too short to judge the EMA50." };
    }
    var closes = btcDaily.map(function (c) { return c.c; });
    var e50 = lastDefined(ema(closes, 50));
    var close = closes[closes.length - 1];
    if (e50 == null) {
      return { available: false, weak: null, close: close, ema50: null, note: "BTC EMA50 was unavailable." };
    }
    var weak = close < e50;
    return {
      available: true,
      weak: weak,
      close: close,
      ema50: e50,
      note: weak
        ? "BTC is weak: its daily close (" + fmt(close) + ") is below the EMA50 (" + fmt(e50) + ")."
        : "BTC is above its daily EMA50 (" + fmt(close) + " vs " + fmt(e50) + ")."
    };
  }

  function uniqueLevels(list, floor) {
    var sorted = list.filter(function (x) { return isFinite(x) && x > floor; }).sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      var x = sorted[i];
      if (out.length && Math.abs(x - out[out.length - 1]) / x < 0.002) continue;
      out.push(x);
      if (out.length === 3) break;
    }
    return out;
  }

  function confidenceLabel(score) {
    if (score < 40) return "Low";
    if (score < 62) return "Moderate";
    return "Moderate-high";
  }

  function analyzeCandles(input) {
    var candles = dedupe(input.candles || []);
    var dailyIn = dedupe(input.daily && input.daily.length ? input.daily : []);
    var daily = medianStep(dailyIn) >= 20 * 60 * 60 * 1000 ? dailyIn : collapseDays(candles, input.mode);
    if (candles.length < 8) throw fail("Not enough candles to read " + (input.label || "that symbol") + ".");
    var closes = candles.map(function (c) { return c.c; });
    var price = closes[closes.length - 1];
    var ema20a = ema(closes, 20);
    var ema50a = ema(closes, 50);
    var rsiA = rsi(closes, 14);
    var macdA = macd(closes);
    var trend = trendOf(closes, ema20a, ema50a);
    var rsiNow = lastDefined(rsiA);
    var macdInfo = describeMacd(macdA);
    var volText = volumeRead(candles, input.intervalMs || INTERVALS["60"].ms);
    var sr = supportResistance(candles);
    var day = dayStats(daily);
    var dayHigh = day && isFinite(day.high) ? day.high : candles[candles.length - 1].h;
    var entryLow = dayHigh * 0.95;
    var entryHigh = dayHigh * 0.97;
    var underEntry = sr.support.filter(function (x) { return x < entryLow; });
    var anchor = underEntry.length ? underEntry[0] : null;
    var invalidation = entryLow * 0.995;
    if (anchor != null) {
      var gap = (entryLow - anchor) / entryLow;
      invalidation = gap <= 0.06 ? anchor * 0.997 : entryLow * 0.99;
    }
    if (!(invalidation < entryLow)) invalidation = entryLow * 0.99;
    var entryMid = (entryLow + entryHigh) / 2;
    var risk = entryMid - invalidation;
    var aboveHigh = sr.resistance.filter(function (x) { return x > dayHigh; });
    var targetList = uniqueLevels([
      dayHigh,
      aboveHigh.length ? aboveHigh[0] : null,
      aboveHigh.length > 1 ? aboveHigh[1] : null,
      risk > 0 && entryMid + 2 * risk > dayHigh ? entryMid + 2 * risk : null,
      aboveHigh.length ? null : dayHigh * 1.03
    ], entryHigh);

    var dontChase = !!(input.mode === "crypto" || input.mode === "stock") && day && day.changePct != null && day.changePct > 8;
    var down = trend.label === "Downtrend" || trend.label === "Down";
    var inZone = price >= entryLow && price <= entryHigh;
    var bias;
    if (dontChase) bias = "dont_chase";
    else if (down) bias = "stand_aside";
    else if (inZone) bias = "in_zone";
    else if (price > entryHigh) bias = "wait";
    else bias = "deeper";

    var btc = input.mode === "crypto" ? btcRegime(input.btcDaily) : null;

    var score = 50;
    if (trend.label === "Uptrend") score += 10;
    else if (down) score -= 12;
    else if (trend.label === "Mixed" || trend.label === "Unclear") score -= 4;
    if (rsiNow != null) {
      if (rsiNow >= 40 && rsiNow <= 60) score += 8;
      else if (rsiNow > 70) score -= 12;
      else if (rsiNow < 30) score -= 8;
    }
    if (macdInfo.tone === "rising") score += 6;
    if (macdInfo.tone === "falling") score -= 6;
    if (bias === "dont_chase") score -= 16;
    if (bias === "in_zone" && trend.label === "Uptrend") score += 8;
    if (bias === "deeper") score -= 6;
    if (bias === "stand_aside") score -= 6;
    if (btc && btc.weak) score -= 10;
    if (candles.length < 40) score -= 8;
    score = Math.max(12, Math.min(82, Math.round(score)));

    var dailySnap = null;
    if (input.interval !== "D" && daily.length >= 30 && medianStep(daily) >= 20 * 60 * 60 * 1000) {
      var dCloses = daily.map(function (c) { return c.c; });
      var dTrend = trendOf(dCloses, ema(dCloses, 20), ema(dCloses, 50));
      var dRsi = lastDefined(rsi(dCloses, 14));
      dailySnap = {
        trend: dTrend,
        rsi: dRsi,
        ema20: lastDefined(ema(dCloses, 20)),
        ema50: lastDefined(ema(dCloses, 50))
      };
    }

    var dayWord = input.mode === "crypto" ? "UTC day" : "session";
    var headline;
    if (bias === "dont_chase") headline = "Don't chase — up " + fmtPct(day.changePct) + " on the " + dayWord;
    else if (bias === "in_zone") headline = "Price is inside the 3–5% pullback zone";
    else if (bias === "stand_aside") headline = "Downtrend — this read stands aside";
    else if (bias === "deeper") headline = "Deeper than a 5% pullback from the day's high";
    else headline = "Wait for a 3–5% pullback from the day's high";

    var analysis = {
      ok: true,
      placesTrades: false,
      disclaimer: DISCLAIMER,
      symbol: input.tv || input.label,
      label: input.label,
      tv: input.tv || input.label,
      mode: input.mode,
      interval: input.interval,
      intervalLabel: input.intervalLabel,
      source: input.source,
      sourceLabel: SOURCE_LABEL[input.source] || input.source || "candles",
      engine: input.engine || "browser",
      narrativeSource: "rules",
      historyNote: input.historyNote || "",
      bars: candles.length,
      asOf: candles[candles.length - 1].t,
      price: price,
      headline: headline,
      trend: trend,
      levels: sr,
      indicators: {
        rsi: rsiNow,
        rsiText: describeRsi(rsiNow),
        ema20: lastDefined(ema20a),
        ema50: lastDefined(ema50a),
        macd: macdInfo.text,
        macdTone: macdInfo.tone,
        volume: volText
      },
      day: day,
      plan: {
        bias: bias,
        dontChase: dontChase,
        dayChangePct: day ? day.changePct : null,
        dayHigh: dayHigh,
        entryLow: entryLow,
        entryHigh: entryHigh,
        invalidation: invalidation,
        targets: targetList,
        confidence: score,
        confidenceLabel: confidenceLabel(score)
      },
      btc: btc,
      dailyContext: dailySnap
    };
    analysis.summary = writeSummary(analysis);
    return analysis;
  }

  function writeSummary(a) {
    var p = a.plan;
    var parts = [];
    var ind = a.indicators;
    var emaBits = "EMA20 is " + fmt(ind.ema20);
    emaBits += ind.ema50 == null ? ". EMA50 needs more bars." : " and EMA50 is " + fmt(ind.ema50) + ".";
    parts.push(
      a.label + " on the " + a.intervalLabel + " chart: " + a.trend.detail + " " +
      ind.rsiText + " " + emaBits + " " + ind.macd + " " + ind.volume
    );

    var dayWord = a.mode === "crypto" ? "UTC day" : "session";
    var dayLine;
    if (a.day && a.day.changePct != null) {
      dayLine = "Versus the prior close, the latest " + dayWord + " is " + fmtPct(a.day.changePct) + ". Day high is " + fmt(p.dayHigh) + ".";
    } else {
      dayLine = "Day high is " + fmt(p.dayHigh) + ".";
    }
    var zone = "The preferred entry is a 3–5% pullback from that high, from " + fmt(p.entryLow) + " to " + fmt(p.entryHigh) + ".";
    var bias;
    if (p.bias === "dont_chase") {
      bias = "Don't chase. " + a.label + " is up more than 8% on the " + dayWord + ", so this read waits for the pullback instead of paying the spike.";
    } else if (p.bias === "stand_aside") {
      bias = "The trend is down, so this read stands aside. The pullback zone is still marked, but a dip in a downtrend is not treated as an entry.";
    } else if (p.bias === "in_zone") {
      bias = "Last price (" + fmt(a.price) + ") is already inside that zone.";
    } else if (p.bias === "wait") {
      bias = "Last price (" + fmt(a.price) + ") is still above that zone, so the read is to wait rather than pay up.";
    } else {
      bias = "Last price (" + fmt(a.price) + ") is already more than 5% under the day's high. The preferred zone is overhead; this is not a signal to buy a breakdown.";
    }
    parts.push(dayLine + " " + zone + " " + bias);

    var sup = a.levels.support.length ? " Nearby support: " + a.levels.support.map(fmt).join(", ") + "." : "";
    var res = a.levels.resistance.length ? " Nearby resistance: " + a.levels.resistance.map(fmt).join(", ") + "." : "";
    var tgt = p.targets.length ? " If that zone holds, targets are " + p.targets.map(fmt).join(", ") + "." : "";
    parts.push(
      "Invalidation for the pullback idea is a close under " + fmt(p.invalidation) + "." + sup + res + tgt +
      " Confidence is " + p.confidenceLabel + " (" + p.confidence + "/100). That score only measures how these rules line up. It is not a probability of profit."
    );

    if (a.dailyContext && (a.bars < 160 || ind.ema50 == null)) {
      var dc = a.dailyContext;
      parts.push(
        "Daily context from the longer sample: " + dc.trend.detail + " " +
        (dc.rsi == null ? "" : "Daily RSI(14) is " + dc.rsi.toFixed(1) + ". ") +
        (dc.ema50 == null ? "" : "Daily EMA50 is " + fmt(dc.ema50) + ".")
      );
    }
    if (a.btc) parts.push(a.btc.note + (a.btc.weak ? " That lowers confidence in long crypto setups." : ""));
    if (a.historyNote) parts.push(a.historyNote);
    parts.push("Educational only, not financial advice. LiveDesk does not place trades.");
    return parts.join("\n\n");
  }

  function resolveMarket(query, mode) {
    var api = chartApi();
    if (!api) throw fail("Chart symbols are not loaded.");
    var tv = api.resolveSymbol(query, mode === "stock" ? "stock" : "crypto");
    if (!tv) return null;
    if (tv.indexOf("BINANCE:") === 0) {
      var pair = tv.slice("BINANCE:".length);
      var base = pair.slice(-4) === "USDT" ? pair.slice(0, -4) : pair;
      return { kind: "crypto", tv: tv, pair: pair, base: base, label: base, yahoo: null, cnbc: null };
    }
    var yahoo = tv;
    var colon = tv.indexOf(":");
    if (colon > 0) {
      var ex = tv.slice(0, colon);
      var ticker = tv.slice(colon + 1);
      yahoo = TV_SUF[ex] ? ticker + "." + TV_SUF[ex] : ticker;
    }
    return { kind: "stock", tv: tv, pair: null, base: yahoo, label: yahoo, yahoo: toYahoo(yahoo), cnbc: yahoo };
  }

  function toYahoo(symbol) {
    var dot = symbol.lastIndexOf(".");
    if (dot > 0) {
      var suf = symbol.slice(dot + 1);
      if (!EX_SUF[suf] && suf.length === 1) return symbol.slice(0, dot) + "-" + suf;
    }
    return symbol;
  }

  function getJSON(url, ms) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 12000);
    var init = { cache: "no-store" };
    if (ctrl) init.signal = ctrl.signal;
    if (typeof window === "undefined") {
      init.headers = { accept: "application/json", "user-agent": "Mozilla/5.0" };
    }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (e) { body = null; }
        return { ok: res.ok, status: res.status, body: body };
      });
    }).then(function (out) {
      clearTimeout(timer);
      return out;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function binanceCandles(pair, interval, limit) {
    var map = { "60": "1h", "240": "4h", D: "1d", W: "1w" };
    var url = "https://data-api.binance.vision/api/v3/klines?symbol=" + encodeURIComponent(pair) +
      "&interval=" + map[interval] + "&limit=" + (limit || 400);
    return getJSON(url).then(function (res) {
      if (!res.ok || !Array.isArray(res.body)) {
        var msg = res.body && res.body.msg;
        throw fail(msg || ("Binance has no candles for " + pair));
      }
      return res.body.map(function (k) {
        return { t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) };
      });
    });
  }

  function cryptoComCandles(base, interval) {
    var map = { "60": "1h", "240": "4h", D: "1D", W: "1W" };
    var url = "https://api.crypto.com/exchange/v1/public/get-candlestick?instrument_name=" +
      encodeURIComponent(base + "_USDT") + "&timeframe=" + map[interval] + "&count=300";
    return getJSON(url).then(function (res) {
      var rows = res.body && res.body.result && res.body.result.data;
      if (!res.ok || !rows || !rows.length) throw fail("Crypto.com has no candles for " + base);
      return rows.map(function (r) {
        return { t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) };
      });
    });
  }

  function cryptoCandles(market, interval) {
    return binanceCandles(market.pair, interval, 400).then(function (candles) {
      if (!candles.length) throw fail("empty");
      return { candles: candles, source: "binance" };
    }).catch(function () {
      return cryptoComCandles(market.base, interval).then(function (candles) {
        return { candles: candles, source: "cryptocom" };
      });
    });
  }

  function cnbcRaw(symbol, range) {
    var url = "https://ts-api.cnbc.com/harmony/app/charts/" + range + ".json?symbol=" + encodeURIComponent(symbol);
    return getJSON(url).then(function (res) {
      var bars = res.body && res.body.barData && res.body.barData.priceBars;
      if (!bars || !bars.length) {
        var msg = res.body && res.body.statusMessage;
        throw fail(msg || ("No stock candles for " + symbol));
      }
      return bars.map(function (b) {
        return {
          t: Number(b.tradeTimeinMills),
          o: Number(b.open),
          h: Number(b.high),
          l: Number(b.low),
          c: Number(b.close),
          v: Number(b.volume) || 0
        };
      });
    });
  }

  function stockBrowser(market, interval) {
    var range = interval === "W" ? "5Y" : "1Y";
    if (interval === "60" || interval === "240") range = "5D";
    var dailyP = interval === "D" ? null : cnbcRaw(market.cnbc, "1Y");
    return Promise.all([cnbcRaw(market.cnbc, range), dailyP]).then(function (pair) {
      var raw = dedupe(pair[0]);
      var daily = pair[1] ? dedupe(pair[1]) : raw;
      var candles = raw;
      var historyNote = "";
      if (interval === "60" || interval === "240") {
        var session = raw.filter(function (c) { return inExtendedSession(c.t); });
        var used = session.length > 20 ? session : raw;
        candles = resample(used, interval === "60" ? INTERVALS["60"].ms : INTERVALS["240"].ms);
        historyNote = interval === "60"
          ? "Hourly bars are built from about a week of 5-minute prints between 8:00am and 6:00pm ET. A server-side Yahoo fetch has a longer regular-session sample when /api/analyze is available."
          : "4h bars are built from about a week of 5-minute prints, so the slower averages may be missing. Daily context is included. A server-side Yahoo fetch has a longer sample when /api/analyze is available.";
      }
      return { candles: candles, daily: daily, source: "cnbc", historyNote: historyNote };
    });
  }

  function yahooCandles(symbol, yahooInterval, range) {
    var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) +
      "?interval=" + yahooInterval + "&range=" + range + "&includePrePost=false";
    return getJSON(url, 15000).then(function (res) {
      var result = res.body && res.body.chart && res.body.chart.result && res.body.chart.result[0];
      if (!res.ok || !result || !result.timestamp) {
        var desc = res.body && res.body.chart && res.body.chart.error && res.body.chart.error.description;
        throw fail(desc || ("No Yahoo candles for " + symbol));
      }
      var quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
      if (!quote) throw fail("Yahoo returned no prices for " + symbol);
      var out = [];
      for (var i = 0; i < result.timestamp.length; i++) {
        if (quote.open[i] == null || quote.high[i] == null || quote.low[i] == null || quote.close[i] == null) continue;
        out.push({
          t: result.timestamp[i] * 1000,
          o: quote.open[i],
          h: quote.high[i],
          l: quote.low[i],
          c: quote.close[i],
          v: quote.volume[i] || 0
        });
      }
      if (!out.length) throw fail("Yahoo returned no prices for " + symbol);
      return out;
    });
  }

  function stockServer(market, interval) {
    var spec = interval === "60" ? ["1h", "60d"] : interval === "240" ? ["1h", "120d"] : interval === "W" ? ["1wk", "10y"] : ["1d", "5y"];
    var seriesP = yahooCandles(market.yahoo, spec[0], spec[1]).catch(function () {
      if (interval === "240") return yahooCandles(market.yahoo, "1h", "60d");
      throw fail("No Yahoo candles for " + market.label);
    });
    var dailyP = interval === "D" ? null : yahooCandles(market.yahoo, "1d", "2y");
    return Promise.all([seriesP, dailyP]).then(function (pair) {
      var candles = dedupe(pair[0]);
      var daily = pair[1] ? dedupe(pair[1]) : candles;
      var note = "";
      if (interval === "240") {
        candles = resample(candles, INTERVALS["240"].ms);
        note = "4h bars are aggregated from regular-session hourly Yahoo candles.";
      }
      return { candles: candles, daily: daily, source: "yahoo", historyNote: note };
    });
  }

  function loadPack(market, interval, transport) {
    if (market.kind === "crypto") {
      return Promise.all([
        cryptoCandles(market, interval),
        cryptoCandles(market, "D").catch(function () { return { candles: [], source: "" }; }),
        cryptoCandles({ pair: "BTCUSDT", base: "BTC" }, "D").catch(function () { return { candles: [], source: "" }; })
      ]).then(function (all) {
        var primary = all[0];
        return {
          candles: primary.candles,
          daily: all[1].candles && all[1].candles.length ? all[1].candles : primary.candles,
          btcDaily: all[2].candles || [],
          source: primary.source,
          historyNote: ""
        };
      }).catch(function () {
        throw fail("No crypto candles for " + market.label + ". If this is a stock, switch to Stock and try again.");
      });
    }
    var loader = transport === "server" ? stockServer : stockBrowser;
    return loader(market, interval).catch(function (err) {
      if (err && err.expose) throw err;
      throw fail("No stock candles for " + market.label + ". Check the ticker (AAPL, SHOP.TO) and try again.");
    });
  }

  function build(opts) {
    opts = opts || {};
    var mode = opts.mode === "stock" ? "stock" : "crypto";
    var interval = String(opts.interval || "60");
    if (!INTERVALS[interval]) return Promise.reject(fail("Choose 1h, 4h, 1D, or 1W."));
    var query = String(opts.query || "").trim();
    if (!query) return Promise.reject(fail("Type a coin or ticker first."));
    if (!/^[A-Za-z0-9.:_\-$]{1,32}$/.test(query)) {
      return Promise.reject(fail("Use a plain ticker such as PEPE, SOL, AAPL, or SHOP.TO."));
    }
    var market;
    try { market = resolveMarket(query, mode); }
    catch (err) { return Promise.reject(err); }
    if (!market) return Promise.reject(fail("Type a coin (BTC, PEPE) or a ticker (AAPL, SHOP.TO)."));
    var transport = opts.transport === "server" ? "server" : "browser";
    return loadPack(market, interval, transport).then(function (pack) {
      return analyzeCandles({
        candles: pack.candles,
        daily: pack.daily,
        btcDaily: pack.btcDaily,
        label: market.label,
        tv: market.tv,
        mode: market.kind,
        interval: interval,
        intervalLabel: INTERVALS[interval].label,
        intervalMs: INTERVALS[interval].ms,
        source: pack.source,
        engine: transport,
        historyNote: pack.historyNote
      });
    });
  }

  var apiOn = null;

  function serverApiEnabled() {
    if (apiOn != null) return Promise.resolve(apiOn);
    return fetch("/engine.json", { cache: "no-store" }).then(function (res) {
      if (!res.ok) return false;
      return res.json().then(function (body) { return !!(body && body.api); }).catch(function () { return false; });
    }).catch(function () { return false; }).then(function (on) {
      apiOn = on;
      return on;
    });
  }

  function run(opts) {
    var params = new URLSearchParams();
    params.set("q", String((opts && opts.query) || "").trim());
    params.set("mode", opts && opts.mode === "stock" ? "stock" : "crypto");
    params.set("interval", String((opts && opts.interval) || "60"));
    return serverApiEnabled().then(function (on) {
      if (!on) return build(Object.assign({}, opts, { transport: "browser" }));
      return fetch("/api/analyze?" + params.toString(), { cache: "no-store" }).then(function (res) {
        var ctype = res.headers.get("content-type") || "";
        if (!ctype.includes("json")) throw new Error("fallback");
        return res.json().then(function (body) {
          if (body && body.ok) return body;
          throw new Error("fallback");
        });
      }).catch(function () {
        return build(Object.assign({}, opts, { transport: "browser" }));
      });
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderLoading(panel, label) {
    if (!panel) return;
    panel.hidden = false;
    panel.replaceChildren();
    panel.appendChild(el("p", "an-loading", "Reading " + (label || "candles") + "…"));
  }

  function renderError(panel, message) {
    if (!panel) return;
    panel.hidden = false;
    panel.replaceChildren();
    panel.appendChild(el("p", "an-disclaimer", DISCLAIMER));
    panel.appendChild(el("p", "an-error", message || "Analysis failed."));
  }

  function addCell(grid, k, v) {
    var cell = el("div", "an-cell");
    cell.appendChild(el("span", "an-k", k));
    cell.appendChild(el("span", "an-v", v));
    grid.appendChild(cell);
  }

  function render(panel, a) {
    if (!panel) return;
    panel.hidden = false;
    panel.replaceChildren();
    var hide = el("button", "an-hide");
    hide.type = "button";
    hide.textContent = "Hide";
    hide.addEventListener("click", function () { panel.hidden = true; });

    var head = el("div", "an-head");
    var title = el("div", "an-title");
    title.appendChild(el("strong", null, a.label + " · " + a.tv));
    title.appendChild(el("span", "an-muted", "  " + a.intervalLabel));
    head.appendChild(title);
    var confClass = a.plan.confidence < 40 ? "low" : a.plan.confidence < 62 ? "mid" : "high";
    head.appendChild(el("span", "an-conf " + confClass, a.plan.confidenceLabel + " · " + a.plan.confidence + "/100"));
    head.appendChild(hide);
    panel.appendChild(head);

    panel.appendChild(el("p", "an-disclaimer", a.disclaimer || DISCLAIMER));
    panel.appendChild(el("p", "an-headline", a.headline || ""));
    if (a.plan && a.plan.dontChase) {
      panel.appendChild(el("p", "an-chase", "Don't chase. Up more than 8% on the day."));
    }

    String(a.summary || "").split(/\n\n+/).forEach(function (para) {
      if (para.trim()) panel.appendChild(el("p", "an-p", para.trim()));
    });

    var grid = el("div", "an-grid");
    addCell(grid, "Trend", a.trend ? a.trend.label : "—");
    addCell(grid, "RSI(14)", a.indicators && a.indicators.rsi != null ? a.indicators.rsi.toFixed(1) : "—");
    addCell(grid, "EMA20", a.indicators ? fmt(a.indicators.ema20) : "—");
    addCell(grid, "EMA50", a.indicators ? fmt(a.indicators.ema50) : "—");
    addCell(grid, "Day change", a.plan && a.plan.dayChangePct != null ? fmtPct(a.plan.dayChangePct) : "—");
    addCell(grid, "Day high", a.plan ? fmt(a.plan.dayHigh) : "—");
    addCell(grid, "Entry zone", a.plan ? fmt(a.plan.entryLow) + " – " + fmt(a.plan.entryHigh) : "—");
    addCell(grid, "Invalidation", a.plan ? fmt(a.plan.invalidation) : "—");
    addCell(grid, "Targets", a.plan && a.plan.targets && a.plan.targets.length ? a.plan.targets.map(fmt).join(" · ") : "—");
    addCell(grid, "Support", a.levels && a.levels.support.length ? a.levels.support.map(fmt).join(" · ") : "—");
    panel.appendChild(grid);

    var who = a.narrativeSource === "xai"
      ? "Narrative rewritten on the server with xAI. The key stays on the server."
      : a.narrativeSource === "openai"
        ? "Narrative rewritten on the server with OpenAI. The key stays on the server."
        : "Rule-based summary. No model key is used in the browser.";
    if (a.llmFallback) who = "The language model was unavailable, so this is the rule-based summary.";
    var foot = (a.sourceLabel || "Candles") + " · " + (a.bars || "?") + " bars · as of " + fmtTime(a.asOf) + ". " + who + " LiveDesk does not place trades.";
    panel.appendChild(el("p", "an-foot", foot));
  }

  function open(panel, opts, btn) {
    var my = ++ticket;
    var label = (opts && opts.query) ? String(opts.query).trim().toUpperCase() : "candles";
    if (btn) btn.disabled = true;
    renderLoading(panel, label);
    return run(opts).then(function (result) {
      if (my !== ticket) return result;
      render(panel, result);
      return result;
    }).catch(function (err) {
      if (my !== ticket) return;
      renderError(panel, err && err.message ? err.message : "Analysis failed.");
    }).then(function (result) {
      if (btn && my === ticket) btn.disabled = false;
      return result;
    });
  }

  return {
    INTERVALS: INTERVALS,
    DISCLAIMER: DISCLAIMER,
    fmt: fmt,
    ema: ema,
    rsi: rsi,
    macd: macd,
    resample: resample,
    resolveMarket: resolveMarket,
    analyzeCandles: analyzeCandles,
    build: build,
    run: run,
    render: render,
    renderLoading: renderLoading,
    renderError: renderError,
    open: open
  };
});
