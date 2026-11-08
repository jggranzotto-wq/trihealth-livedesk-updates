/* LiveDesk chart: map a typed symbol to TradingView and mount the advanced chart widget. */
(function (root) {
  "use strict";

  var TIMEFRAMES = [
    { id: "60", label: "1h" },
    { id: "240", label: "4h" },
    { id: "D", label: "1D" },
    { id: "W", label: "1W" }
  ];

  var QUICK_COINS = ["BTC", "ETH", "SOL", "QNT", "BONK", "DOGE"];
  var QUICK_STOCKS = ["AAPL", "TSLA", "SHOP.TO"];

  /* Yahoo-style suffix -> TradingView exchange. SHOP.TO becomes TSX:SHOP. */
  var SUFFIX = {
    TO: "TSX",
    V: "TSXV",
    CN: "CSE",
    NE: "NEO",
    L: "LSE",
    AX: "ASX",
    HK: "HKEX",
    DE: "XETR",
    PA: "EURONEXT",
    SW: "SIX",
    T: "TSE"
  };

  function resolveSymbol(raw, mode) {
    var s = String(raw == null ? "" : raw).trim().toUpperCase();
    if (!s) return null;
    if (s.charAt(0) === "$") s = s.slice(1);
    if (s.indexOf(":") !== -1) return s.replace(/\s+/g, "");
    s = s.replace(/\s+/g, "").replace(/\//g, "");
    var und = s.indexOf("_");
    if (und > 0) {
      var base = s.slice(0, und);
      var quote = s.slice(und + 1);
      if (quote === "USDT" || quote === "USDC" || quote === "USD" || quote === "BTC") {
        return "BINANCE:" + base + (quote === "USD" ? "USDT" : quote);
      }
    }
    s = s.replace(/-/g, "");
    var dot = s.lastIndexOf(".");
    if (dot > 0) {
      var ticker = s.slice(0, dot);
      var suf = s.slice(dot + 1);
      if (SUFFIX[suf] && ticker) return SUFFIX[suf] + ":" + ticker;
      return s;
    }
    if (mode === "stock") return s;
    var coin = s;
    if (coin.length > 4 && coin.slice(-4) === "USDT") coin = coin.slice(0, -4);
    else if (coin.length > 4 && coin.slice(-4) === "USDC") coin = coin.slice(0, -4);
    else if (coin.length > 3 && coin.slice(-3) === "USD") coin = coin.slice(0, -3);
    if (!coin) return null;
    return "BINANCE:" + coin + "USDT";
  }

  function timeframeLabel(id) {
    for (var i = 0; i < TIMEFRAMES.length; i++) {
      if (TIMEFRAMES[i].id === id) return TIMEFRAMES[i].label;
    }
    return id;
  }

  /* localStorage is per-origin, so / and /m/ share this list. */
  var FAVORITES_KEY = "livedesk.chart.favorites";

  function normalizeFavoriteQuery(raw) {
    return String(raw == null ? "" : raw).trim().toUpperCase();
  }

  function favoriteMode(mode) {
    return mode === "stock" ? "stock" : "crypto";
  }

  function addFavorite(list, query, mode) {
    var next = Array.isArray(list) ? list.slice() : [];
    var q = normalizeFavoriteQuery(query);
    if (!q) return { list: next, added: false, removed: false, reason: "empty", query: "" };
    for (var i = 0; i < next.length; i++) {
      if (next[i] && normalizeFavoriteQuery(next[i].query) === q) {
        return { list: next, added: false, removed: false, reason: "duplicate", query: q };
      }
    }
    next.push({ query: q, mode: favoriteMode(mode) });
    return { list: next, added: true, removed: false, reason: "added", query: q };
  }

  function removeFavorite(list, query) {
    var q = normalizeFavoriteQuery(query);
    var src = Array.isArray(list) ? list : [];
    var next = [];
    for (var i = 0; i < src.length; i++) {
      if (!src[i]) continue;
      var itemQuery = normalizeFavoriteQuery(src[i].query);
      if (!itemQuery || itemQuery === q) continue;
      next.push({ query: itemQuery, mode: favoriteMode(src[i].mode) });
    }
    return next;
  }

  function toggleFavorite(list, query, mode) {
    var q = normalizeFavoriteQuery(query);
    if (!q) return { list: Array.isArray(list) ? list.slice() : [], added: false, removed: false, reason: "empty", query: "" };
    var src = Array.isArray(list) ? list : [];
    for (var i = 0; i < src.length; i++) {
      if (src[i] && normalizeFavoriteQuery(src[i].query) === q) {
        return { list: removeFavorite(src, q), added: false, removed: true, reason: "removed", query: q };
      }
    }
    return addFavorite(src, q, mode);
  }

  function normalizeFavoriteList(raw) {
    var out = [];
    if (!Array.isArray(raw)) return out;
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      var query = "";
      var mode = "crypto";
      if (typeof item === "string") query = item;
      else if (item && typeof item === "object") {
        query = item.query;
        mode = item.mode;
      } else continue;
      out = addFavorite(out, query, mode).list;
    }
    return out;
  }

  function loadFavorites() {
    try {
      return normalizeFavoriteList(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "null"));
    } catch (_) {
      return [];
    }
  }

  function saveFavorites(list) {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(normalizeFavoriteList(list)));
      return true;
    } catch (_) {
      return false;
    }
  }

  var mountToken = 0;

  function mount(host, opts) {
    var symbol = opts.symbol;
    var interval = opts.interval || "60";
    var theme = opts.theme === "light" ? "light" : "dark";
    var token = ++mountToken;
    host.innerHTML = "";

    var wrap = document.createElement("div");
    wrap.className = "tradingview-widget-container";
    wrap.style.height = "100%";
    wrap.style.width = "100%";

    var widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "calc(100% - 32px)";
    widget.style.width = "100%";
    widget.textContent = "Loading " + symbol + "…";

    var copy = document.createElement("div");
    copy.className = "tradingview-widget-copyright";
    var link = document.createElement("a");
    link.href = "https://www.tradingview.com/";
    link.target = "_blank";
    link.rel = "noopener nofollow";
    var blue = document.createElement("span");
    blue.className = "blue-text";
    blue.textContent = "Track all markets on TradingView";
    link.appendChild(blue);
    copy.appendChild(link);

    var script = document.createElement("script");
    script.type = "text/javascript";
    script.async = true;
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.text = JSON.stringify({
      autosize: true,
      width: "100%",
      height: "100%",
      symbol: symbol,
      interval: interval,
      timezone: "America/Toronto",
      theme: theme,
      style: "1",
      locale: "en",
      backgroundColor: theme === "dark" ? "#0b0f14" : "#ffffff",
      gridColor: theme === "dark" ? "rgba(255, 255, 255, 0.06)" : "rgba(42, 46, 57, 0.06)",
      allow_symbol_change: true,
      hide_side_toolbar: !!opts.hideSideToolbar,
      calendar: false,
      support_host: "https://www.tradingview.com"
    });
    script.onerror = function () {
      if (token !== mountToken) return;
      host.innerHTML = "";
      var msg = document.createElement("div");
      msg.className = "chart-fallback";
      msg.textContent = "Chart failed to load. Check the connection and try again.";
      host.appendChild(msg);
    };

    wrap.appendChild(widget);
    wrap.appendChild(copy);
    host.appendChild(wrap);
    wrap.appendChild(script);

    setTimeout(function () {
      if (token !== mountToken) return;
      if (!host.querySelector("iframe")) {
        var status = opts.statusEl;
        if (status) status.textContent = "Chart is taking a while to load. Check the connection and try again.";
      }
    }, 12000);
  }

  function init(rootEl, options) {
    if (!rootEl) return;
    options = options || {};
    var theme = options.theme === "light" ? "light" : "dark";
    var storageKey = options.storageKey || "livedesk.chart";
    var input = rootEl.querySelector("[data-chart-input]");
    var go = rootEl.querySelector("[data-chart-go]");
    var host = rootEl.querySelector("[data-chart-host]");
    var status = rootEl.querySelector("[data-chart-status]");
    var modes = rootEl.querySelector("[data-chart-modes]");
    var quick = rootEl.querySelector("[data-chart-quick]");
    var tfs = rootEl.querySelector("[data-chart-tfs]");
    if (!input || !host || !modes || !quick || !tfs) return;

    var favBtn = rootEl.querySelector("[data-chart-fav]");
    if (!favBtn) {
      favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.setAttribute("data-chart-fav", "");
      favBtn.setAttribute("aria-pressed", "false");
      favBtn.className = (go && go.classList.contains("btn")) ? "btn chart-fav-add" : "chart-fav-add";
      if (input.nextSibling) input.parentNode.insertBefore(favBtn, input.nextSibling);
      else input.parentNode.appendChild(favBtn);
    }
    var favs = rootEl.querySelector("[data-chart-favs]");
    if (!favs) {
      favs = document.createElement("div");
      favs.className = "pills chart-favs";
      favs.setAttribute("data-chart-favs", "");
      favs.setAttribute("aria-label", "Favorites");
      favs.hidden = true;
      var search = rootEl.querySelector(".chart-search");
      if (search && search.parentNode) search.parentNode.insertBefore(favs, search.nextSibling);
      else modes.parentNode.insertBefore(favs, modes);
    }

    var state = { query: "BTC", mode: "crypto", interval: "60", favorites: [] };
    try {
      var saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved && typeof saved === "object") {
        if (saved.mode === "stock" || saved.mode === "crypto") state.mode = saved.mode;
        if (typeof saved.query === "string" && saved.query.trim()) state.query = saved.query.trim();
        if (TIMEFRAMES.some(function (t) { return t.id === saved.interval; })) state.interval = saved.interval;
      }
    } catch (_) {}
    state.favorites = loadFavorites();

    var mountedKey = "";
    var layoutTries = 0;

    function save() {
      try {
        localStorage.setItem(storageKey, JSON.stringify({
          query: state.query,
          mode: state.mode,
          interval: state.interval
        }));
      } catch (_) {}
    }

    function paint() {
      var q = (input.value || "").trim().toUpperCase();
      rootEl.querySelectorAll("[data-chart-mode]").forEach(function (b) {
        b.classList.toggle("on", b.getAttribute("data-chart-mode") === state.mode);
      });
      rootEl.querySelectorAll("[data-chart-tf]").forEach(function (b) {
        b.classList.toggle("on", b.getAttribute("data-chart-tf") === state.interval);
      });
      rootEl.querySelectorAll("[data-chart-quick-sym]").forEach(function (b) {
        var match = b.getAttribute("data-chart-quick-sym") === q && b.getAttribute("data-chart-quick-mode") === state.mode;
        b.classList.toggle("on", match);
      });
      rootEl.querySelectorAll(".fav-chip").forEach(function (chip) {
        var match = chip.getAttribute("data-chart-fav-sym") === q && chip.getAttribute("data-chart-fav-mode") === state.mode;
        chip.classList.toggle("on", match);
      });
      var star = rootEl.querySelector("[data-chart-fav]");
      if (star) {
        var saved = (state.favorites || []).some(function (item) { return item && item.query === q; });
        star.classList.toggle("on", saved);
        star.setAttribute("aria-pressed", saved ? "true" : "false");
        star.textContent = saved ? "★ Favorite" : "☆ Favorite";
        star.setAttribute("aria-label", saved ? ((q || "Symbol") + " is a saved favorite") : "Save this symbol as a favorite");
      }
      input.placeholder = state.mode === "stock" ? "AAPL, TSLA, SHOP.TO" : "BTC, QNT, SOL, BONK";
    }

    function loadChart(force) {
      if (host.offsetHeight < 20 && layoutTries < 8) {
        layoutTries++;
        requestAnimationFrame(function () { loadChart(force); });
        return;
      }
      layoutTries = 0;
      var query = (input.value || "").trim();
      state.query = query;
      var symbol = resolveSymbol(query, state.mode);
      paint();
      if (!symbol) {
        mountedKey = "";
        host.innerHTML = "";
        if (status) status.textContent = "Type a coin (BTC, QNT) or a ticker (AAPL, SHOP.TO).";
        return;
      }
      var key = symbol + "|" + state.interval + "|" + theme;
      if (status) status.textContent = "Showing " + symbol + " · " + timeframeLabel(state.interval);
      save();
      if (!force && key === mountedKey && host.querySelector("iframe")) return;
      mountedKey = key;
      mount(host, {
        symbol: symbol,
        interval: state.interval,
        theme: theme,
        hideSideToolbar: !!options.hideSideToolbar,
        statusEl: status
      });
    }

    function chip(sym, mode) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pill";
      b.setAttribute("data-chart-quick-sym", sym);
      b.setAttribute("data-chart-quick-mode", mode);
      b.textContent = sym;
      b.addEventListener("click", function () {
        state.mode = mode;
        state.query = sym;
        input.value = sym;
        loadChart(true);
      });
      return b;
    }

    function label(text) {
      var s = document.createElement("span");
      s.className = "chart-quick-label";
      s.textContent = text;
      return s;
    }

    var suppressClickUntil = 0;

    function bindLongPress(el, onLong) {
      var timer = null;
      var startX = 0;
      var startY = 0;
      function clearTimer() {
        if (timer) { clearTimeout(timer); timer = null; }
      }
      function end() {
        clearTimer();
        document.removeEventListener("pointerup", end, true);
        document.removeEventListener("pointercancel", end, true);
      }
      el.addEventListener("pointerdown", function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        startX = e.clientX;
        startY = e.clientY;
        clearTimer();
        document.addEventListener("pointerup", end, true);
        document.addEventListener("pointercancel", end, true);
        timer = setTimeout(function () {
          timer = null;
          suppressClickUntil = Date.now() + 800;
          onLong();
        }, 600);
      });
      el.addEventListener("pointermove", function (e) {
        if (!timer) return;
        if (Math.abs(e.clientX - startX) > 12 || Math.abs(e.clientY - startY) > 12) end();
      });
      el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    }

    function persistFavorites(message) {
      var ok = saveFavorites(state.favorites);
      renderFavorites();
      paint();
      if (status) status.textContent = ok ? message : "Couldn't save favorites in this browser.";
    }

    function renderFavorites() {
      favs.innerHTML = "";
      var list = state.favorites || [];
      if (!list.length) {
        favs.hidden = true;
        return;
      }
      favs.hidden = false;
      favs.appendChild(label("Favorites"));
      list.forEach(function (item) {
        var chip = document.createElement("span");
        chip.className = "fav-chip";
        chip.setAttribute("data-chart-fav-sym", item.query);
        chip.setAttribute("data-chart-fav-mode", item.mode);

        var loadBtn = document.createElement("button");
        loadBtn.type = "button";
        loadBtn.className = "fav-load";
        loadBtn.textContent = item.query;
        loadBtn.setAttribute("aria-label", "Load " + item.query + " chart");

        var removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "fav-x";
        removeBtn.textContent = "×";
        removeBtn.setAttribute("aria-label", "Remove " + item.query + " from favorites");

        loadBtn.addEventListener("click", function () {
          state.mode = favoriteMode(item.mode);
          state.query = item.query;
          input.value = item.query;
          loadChart(true);
        });
        removeBtn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          state.favorites = removeFavorite(state.favorites, item.query);
          persistFavorites("Removed " + item.query + " from favorites");
        });
        bindLongPress(chip, function () {
          state.favorites = removeFavorite(state.favorites, item.query);
          persistFavorites("Removed " + item.query + " from favorites");
        });

        chip.appendChild(loadBtn);
        chip.appendChild(removeBtn);
        favs.appendChild(chip);
      });
    }

    modes.innerHTML = "";
    ["crypto", "stock"].forEach(function (mode) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pill";
      b.setAttribute("data-chart-mode", mode);
      b.textContent = mode === "crypto" ? "Crypto" : "Stock";
      b.addEventListener("click", function () {
        state.mode = mode;
        loadChart(true);
      });
      modes.appendChild(b);
    });

    quick.innerHTML = "";
    quick.appendChild(label("Coins"));
    QUICK_COINS.forEach(function (sym) { quick.appendChild(chip(sym, "crypto")); });
    quick.appendChild(label("Stocks"));
    QUICK_STOCKS.forEach(function (sym) { quick.appendChild(chip(sym, "stock")); });

    tfs.innerHTML = "";
    TIMEFRAMES.forEach(function (tf) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pill";
      b.setAttribute("data-chart-tf", tf.id);
      b.textContent = tf.label;
      b.addEventListener("click", function () {
        state.interval = tf.id;
        loadChart(true);
      });
      tfs.appendChild(b);
    });

    input.value = state.query;
    input.addEventListener("input", function () { paint(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        loadChart(true);
      }
    });
    if (go) go.addEventListener("click", function () { loadChart(true); });
    favBtn.addEventListener("click", function () {
      var q = normalizeFavoriteQuery(input.value);
      if (!q || !resolveSymbol(q, state.mode)) {
        paint();
        if (status) status.textContent = "Type a coin or ticker before saving a favorite.";
        return;
      }
      var result = addFavorite(state.favorites, q, state.mode);
      input.value = result.query;
      if (!result.added) {
        paint();
        if (status) status.textContent = result.query + " is already a favorite.";
        return;
      }
      state.favorites = result.list;
      persistFavorites("Saved " + result.query + " to favorites");
    });
    rootEl.addEventListener("click", function (e) {
      if (Date.now() >= suppressClickUntil) return;
      suppressClickUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    window.addEventListener("storage", function (e) {
      if (!e || e.key !== FAVORITES_KEY) return;
      state.favorites = loadFavorites();
      renderFavorites();
      paint();
    });
    var analyzeBtn = rootEl.querySelector("[data-chart-analyze]");
    var panel = rootEl.querySelector("[data-chart-analysis]");
    if (analyzeBtn) {
      analyzeBtn.addEventListener("click", function () {
        if (!window.LiveDeskAnalyze) {
          if (status) status.textContent = "Analysis didn't load. Refresh the page.";
          return;
        }
        loadChart(false);
        LiveDeskAnalyze.open(panel, {
          query: input.value,
          mode: state.mode,
          interval: state.interval
        }, analyzeBtn);
      });
    }
    renderFavorites();
    paint();

    rootEl._livedeskChartShow = function () {
      state.favorites = loadFavorites();
      renderFavorites();
      loadChart(false);
    };
  }

  function show(rootEl) {
    if (!rootEl || typeof rootEl._livedeskChartShow !== "function") return;
    requestAnimationFrame(function () { rootEl._livedeskChartShow(); });
  }

  root.LiveDeskChart = {
    TIMEFRAMES: TIMEFRAMES,
    QUICK_COINS: QUICK_COINS,
    QUICK_STOCKS: QUICK_STOCKS,
    FAVORITES_KEY: FAVORITES_KEY,
    resolveSymbol: resolveSymbol,
    normalizeFavoriteQuery: normalizeFavoriteQuery,
    addFavorite: addFavorite,
    removeFavorite: removeFavorite,
    toggleFavorite: toggleFavorite,
    normalizeFavoriteList: normalizeFavoriteList,
    loadFavorites: loadFavorites,
    saveFavorites: saveFavorites,
    mount: mount,
    init: init,
    show: show
  };
})(typeof window !== "undefined" ? window : this);
