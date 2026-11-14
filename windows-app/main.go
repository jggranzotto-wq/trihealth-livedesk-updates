// Tri-Health Wellness Centre — live desk board (Windows)
// Read-only public tickers. No API keys. No trading.
package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

const defaultPort = 47811

//go:embed static/*
var staticFS embed.FS

type Position struct {
	Symbol  string  `json:"symbol"`
	Binance string  `json:"binance"`
	Qty     float64 `json:"qty"`
	Entry   float64 `json:"entry"`
	Stop    float64 `json:"stop"`
}

type Watch struct {
	Symbol  string `json:"symbol"`
	Binance string `json:"binance"`
}

type Grid struct {
	RangeLow  float64 `json:"range_low"`
	RangeHigh float64 `json:"range_high"`
	Stop      float64 `json:"stop"`
}

type Holding struct {
	Symbol           string   `json:"symbol"`
	Kind             string   `json:"kind,omitempty"`
	Account          string   `json:"account,omitempty"`
	Binance          string   `json:"binance,omitempty"`
	CryptoCom        string   `json:"cryptocom,omitempty"`
	Qty              float64  `json:"qty"`
	QtyApprox        bool     `json:"qty_approx,omitempty"`
	ValueSnapshotUSD float64  `json:"value_snapshot_usd,omitempty"`
	CostBasis        *float64 `json:"cost_basis,omitempty"`
	Note             string   `json:"note,omitempty"`
}

type Config struct {
	USDCADFallback   float64         `json:"usd_cad_fallback"`
	BTCCADStop       float64         `json:"btc_cad_stop"`
	PollMS           int             `json:"poll_ms"`
	CashUSD          float64         `json:"cash_usd,omitempty"`
	SnapshotTotalUSD float64         `json:"snapshot_total_usd,omitempty"`
	SnapshotAt       string          `json:"snapshot_at,omitempty"`
	Note             string          `json:"note,omitempty"`
	Positions        []Position      `json:"positions"`
	Holdings         []Holding       `json:"holdings"`
	HoldingsSource   string          `json:"holdings_source,omitempty"`
	Watch            []Watch         `json:"watch"`
	Grids            map[string]Grid `json:"grids"`
}

var (
	exeDir    string
	logFile   *os.File
	cfgMu     sync.RWMutex
	cachedCfg []byte
)

func defaultConfig() Config {
	return Config{
		USDCADFallback:   1.3989,
		BTCCADStop:       113000,
		PollMS:           4000,
		CashUSD:          549.26,
		SnapshotTotalUSD: 728.0,
		SnapshotAt:       "2026-10-30T08:33:00-04:00",
		Note:             "Desk open: USELESS, PUMP, PENGU. Cash ~$549.26. PEPE grid above range (likely sold to USD). DOGE grid active. SHIB/BONK/ARB/SUI grids ended Oct 28.",
		Positions: []Position{
			{Symbol: "USELESS", Binance: "USELESSUSDT", Qty: 434.815, Entry: 0.123915, Stop: 0.128417},
			{Symbol: "PUMP", Binance: "PUMPUSDT", Qty: 13731, Entry: 0.0039007, Stop: 0.0039287},
			{Symbol: "PENGU", Binance: "PENGUUSDT", Qty: 7442.6, Entry: 0.007245, Stop: 0.00699},
		},
		Holdings: []Holding{
			{Symbol: "USD", Kind: "cash", Qty: 549.26, Note: "free USD"},
			{Symbol: "SHIB", Binance: "SHIBUSDT", CryptoCom: "SHIB_USD", Qty: 3992150},
			{Symbol: "BONK", Binance: "BONKUSDT", CryptoCom: "BONK_USD", Qty: 6301950, Note: "older lot · no stop"},
			{Symbol: "DOGE", Binance: "DOGEUSDT", CryptoCom: "DOGE_USD", Qty: 195.12, QtyApprox: true, ValueSnapshotUSD: 14.38, Note: "qty ≈ $14.38 / spot at snapshot"},
			{Symbol: "PEPE", Binance: "PEPEUSDT", CryptoCom: "PEPE_USD", Qty: 2236443, QtyApprox: true, ValueSnapshotUSD: 10.31, Note: "qty ≈ snapshot; PEPE grid above range / likely sold out"},
			{Symbol: "VVS", CryptoCom: "VVS_USD", Qty: 2221200},
			{Symbol: "ELON", CryptoCom: "ELON_USD", Qty: 68655000},
		},
		Watch: []Watch{
			{Symbol: "BTC", Binance: "BTCUSDT"},
			{Symbol: "ETH", Binance: "ETHUSDT"},
			{Symbol: "SOL", Binance: "SOLUSDT"},
			{Symbol: "PEPE", Binance: "PEPEUSDT"},
			{Symbol: "DOGE", Binance: "DOGEUSDT"},
			{Symbol: "SHIB", Binance: "SHIBUSDT"},
		},
		Grids: map[string]Grid{
			"DOGE": {RangeLow: 0.075, RangeHigh: 0.084, Stop: 0.072},
			"PEPE": {RangeLow: 0.0000044, RangeHigh: 0.0000051, Stop: 0.0000042},
		},
	}
}

