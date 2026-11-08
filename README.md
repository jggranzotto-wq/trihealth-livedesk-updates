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

The Windows exe embeds its own copy of the chart page and only updates when `version.json` points at a new binary. This repo does not contain that Go app, so this change does not bump `version.json`. Phone and desktop browser users get Analyze from the hosted pages. The installed Windows app keeps the chart it was built with until that app is rebuilt.
