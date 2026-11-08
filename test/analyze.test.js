"use strict";

const assert = require("assert");
const { analyzeCandles, resolveMarket, ema, resample } = require("../public/analyze.js");

function series(n, start, step, volume) {
  const out = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    price = price + step;
    const close = price;
    out.push({
      t: Date.UTC(2026, 0, 1) + i * 3600000,
      o: open,
      h: Math.max(open, close) + 0.4,
      l: Math.min(open, close) - 0.4,
      c: close,
      v: volume == null ? 1000 : volume
    });
  }
  return out;
}

function baseInput(over) {
  return Object.assign({
    label: "TEST",
    tv: "BINANCE:TESTUSDT",
    mode: "crypto",
    interval: "60",
    intervalLabel: "1h",
    intervalMs: 3600000,
    source: "binance",
    engine: "browser",
    historyNote: ""
  }, over);
}

function rising() {
  const candles = series(80, 100, 0.15);
  const daily = [
    { t: Date.UTC(2026, 0, 1), o: 100, h: 101, l: 99, c: 100, v: 1 },
    { t: Date.UTC(2026, 0, 2), o: 100, h: 112, l: 105, c: 110, v: 1 }
  ];
  return analyzeCandles(baseInput({
    candles: candles,
    daily: daily,
    btcDaily: series(80, 100, 0.2)
  }));
}

const chased = rising();
assert.strictEqual(chased.placesTrades, false);
assert.ok(chased.disclaimer.toLowerCase().includes("not financial advice"));
assert.ok(chased.summary.toLowerCase().includes("does not place trades"));
assert.strictEqual(chased.plan.dontChase, true);
assert.ok(chased.summary.toLowerCase().includes("don't chase"));
assert.ok(Math.abs(chased.plan.entryLow - 112 * 0.95) < 1e-9);
assert.ok(Math.abs(chased.plan.entryHigh - 112 * 0.97) < 1e-9);
assert.ok(chased.plan.invalidation < chased.plan.entryLow);
assert.ok(chased.plan.targets.length > 0);
assert.ok(chased.plan.targets.every((t) => t > chased.plan.entryHigh));
assert.strictEqual(chased.btc.weak, false);
assert.ok(chased.summary.includes("EMA50"));

const exactly8 = analyzeCandles(baseInput({
  candles: series(80, 100, 0.05),
  daily: [
    { t: Date.UTC(2026, 0, 1), o: 100, h: 101, l: 99, c: 100, v: 1 },
    { t: Date.UTC(2026, 0, 2), o: 100, h: 108, l: 100, c: 108, v: 1 }
  ],
  btcDaily: series(80, 80, -0.05)
}));
assert.strictEqual(exactly8.plan.dayChangePct, 8);
assert.strictEqual(exactly8.plan.dontChase, false);
assert.strictEqual(exactly8.btc.weak, true);
assert.ok(/below the ema50/i.test(exactly8.btc.note));
assert.ok(exactly8.summary.includes("BTC"));

const inZone = analyzeCandles(baseInput({
  mode: "stock",
  label: "AAPL",
  tv: "AAPL",
  candles: series(80, 90, 0.08),
  daily: [
    { t: Date.UTC(2026, 0, 1), o: 100, h: 101, l: 99, c: 100, v: 5 },
    { t: Date.UTC(2026, 0, 2), o: 100, h: 100, l: 96, c: 97, v: 5 }
  ]
}));
assert.strictEqual(inZone.plan.dontChase, false);
assert.strictEqual(inZone.btc, null);
assert.strictEqual(inZone.plan.bias, "in_zone");
assert.ok(inZone.summary.toLowerCase().includes("pullback"));

const down = analyzeCandles(baseInput({
  candles: series(80, 140, -0.4),
  daily: [
    { t: Date.UTC(2026, 0, 1), o: 110, h: 112, l: 108, c: 110, v: 1 },
    { t: Date.UTC(2026, 0, 2), o: 110, h: 111, l: 100, c: 108, v: 1 }
  ],
  btcDaily: series(60, 50, 0.1)
}));
assert.ok(down.trend.label === "Downtrend" || down.trend.label === "Down");
assert.strictEqual(down.plan.bias, "stand_aside");
assert.ok(down.plan.invalidation < down.plan.entryLow);

const flat = ema([1, 1, 1, 1, 1], 3);
assert.ok(Math.abs(flat[4] - 1) < 1e-9);

const bucketed = resample([
  { t: 0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
  { t: 1000, o: 1.5, h: 3, l: 1, c: 2.5, v: 4 },
  { t: 5000, o: 2.5, h: 2.6, l: 2, c: 2.2, v: 7 }
], 5000);
assert.strictEqual(bucketed.length, 2);
assert.strictEqual(bucketed[0].h, 3);
assert.strictEqual(bucketed[0].l, 0.5);
assert.strictEqual(bucketed[0].c, 2.5);
assert.strictEqual(bucketed[0].v, 14);

assert.deepStrictEqual(
  { kind: resolveMarket("pepe", "crypto").kind, tv: resolveMarket("pepe", "crypto").tv, label: resolveMarket("pepe", "crypto").label },
  { kind: "crypto", tv: "BINANCE:PEPEUSDT", label: "PEPE" }
);
assert.strictEqual(resolveMarket("SOL", "crypto").pair, "SOLUSDT");
assert.strictEqual(resolveMarket("AAPL", "stock").yahoo, "AAPL");
assert.strictEqual(resolveMarket("SHOP.TO", "stock").tv, "TSX:SHOP");
assert.strictEqual(resolveMarket("SHOP.TO", "stock").yahoo, "SHOP.TO");
assert.strictEqual(resolveMarket("BRK.B", "stock").yahoo, "BRK-B");
assert.strictEqual(resolveMarket("BRK.B", "stock").cnbc, "BRK.B");

const short = (() => {
  try {
    analyzeCandles(baseInput({ candles: series(4, 1, 0.1), daily: series(4, 1, 0.1) }));
    return null;
  } catch (err) {
    return err;
  }
})();
assert.ok(short && short.expose);

console.log("analyze.test.js ok");