func defaultConfigBytes() []byte {
	b, _ := json.MarshalIndent(defaultConfig(), "", "  ")
	return b
}

func resolveExeDir() string {
	exe, err := os.Executable()
	if err != nil {
		if wd, e2 := os.Getwd(); e2 == nil {
			return wd
		}
		return "."
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	dir := filepath.Dir(exe)
	// go run / test: prefer cwd when it already has positions.json beside sources
	if _, err := os.Stat(filepath.Join(dir, "positions.json")); err != nil {
		if wd, err := os.Getwd(); err == nil {
			if _, err2 := os.Stat(filepath.Join(wd, "positions.json")); err2 == nil {
				return wd
			}
			if _, err2 := os.Stat(filepath.Join(wd, "static", "index.html")); err2 == nil {
				return wd
			}
		}
	}
	return dir
}

func setupLog() {
	path := filepath.Join(exeDir, "livedesk.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		log.SetOutput(os.Stderr)
		log.Printf("could not open log file %s: %v", path, err)
		return
	}
	logFile = f
	log.SetOutput(io.MultiWriter(f, os.Stderr))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("=== Live Desk start pid=%d os=%s arch=%s exeDir=%s version=%s ===", os.Getpid(), runtime.GOOS, runtime.GOARCH, exeDir, AppVersion)
}

func loadConfigBytes() []byte {
	return applyUserHoldings(readPositionsBytes())
}

func readPositionsBytes() []byte {
	path := filepath.Join(exeDir, "positions.json")
	b, err := os.ReadFile(path)
	if err != nil {
		log.Printf("positions.json missing or unreadable (%v); using embedded defaults", err)
		b = defaultConfigBytes()
		if werr := os.WriteFile(path, b, 0644); werr != nil {
			log.Printf("could not write positions.json: %v", werr)
		} else {
			log.Printf("wrote default positions.json to %s", path)
		}
		return b
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		log.Printf("positions.json invalid (%v); using embedded defaults", err)
		return defaultConfigBytes()
	}
	// Empty desk positions is valid (all stopped out). Ensure holdings exist.
	if len(c.Holdings) == 0 && len(c.Positions) == 0 {
		log.Printf("positions.json has neither desk positions nor holdings; merging embedded holdings")
		def := defaultConfig()
		c.Holdings = def.Holdings
		c.CashUSD = def.CashUSD
		c.SnapshotTotalUSD = def.SnapshotTotalUSD
		c.Note = def.Note
		b, _ = json.MarshalIndent(c, "", "  ")
	}
	return b
}

func httpClient() *http.Client {
	return &http.Client{Timeout: 8 * time.Second}
}

func proxyGet(w http.ResponseWriter, url string) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	req.Header.Set("User-Agent", "TriHealth-LiveDesk/"+AppVersion)
	resp, err := httpClient().Do(req)
	if err != nil {
		log.Printf("proxy error %s: %v", url, err)
		http.Error(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func handleScan(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.Header().Set("Content-Type", "application/json")

	remoteURL := strings.TrimRight(updateBaseURL, "/") + "/scan.json"
	req, err := http.NewRequest(http.MethodGet, remoteURL, nil)
	if err == nil {
		req.Header.Set("User-Agent", "TriHealth-LiveDesk/"+AppVersion)
		req.Header.Set("Cache-Control", "no-cache")
		resp, err := httpClient().Do(req)
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == 200 {
				body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
				if err == nil && len(body) > 0 && json.Valid(body) {
					// Also cache beside exe for offline fallback
					_ = os.WriteFile(filepath.Join(exeDir, "scan.json"), body, 0644)
					w.WriteHeader(200)
					_, _ = w.Write(body)
					return
				}
			} else {
				log.Printf("scan remote HTTP %d", resp.StatusCode)
			}
		} else {
			log.Printf("scan remote: %v", err)
		}
	}

	// Fallback: local scan.json beside exe / cwd
	candidates := []string{
		filepath.Join(exeDir, "scan.json"),
		filepath.Join(exeDir, "static", "scan.json"),
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "scan.json"))
	}
	for _, path := range candidates {
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if !json.Valid(b) {
			continue
		}
		log.Printf("scan served from local %s", path)
		w.WriteHeader(200)
		_, _ = w.Write(b)
		return
	}
	http.Error(w, `{"error":"scan.json unavailable"}`, 404)
}

