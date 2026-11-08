"use strict";

const { build } = require("../public/analyze.js");

const cases = [
  ["browser", "PEPE", "crypto", "60"],
  ["browser", "SOL", "crypto", "240"],
  ["browser", "AAPL", "stock", "D"],
  ["browser", "AAPL", "stock", "60"],
  ["browser", "AAPL", "stock", "240"],
  ["browser", "SHOP.TO", "stock", "D"],
  ["server", "AAPL", "stock", "60"],
  ["server", "AAPL", "stock", "240"],
  ["server", "SHOP.TO", "stock", "D"],
  ["server", "PEPE", "crypto", "60"],
  ["server", "SOL", "crypto", "D"]
];

(async function () {
  let failed = 0;
  for (const row of cases) {
    const transport = row[0];
    const query = row[1];
    const mode = row[2];
    const interval = row[3];
    try {
      const a = await build({ query: query, mode: mode, interval: interval, transport: transport });
      const p = a.plan;
      const problems = [];
      if (a.placesTrades !== false) problems.push("placesTrades");
      if (!/not financial advice/i.test(a.disclaimer)) problems.push("disclaimer");
      if (!/does not place trades/i.test(a.summary)) problems.push("no-trade line");
      if (!(p.invalidation < p.entryLow)) problems.push("invalidation");
      if (!(Math.abs(p.entryLow - p.dayHigh * 0.95) < 1e-6)) problems.push("zoneLow");
      if (!(Math.abs(p.entryHigh - p.dayHigh * 0.97) < 1e-6)) problems.push("zoneHigh");
      if (p.targets.some(function (t) { return !(t > p.entryHigh); })) problems.push("targets");
      if (p.dontChase && !/don't chase/i.test(a.summary)) problems.push("chase copy");
      if (p.dayChangePct != null && p.dayChangePct > 8 && !p.dontChase) problems.push("missed chase");
      if (mode === "crypto" && !a.btc) problems.push("btc");
      if (mode === "stock" && a.btc) problems.push("btc on stock");
      console.log([
        problems.length ? "FAIL" : "OK",
        transport, query, a.intervalLabel,
        "src=" + a.source, "bars=" + a.bars,
        "trend=" + a.trend.label,
        "rsi=" + (a.indicators.rsi == null ? "na" : a.indicators.rsi.toFixed(1)),
        "ema50=" + (a.indicators.ema50 == null ? "na" : "yes"),
        "day=" + p.dayChangePct,
        "bias=" + p.bias,
        "conf=" + p.confidenceLabel,
        "btc=" + (a.btc ? (a.btc.weak ? "weak" : "firm") : "-"),
        problems.join(",")
      ].join(" | "));
      if (problems.length) {
        failed++;
        console.log(a.headline);
        console.log(String(a.summary).slice(0, 500));
      }
    } catch (err) {
      failed++;
      console.log("ERR", transport, query, interval, err && err.message);
    }
  }
  process.exit(failed ? 1 : 0);
})();
