"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function memoryStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    dump() {
      return Object.assign({}, data);
    }
  };
}

function loadChart(storage) {
  const window = {};
  const context = {
    window: window,
    localStorage: storage,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };
  window.window = window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/chart.js"), "utf8"), context);
  return context.window.LiveDeskChart;
}

function local(value) {
  return JSON.parse(JSON.stringify(value));
}

const store = memoryStorage();
const api = loadChart(store);

assert.strictEqual(api.FAVORITES_KEY, "livedesk.chart.favorites");
assert.deepStrictEqual(local(api.QUICK_COINS), ["BTC", "ETH", "SOL", "QNT", "BONK", "DOGE"]);
assert.deepStrictEqual(local(api.QUICK_STOCKS), ["AAPL", "TSLA", "SHOP.TO"]);

let list = [];
list = api.addFavorite(list, "btc", "crypto").list;
list = api.addFavorite(list, " eth ", "crypto").list;
list = api.addFavorite(list, "SHOP.to", "stock").list;
assert.deepStrictEqual(local(list), [
  { query: "BTC", mode: "crypto" },
  { query: "ETH", mode: "crypto" },
  { query: "SHOP.TO", mode: "stock" }
]);

const dup = api.addFavorite(list, "Btc", "stock");
assert.strictEqual(dup.added, false);
assert.strictEqual(dup.reason, "duplicate");
assert.strictEqual(dup.list.length, 3);
assert.strictEqual(dup.list[0].mode, "crypto");
assert.strictEqual(dup.list[0].query, "BTC");

const empty = api.addFavorite(list, "   ", "crypto");
assert.strictEqual(empty.added, false);
assert.strictEqual(empty.reason, "empty");
assert.strictEqual(empty.list.length, 3);

list = api.removeFavorite(list, "eth");
assert.deepStrictEqual(local(list).map((item) => item.query), ["BTC", "SHOP.TO"]);

const many = [];
for (let i = 0; i < 40; i++) many.push("c" + i);
let unlimited = [];
many.forEach((sym, i) => {
  const result = api.addFavorite(unlimited, sym, i % 2 ? "stock" : "crypto");
  assert.strictEqual(result.added, true);
  unlimited = result.list;
});
assert.strictEqual(unlimited.length, 40);
assert.strictEqual(unlimited[0].query, "C0");
assert.strictEqual(unlimited[39].query, "C39");
assert.strictEqual(unlimited[1].mode, "stock");
unlimited = api.addFavorite(unlimited, "c0", "crypto").list;
assert.strictEqual(unlimited.length, 40);
assert.strictEqual(unlimited[0].query, "C0");

const toggledOff = api.toggleFavorite(unlimited, "c1", "stock");
assert.strictEqual(toggledOff.removed, true);
assert.strictEqual(toggledOff.list.length, 39);
assert.ok(!toggledOff.list.some((item) => item.query === "C1"));
const toggledOn = api.toggleFavorite(toggledOff.list, "sol", "crypto");
assert.strictEqual(toggledOn.added, true);
assert.strictEqual(toggledOn.list[toggledOn.list.length - 1].query, "SOL");

const messy = api.normalizeFavoriteList([
  { query: " sol ", mode: "crypto" },
  { query: "SOL", mode: "stock" },
  "aapl",
  { query: "", mode: "stock" },
  null,
  4,
  { query: "AAPL", mode: "crypto" },
  { nope: true }
]);
assert.deepStrictEqual(local(messy), [
  { query: "SOL", mode: "crypto" },
  { query: "AAPL", mode: "crypto" }
]);
assert.deepStrictEqual(local(api.normalizeFavoriteList(null)), []);
assert.deepStrictEqual(local(api.normalizeFavoriteList({ query: "BTC" })), []);

assert.strictEqual(api.saveFavorites(list), true);
assert.strictEqual(store.dump()[api.FAVORITES_KEY], JSON.stringify([
  { query: "BTC", mode: "crypto" },
  { query: "SHOP.TO", mode: "stock" }
]));
assert.deepStrictEqual(local(api.loadFavorites()), [
  { query: "BTC", mode: "crypto" },
  { query: "SHOP.TO", mode: "stock" }
]);

store.setItem(api.FAVORITES_KEY, "{");
assert.deepStrictEqual(local(api.loadFavorites()), []);

const throwing = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("quota"); }
};
const blocked = loadChart(throwing);
assert.deepStrictEqual(local(blocked.loadFavorites()), []);
assert.strictEqual(blocked.saveFavorites([{ query: "BTC", mode: "crypto" }]), false);

const desktop = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const mobile = fs.readFileSync(path.join(__dirname, "../public/m/index.html"), "utf8");
assert.ok(desktop.includes("data-chart-fav"));
assert.ok(desktop.includes("data-chart-favs"));
assert.ok(desktop.includes("data-chart-quick"));
assert.ok(mobile.includes("data-chart-fav"));
assert.ok(mobile.includes("data-chart-favs"));
assert.ok(mobile.includes("data-chart-quick"));
assert.ok(desktop.includes('src="chart.js"'));
assert.ok(mobile.includes('src="../chart.js"'));

console.log("favorites.test.js ok");