func openAppWindow(url string) error {
	switch runtime.GOOS {
	case "windows":
		profile := filepath.Join(os.TempDir(), "trihealth-livedesk-profile")
		appArgs := []string{
			"--user-data-dir=" + profile,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-features=TranslateUI",
			"--app=" + url,
			"--window-size=1100,820",
		}
		candidates := []string{
			filepath.Join(os.Getenv("ProgramFiles(x86)"), `Microsoft\Edge\Application\msedge.exe`),
			filepath.Join(os.Getenv("ProgramFiles"), `Microsoft\Edge\Application\msedge.exe`),
			filepath.Join(os.Getenv("ProgramFiles"), `Google\Chrome\Application\chrome.exe`),
			filepath.Join(os.Getenv("LocalAppData"), `Google\Chrome\Application\chrome.exe`),
		}
		for _, path := range candidates {
			if st, err := os.Stat(path); err == nil && !st.IsDir() {
				cmd := exec.Command(path, appArgs...)
				// Detach: do not wait; Edge often hands off and the launcher exits.
				if err := cmd.Start(); err != nil {
					log.Printf("failed to start %s: %v", path, err)
					continue
				}
				log.Printf("launched browser %s -> %s (pid %d); host stays up", path, url, cmd.Process.Pid)
				// Reap in background so we don't leave zombies; NEVER exit the host.
				go func() { _ = cmd.Wait() }()
				return nil
			}
		}
		cmd := exec.Command("cmd", "/c", "start", "", url)
		if err := cmd.Start(); err != nil {
			return err
		}
		log.Printf("launched via cmd start -> %s", url)
		go func() { _ = cmd.Wait() }()
		return nil
	case "darwin":
		cmd := exec.Command("open", url)
		err := cmd.Start()
		go func() { _ = cmd.Wait() }()
		return err
	default:
		cmd := exec.Command("xdg-open", url)
		err := cmd.Start()
		go func() { _ = cmd.Wait() }()
		return err
	}
}

func waitHealthy(base string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 500 * time.Millisecond}
	var last error
	for time.Now().Before(deadline) {
		resp, err := client.Get(base + "/api/health")
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return nil
			}
			last = fmt.Errorf("health status %d", resp.StatusCode)
		} else {
			last = err
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("health check failed after %s: %v", timeout, last)
}

func listenPreferred(preferred int) (net.Listener, int, error) {
	if preferred <= 0 {
		preferred = defaultPort
	}
	addr := fmt.Sprintf("127.0.0.1:%d", preferred)
	ln, err := net.Listen("tcp", addr)
	if err == nil {
		return ln, preferred, nil
	}
	log.Printf("port %d busy (%v); falling back to random 127.0.0.1 port", preferred, err)
	ln, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	return ln, port, nil
}

