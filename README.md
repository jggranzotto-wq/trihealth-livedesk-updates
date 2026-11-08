# Tri-Health Live Desk updates

Hosts `version.json`, `positions.json`, and Windows exes for the Live Desk auto-updater.
Published by `/workspace/windows-live-desk/publish.sh`.

## Chart analysis

The Chart tab (desktop `/`, phone `/m/`) has an **Analyze** button. It loads recent candles for the symbol and timeframe already selected, computes RSI(14), EMA20, EMA50, MACD(12, 26, 9), and a volume read in code, then writes a plain-English note:

- trend, support, and resistance
- a preferred entry 3–5% under the day's high
- **don't chase** when the coin or stock is up more than 8% versus the prior close
- invalidation, targets, and a confidence score
- for crypto, whether BTC's daily close is below its EMA50

The note is educational. It is not financial advice, and nothing in this app places a trade.

The page reads same-origin `/engine.json`. On the static site that file has `"api": false`, so analysis runs in the browser (Binance, with Crypto.com as a fallback; stocks from the CNBC chart feed) and uses the rule-based summary. No key is shipped to the browser. The live Render service is a **static site**, and Render does not let a static site change runtime.

`node server.js` serves the same files, answers `/engine.json` with `"api": true`, and adds `/api/analyze`. Stocks then come from Yahoo Finance (a longer regular-session history, including aggregated 4h bars). Set one of these on the server to let a model rewrite the prose. The numbers in the cards stay computed in code. If the call fails, or no key is set, the rule-based summary is returned.

| Variable | Role |
| --- | --- |
| `XAI_API_KEY` | Enables the xAI rewrite. Used when both keys are set. |
| `OPENAI_API_KEY` | Enables the OpenAI rewrite when `XAI_API_KEY` is unset. |
| `ANALYZE_LLM` | `xai`, `openai`, or `off`. |
| `XAI_MODEL` | Defaults to `grok-3`. |
| `OPENAI_MODEL` | Defaults to `gpt-4o-mini`. |

The process listens on `0.0.0.0:$PORT` (`8787` locally). `GET /healthz` is the health check.

The Windows app source lives in `windows-app/`. The exe embeds `windows-app/static/` (the desk UI plus the same `chart.js`, `analyze.js`, `analyze.css`, and `engine.json` the site uses). `engine.json` has `"api": false`, so Analyze runs in the page: crypto candles come from Binance (Crypto.com if that fails) and stock candles come from the CNBC chart feed. Those are the same public endpoints the static site uses when `/api/analyze` is absent. Favorites are stored in the browser profile next to the exe. This repo does not bump `public/version.json`; an installed copy updates only when that file points at a new binary.
