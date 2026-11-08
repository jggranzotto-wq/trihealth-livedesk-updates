/* Unlimited chart favorites for the Windows Live Desk.
   The public chart.js still resolves symbols and mounts TradingView.
   Each favorite is { query, mode } in localStorage. There is no cap. */
(function (root) {
  "use strict";

  var KEY = "livedesk.chart.favorites";

  function read() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (!Array.isArray(raw)) return [];
      var out = [];
      var seen = {};
      for (var i = 0; i < raw.length; i++) {
        var f = raw[i];
        if (!f || (f.mode !== "crypto" && f.mode !== "stock")) continue;
        var query = String(f.query || "").trim().toUpperCase();
        if (!query || query.length > 32) continue;
        var id = f.mode + ":" + query;
        if (seen[id]) continue;
        seen[id] = true;
        out.push({ query: query, mode: f.mode });
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  function write(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) {}
  }

  function modeOf(rootEl) {
    var on = rootEl.querySelector("[data-chart-mode].on");
    var mode = on && on.getAttribute("data-chart-mode");
    return mode === "stock" ? "stock" : "crypto";
  }

  function attach(rootEl) {
    if (!rootEl || rootEl._livedeskFavs) return;
    var input = rootEl.querySelector("[data-chart-input]");
    var star = rootEl.querySelector("[data-chart-star]");
    var box = rootEl.querySelector("[data-chart-favorites]");
    var status = rootEl.querySelector("[data-chart-status]");
    if (!input || !star || !box) return;
    rootEl._livedeskFavs = true;

    var favorites = read();

    function idOf(f) {
      return f.mode + ":" + f.query;
    }

    function current() {
      return {
        query: String(input.value || "").trim().toUpperCase(),
        mode: modeOf(rootEl)
      };
    }

    function saved(item) {
      var id = idOf(item);
      for (var i = 0; i < favorites.length; i++) {
        if (idOf(favorites[i]) === id) return true;
      }
      return false;
    }

    function say(text) {
      if (status) status.textContent = text;
    }

    function loadFavorite(f) {
      input.value = f.query;
      var modeBtn = rootEl.querySelector('[data-chart-mode="' + f.mode + '"]');
      if (modeBtn) {
        modeBtn.click();
      } else {
        var go = rootEl.querySelector("[data-chart-go]");
        if (go) go.click();
      }
      paint();
    }

    function paint() {
      var cur = current();
      var on = !!(cur.query && saved(cur));
      star.classList.toggle("on", on);
      star.setAttribute("aria-pressed", on ? "true" : "false");
      star.textContent = on ? "★" : "☆";
      star.title = on ? "Saved to favorites" : "Save favorite";

      box.replaceChildren();
      if (!favorites.length) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      var label = document.createElement("span");
      label.className = "chart-quick-label";
      label.textContent = "Favorites";
      box.appendChild(label);

      favorites.forEach(function (f) {
        var collision = favorites.some(function (other) {
          return other.query === f.query && other.mode !== f.mode;
        });
        var wrap = document.createElement("span");
        wrap.className = "chart-fav";

        var b = document.createElement("button");
        b.type = "button";
        b.className = "pill";
        if (f.query === cur.query && f.mode === cur.mode) b.classList.add("on");
        b.textContent = collision ? f.query + (f.mode === "stock" ? " · stock" : " · coin") : f.query;
        b.title = (f.mode === "stock" ? "Stock" : "Crypto") + " · " + f.query;
        b.addEventListener("click", function () { loadFavorite(f); });

        var x = document.createElement("button");
        x.type = "button";
        x.className = "chart-fav-x";
        x.setAttribute("aria-label", "Remove " + f.query);
        x.title = "Remove " + f.query;
        x.textContent = "×";
        x.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          favorites = favorites.filter(function (item) { return idOf(item) !== idOf(f); });
          write(favorites);
          paint();
        });

        wrap.appendChild(b);
        wrap.appendChild(x);
        box.appendChild(wrap);
      });
    }

    star.addEventListener("click", function () {
      var cur = current();
      if (!cur.query) {
        say("Type a coin or ticker before saving a favorite.");
        return;
      }
      if (saved(cur)) {
        paint();
        return;
      }
      favorites.push({ query: cur.query, mode: cur.mode });
      write(favorites);
      paint();
    });

    input.addEventListener("input", paint);
    rootEl.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest("[data-chart-favorites]") || t.closest("[data-chart-star]")) return;
      setTimeout(paint, 0);
    });

    paint();
  }

  root.LiveDeskFavorites = { attach: attach, storageKey: KEY };
})(typeof window !== "undefined" ? window : this);