func main() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic: %v\n%s", r, debug.Stack())
			fatal(fmt.Errorf("panic: %v", r))
		}
	}()

	serveOnly := flag.Bool("serve", false, "serve only (no browser); print URL and keep running")
	portFlag := flag.Int("port", defaultPort, "preferred listen port on 127.0.0.1")
	flag.Parse()

	exeDir = resolveExeDir()
	setupLog()
	log.Printf("exeDir resolved to %s", exeDir)

	cachedCfg = loadConfigBytes()

	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintf(w, `{"ok":true,"pid":%d,"exeDir":%q,"version":%q,"updateBase":%q}`, os.Getpid(), exeDir, AppVersion, updateBaseURL)
	})
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		cfgMu.Lock()
		cachedCfg = loadConfigBytes()
		b := cachedCfg
		cfgMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(b)
	})
	// Force a remote positions.json pull (Refresh button / manual). Bypasses CDN via cache-bust.
	mux.HandleFunc("/api/refresh-positions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		res := pullRemotePositions()
		cfgMu.RLock()
		b := cachedCfg
		if len(b) == 0 {
			b = loadConfigBytes()
		}
		cfgMu.RUnlock()
		out := map[string]interface{}{
			"ok":          res.OK,
			"changed":     res.Changed,
			"bytes":       res.Bytes,
			"url":         res.URL,
			"pulled_at":   res.PulledAt,
			"error":       res.Error,
			"source":      res.Source,
			"app_version": res.Version,
			"config":      json.RawMessage(b),
		}
		enc := json.NewEncoder(w)
		if !res.OK {
			w.WriteHeader(502)
		}
		_ = enc.Encode(out)
	})
	mux.HandleFunc("/api/binance/ticker", func(w http.ResponseWriter, r *http.Request) {
		sym := r.URL.Query().Get("symbol")
		if sym == "" {
			http.Error(w, "symbol required", 400)
			return
		}
		proxyGet(w, "https://api.binance.com/api/v3/ticker/24hr?symbol="+sym)
	})
	mux.HandleFunc("/api/binance/price", func(w http.ResponseWriter, r *http.Request) {
		sym := r.URL.Query().Get("symbol")
		if sym == "" {
			http.Error(w, "symbol required", 400)
			return
		}
		proxyGet(w, "https://api.binance.com/api/v3/ticker/price?symbol="+sym)
	})
	mux.HandleFunc("/api/cryptocom/tickers", func(w http.ResponseWriter, r *http.Request) {
		proxyGet(w, "https://api.crypto.com/exchange/v1/public/get-tickers")
	})
	mux.HandleFunc("/api/fx", func(w http.ResponseWriter, r *http.Request) {
		proxyGet(w, "https://open.er-api.com/v6/latest/USD")
	})
	mux.HandleFunc("/api/scan", handleScan)
	registerHoldingsRoutes(mux)
	// Static UI last so /api/* wins on Go 1.22+ mux
	mux.Handle("/", http.FileServer(http.FS(sub)))

	ln, port, err := listenPreferred(*portFlag)
	if err != nil {
		fatal(err)
	}
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	ui := base + "/"
	log.Printf("listening on %s", base)

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			fatal(err)
		}
	}()

	if err := waitHealthy(base, 5*time.Second); err != nil {
		fatal(err)
	}
	log.Printf("health check OK")

	// Reload config from disk periodically
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for range t.C {
			cfgMu.Lock()
			cachedCfg = loadConfigBytes()
			cfgMu.Unlock()
		}
	}()

	startUpdateLoops()
	log.Printf("auto-update enabled; base=%s version=%s", updateBaseURL, AppVersion)

	if *serveOnly {
		fmt.Println(ui)
		log.Printf("serve-only mode; URL %s", ui)
	} else {
		if err := openAppWindow(ui); err != nil {
			log.Printf("browser launch failed: %v (server still running at %s)", err, ui)
		}
	}

	// Keepalive: block forever. Do NOT tie lifetime to the browser process.
	// User stops via Task Manager / closing the console exe, or killing the process.
	log.Printf("host keepalive; leave TriHealth-LiveDesk.exe running while using the board")
	select {}
}

func fatal(err error) {
	msg := err.Error()
	log.Printf("FATAL: %s", msg)
	if logFile != nil {
		_ = logFile.Sync()
	}
	if runtime.GOOS == "windows" {
		ps := "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Live Desk error: " +
			powershellEscape(msg) +
			"' + [char]10 + [char]10 + 'See livedesk.log next to the exe.','Tri-Health Live Desk')"
		_ = exec.Command("powershell", "-NoProfile", "-Command", ps).Run()
	}
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}

func powershellEscape(s string) string {
	out := make([]byte, 0, len(s)+8)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\'' {
			out = append(out, '\'', '\'')
		} else if c == '\n' || c == '\r' {
			out = append(out, ' ')
		} else {
			out = append(out, c)
		}
	}
	return string(out)
}
