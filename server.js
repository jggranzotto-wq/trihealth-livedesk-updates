/* LiveDesk static host + /api/analyze.
   Optional narrative rewrite (keys never leave the server):
     XAI_API_KEY     — xAI chat completions (used when set)
     OPENAI_API_KEY  — OpenAI chat completions (used when XAI_API_KEY is unset)
     ANALYZE_LLM     — off | xai | openai  (default: whichever key is set, xAI first)
     XAI_MODEL       — default grok-3
     OPENAI_MODEL    — default gpt-4o-mini
   With no key, /api/analyze still returns the rule-based summary. */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const analyze = require("./public/analyze.js");

const ROOT = path.resolve(__dirname, "public");
const PORT = Number(process.env.PORT) || 8787;
const HOST = "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".exe": "application/octet-stream",
  ".zip": "application/zip",
  ".webmanifest": "application/manifest+json"
};

const hits = new Map();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "local";
}

function limited(ip) {
  const now = Date.now();
  const row = hits.get(ip) || [];
  const fresh = row.filter(function (t) { return now - t < 60000; });
  if (fresh.length >= 30) {
    hits.set(ip, fresh);
    return true;
  }
  fresh.push(now);
  hits.set(ip, fresh);
  return false;
}

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(data);
}

function llmChoice() {
  const mode = String(process.env.ANALYZE_LLM || "").toLowerCase();
  if (mode === "off") return null;
  const xai = process.env.XAI_API_KEY || "";
  const openai = process.env.OPENAI_API_KEY || "";
  if (mode === "openai" && openai) return { provider: "openai", key: openai, model: process.env.OPENAI_MODEL || "gpt-4o-mini", url: "https://api.openai.com/v1/chat/completions" };
  if (mode === "xai" && xai) return { provider: "xai", key: xai, model: process.env.XAI_MODEL || "grok-3", url: "https://api.x.ai/v1/chat/completions" };
  if (xai) return { provider: "xai", key: xai, model: process.env.XAI_MODEL || "grok-3", url: "https://api.x.ai/v1/chat/completions" };
  if (openai) return { provider: "openai", key: openai, model: process.env.OPENAI_MODEL || "gpt-4o-mini", url: "https://api.openai.com/v1/chat/completions" };
  return null;
}

function factSheet(a) {
  return {
    symbol: a.label,
    tradingView: a.tv,
    timeframe: a.intervalLabel,
    trend: a.trend,
    rsi: a.indicators.rsi == null ? null : Number(a.indicators.rsi.toFixed(1)),
    ema20: a.indicators.ema20,
    ema50: a.indicators.ema50,
    macd: a.indicators.macd,
    volume: a.indicators.volume,
    dayChangePct: a.plan.dayChangePct,
    dayHigh: a.plan.dayHigh,
    lastPrice: a.price,
    entryZone: [a.plan.entryLow, a.plan.entryHigh],
    invalidation: a.plan.invalidation,
    targets: a.plan.targets,
    support: a.levels.support,
    resistance: a.levels.resistance,
    dontChase: a.plan.dontChase,
    bias: a.plan.bias,
    confidence: a.plan.confidence,
    confidenceLabel: a.plan.confidenceLabel,
    btc: a.btc,
    historyNote: a.historyNote,
    ruleSummary: a.summary
  };
}

function rewrite(a) {
  const choice = llmChoice();
  if (!choice) return Promise.resolve(null);
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 20000);
  const body = {
    model: choice.model,
    temperature: 0.2,
    max_tokens: 700,
    messages: [
      {
        role: "system",
        content: "You write a short educational market note from a JSON fact sheet. Use only numbers present in the JSON. Do not invent prices, indicators, or events. Do not tell the reader to buy, sell, or place an order. If dontChase is true, use the words \"don't chase\". If btc.weak is true, say BTC is below its EMA50. Mention the 3-5% pullback entry zone, the invalidation, and the targets. End by stating this is not financial advice and that no trade is placed. Two to four short paragraphs. No markdown headings."
      },
      { role: "user", content: JSON.stringify(factSheet(a)) }
    ]
  };
  return fetch(choice.url, {
    method: "POST",
    signal: ctrl.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + choice.key
    },
    body: JSON.stringify(body)
  }).then(function (res) {
    return res.json().catch(function () { return null; }).then(function (json) {
      if (!res.ok) return null;
      const text = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (!text || typeof text !== "string") return null;
      let note = text.trim().slice(0, 2500);
      if (!/not financial advice/i.test(note) || !/place/i.test(note)) {
        note += "\n\nEducational only, not financial advice. LiveDesk does not place trades.";
      }
      return { provider: choice.provider, summary: note };
    });
  }).catch(function () {
    return null;
  }).then(function (out) {
    clearTimeout(timer);
    return out;
  });
}

function safeFile(pathname) {
  let rel = decodeURIComponent(pathname.split("?")[0]);
  try { rel = decodeURIComponent(rel); } catch (e) { return null; }
  rel = rel.replace(/^\/+/, "");
  if (!rel || rel.endsWith("/")) rel += "index.html";
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function serveStatic(req, res, pathname) {
  const full = safeFile(pathname);
  if (!full) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad path");
    return;
  }
  fs.stat(full, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Not found");
      return;
    }
    const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/engine.json") {
    sendJSON(res, 200, { api: true });
    return;
  }
  if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
    sendJSON(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/analyze") {
    if (limited(clientIp(req))) {
      sendJSON(res, 429, { ok: false, error: "Too many analysis requests. Wait a minute and try again." });
      return;
    }
    const q = url.searchParams.get("q") || url.searchParams.get("symbol") || "";
    const mode = url.searchParams.get("mode") || "crypto";
    const interval = url.searchParams.get("interval") || "60";
    analyze.build({ query: q, mode: mode, interval: interval, transport: "server" }).then(function (result) {
      return rewrite(result).then(function (note) {
        if (note) {
          result.summary = note.summary;
          result.narrativeSource = note.provider;
        } else if (llmChoice()) {
          result.llmFallback = true;
        }
        sendJSON(res, 200, result);
      });
    }).catch(function (err) {
      const message = err && err.expose ? err.message : "Analysis failed.";
      sendJSON(res, err && err.expose ? 400 : 502, { ok: false, error: message });
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end("Method not allowed");
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, function () {
  console.log("LiveDesk listening on http://" + HOST + ":" + PORT);
});
