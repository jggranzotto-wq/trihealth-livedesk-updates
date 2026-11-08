// User holdings are stored on this PC and win over remote positions.json.
// No exchange keys. Auto-update only replaces the exe, so this file stays.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const userHoldingsName = "user-holdings.json"

// symbolRE allows coins (BTC, 1INCH) and tickers (AAPL, SHOP.TO, BRK.B, BRK-B).
var symbolRE = regexp.MustCompile(`^[A-Z0-9]{1,16}([.\-][A-Z0-9]{1,8})?$`)

var exchangeSuffix = map[string]bool{
	"TO": true, "V": true, "CN": true, "NE": true, "L": true, "AX": true,
	"HK": true, "DE": true, "PA": true, "SW": true, "T": true,
}

// UserHolding is one row the person typed: account, symbol, quantity, optional cost basis.
type UserHolding struct {
	ID        string   `json:"id"`
	Account   string   `json:"account"`
	Symbol    string   `json:"symbol"`
	Qty       float64  `json:"qty"`
	CostBasis *float64 `json:"cost_basis,omitempty"`
}

// UserHoldingsDoc is the on-disk file. Override stays true even when Holdings is empty,
// so a deleted list is not replaced by the next remote pull.
type UserHoldingsDoc struct {
	Override bool          `json:"override"`
	SavedAt  string        `json:"saved_at,omitempty"`
	Holdings []UserHolding `json:"holdings"`
}

type userHoldingsResponse struct {
	Override bool          `json:"override"`
	SavedAt  string        `json:"saved_at,omitempty"`
	Path     string        `json:"path"`
	Holdings []UserHolding `json:"holdings"`
}

func userDataDir() string {
	if app := strings.TrimSpace(os.Getenv("APPDATA")); app != "" {
		return filepath.Join(app, "TriHealth-LiveDesk")
	}
	if runtime.GOOS == "windows" {
		if dir, err := os.UserConfigDir(); err == nil && dir != "" {
			return filepath.Join(dir, "TriHealth-LiveDesk")
		}
	}
	if exeDir != "" {
		return exeDir
	}
	return "."
}

func userHoldingsPath() string {
	return filepath.Join(userDataDir(), userHoldingsName)
}

func readUserHoldings() (UserHoldingsDoc, bool) {
	b, err := os.ReadFile(userHoldingsPath())
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("user holdings unreadable: %v", err)
		}
		return UserHoldingsDoc{}, false
	}
	var doc UserHoldingsDoc
	if err := json.Unmarshal(b, &doc); err != nil {
		log.Printf("user holdings invalid JSON (%v); ignoring so remote defaults still show", err)
		return UserHoldingsDoc{}, false
	}
	if !doc.Override {
		return doc, false
	}
	if doc.Holdings == nil {
		doc.Holdings = []UserHolding{}
	}
	return doc, true
}

func writeUserHoldings(doc UserHoldingsDoc) error {
	path := userHoldingsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	if doc.Holdings == nil {
		doc.Holdings = []UserHolding{}
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0644); err != nil {
		return err
	}
	// Windows rename does not replace an existing file.
	_ = os.Remove(path)
	if err := os.Rename(tmp, path); err != nil {
		if werr := os.WriteFile(path, b, 0644); werr != nil {
			return err
		}
		_ = os.Remove(tmp)
	}
	return nil
}

func clearUserHoldings() error {
	err := os.Remove(userHoldingsPath())
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func newHoldingID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b[:])
}

func normalizeAccount(s string) (string, error) {
	s = strings.TrimSpace(s)
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", nil
	}
	if utf8.RuneCountInString(s) > 64 {
		return "", errors.New("account name is too long")
	}
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == ' ' || r == '.' || r == '&' || r == '\'' || r == '(' || r == ')' || r == '_' || r == '+' || r == '-':
		default:
			return "", fmt.Errorf("account %q has a character this app does not store", s)
		}
	}
	return s, nil
}

func normalizeSymbol(s string) (string, error) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "$")
	s = strings.ToUpper(s)
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "/", "")
	if !symbolRE.MatchString(s) {
		return "", fmt.Errorf("symbol %q is not a coin or ticker", s)
	}
	return s, nil
}

func normalizeHoldings(in []UserHolding) ([]UserHolding, error) {
	if len(in) > 500 {
		return nil, errors.New("too many holdings")
	}
	out := make([]UserHolding, 0, len(in))
	seenID := map[string]bool{}
	for _, row := range in {
		sym, err := normalizeSymbol(row.Symbol)
		if err != nil {
			return nil, err
		}
		acct, err := normalizeAccount(row.Account)
		if err != nil {
			return nil, err
		}
		if row.Qty < 0 || row.Qty > 1e18 {
			return nil, fmt.Errorf("%s quantity must be zero or more", sym)
		}
		var cost *float64
		if row.CostBasis != nil {
			v := *row.CostBasis
			if v < 0 || v > 1e12 {
				return nil, fmt.Errorf("%s cost basis must be zero or more", sym)
			}
			cost = &v
		}
		id := strings.ToLower(strings.TrimSpace(row.ID))
		if !regexp.MustCompile(`^[a-f0-9]{8,32}$`).MatchString(id) || seenID[id] {
			id = newHoldingID()
		}
		seenID[id] = true
		out = append(out, UserHolding{ID: id, Account: acct, Symbol: sym, Qty: row.Qty, CostBasis: cost})
	}
	return out, nil
}

func isCashSymbol(sym string) bool {
	switch sym {
	case "USD", "USDT", "USDC":
		return true
	default:
		return false
	}
}

func looksLikeStock(sym string) bool {
	if strings.Contains(sym, ".") {
		return true
	}
	// BRK-B is a class share. BTC-USD is a coin pair.
	if i := strings.Index(sym, "-"); i > 0 && i == len(sym)-2 {
		return true
	}
	return false
}

func cryptoBase(sym string) string {
	s := strings.ReplaceAll(sym, "-", "")
	s = strings.ReplaceAll(s, "_", "")
	for _, q := range []string{"USDT", "USDC", "USD"} {
		if strings.HasSuffix(s, q) && len(s) > len(q) {
			s = strings.TrimSuffix(s, q)
			break
		}
	}
	return s
}

// applyUserHoldings patches the served config when this PC has a saved list.
// The bytes on disk for positions.json are left as the remote pull wrote them.
// Unknown keys (closed trades, notes) stay in the document.
func applyUserHoldings(cfgBytes []byte) []byte {
	doc, ok := readUserHoldings()
	if !ok {
		return cfgBytes
	}
	var root map[string]interface{}
	if err := json.Unmarshal(cfgBytes, &root); err != nil {
		return cfgBytes
	}
	holds := make([]map[string]interface{}, 0, len(doc.Holdings))
	for _, row := range doc.Holdings {
		h := map[string]interface{}{
			"symbol": row.Symbol,
			"qty":    row.Qty,
		}
		if row.Account != "" {
			h["account"] = row.Account
		}
		if row.CostBasis != nil {
			h["cost_basis"] = *row.CostBasis
		}
		if isCashSymbol(row.Symbol) {
			h["kind"] = "cash"
		} else if !looksLikeStock(row.Symbol) {
			base := cryptoBase(row.Symbol)
			if base != "" {
				h["binance"] = base + "USDT"
				h["cryptocom"] = base + "_USD"
			}
		}
		holds = append(holds, h)
	}
	root["holdings"] = holds
	root["holdings_source"] = "user"
	out, err := json.Marshal(root)
	if err != nil {
		return cfgBytes
	}
	return out
}

func reloadCachedConfig() {
	cfgMu.Lock()
	cachedCfg = loadConfigBytes()
	cfgMu.Unlock()
}

func registerHoldingsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/user-holdings", handleUserHoldings)
	mux.HandleFunc("/api/stock/price", handleStockPrice)
}

func handleUserHoldings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodGet:
		doc, ok := readUserHoldings()
		if !ok {
			doc = UserHoldingsDoc{Holdings: []UserHolding{}}
		}
		writeJSON(w, http.StatusOK, userHoldingsResponse{
			Override: doc.Override,
			SavedAt:  doc.SavedAt,
			Path:     userHoldingsPath(),
			Holdings: doc.Holdings,
		})
	case http.MethodPut:
		var body struct {
			Holdings []UserHolding `json:"holdings"`
		}
		dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		rows, err := normalizeHoldings(body.Holdings)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		doc := UserHoldingsDoc{
			Override: true,
			SavedAt:  time.Now().UTC().Format(time.RFC3339),
			Holdings: rows,
		}
		if err := writeUserHoldings(doc); err != nil {
			log.Printf("user holdings save: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not save holdings"})
			return
		}
		reloadCachedConfig()
		log.Printf("saved %d user holdings to %s", len(rows), userHoldingsPath())
		writeJSON(w, http.StatusOK, userHoldingsResponse{
			Override: true,
			SavedAt:  doc.SavedAt,
			Path:     userHoldingsPath(),
			Holdings: rows,
		})
	case http.MethodDelete:
		if err := clearUserHoldings(); err != nil {
			log.Printf("user holdings clear: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not clear holdings"})
			return
		}
		reloadCachedConfig()
		log.Printf("cleared user holdings; desk uses remote positions.json again")
		writeJSON(w, http.StatusOK, userHoldingsResponse{
			Override: false,
			Path:     userHoldingsPath(),
			Holdings: []UserHolding{},
		})
	default:
		w.Header().Set("Allow", "GET, PUT, DELETE")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(true)
	_ = enc.Encode(v)
}

type stockQuote struct {
	Symbol string  `json:"symbol"`
	Price  float64 `json:"price"`
	Source string  `json:"source"`
}

var quoteStock = fetchStockLast

func handleStockPrice(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	sym, err := normalizeSymbol(r.URL.Query().Get("symbol"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "symbol required"})
		return
	}
	px, src, err := quoteStock(sym)
	if err != nil || px <= 0 {
		msg := "no price"
		if err != nil {
			msg = err.Error()
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": msg})
		return
	}
	writeJSON(w, http.StatusOK, stockQuote{Symbol: sym, Price: px, Source: src})
}

func fetchStockLast(sym string) (float64, string, error) {
	client := &http.Client{Timeout: 8 * time.Second}
	if px, err := cnbcLast(client, sym); err == nil && px > 0 {
		return px, "cnbc", nil
	}
	if px, err := yahooLast(client, sym); err == nil && px > 0 {
		return px, "yahoo", nil
	}
	return 0, "", fmt.Errorf("no stock price for %s", sym)
}

func cnbcLast(client *http.Client, sym string) (float64, error) {
	u := "https://ts-api.cnbc.com/harmony/app/charts/1D.json?symbol=" + url.QueryEscape(sym)
	body, err := getQuoteBody(client, u)
	if err != nil {
		return 0, err
	}
	return parseCNBCLast(body)
}

func yahooSymbol(sym string) string {
	dot := strings.LastIndex(sym, ".")
	if dot <= 0 {
		return sym
	}
	suf := sym[dot+1:]
	if !exchangeSuffix[suf] && len(suf) == 1 {
		return sym[:dot] + "-" + suf
	}
	return sym
}

func yahooLast(client *http.Client, sym string) (float64, error) {
	ysym := yahooSymbol(sym)
	u := "https://query1.finance.yahoo.com/v8/finance/chart/" + url.PathEscape(ysym) + "?interval=1d&range=5d&includePrePost=false"
	body, err := getQuoteBody(client, u)
	if err != nil {
		return 0, err
	}
	return parseYahooLast(body)
}

func getQuoteBody(client *http.Client, rawURL string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "TriHealth-LiveDesk/"+AppVersion)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 2<<20))
}

func parseCNBCLast(body []byte) (float64, error) {
	var doc struct {
		BarData struct {
			PriceBars []struct {
				Close interface{} `json:"close"`
			} `json:"priceBars"`
		} `json:"barData"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return 0, err
	}
	bars := doc.BarData.PriceBars
	if len(bars) == 0 {
		return 0, errors.New("cnbc has no bars")
	}
	return flexFloat(bars[len(bars)-1].Close)
}

func parseYahooLast(body []byte) (float64, error) {
	var doc struct {
		Chart struct {
			Result []struct {
				Meta struct {
					RegularMarketPrice float64 `json:"regularMarketPrice"`
				} `json:"meta"`
			} `json:"result"`
		} `json:"chart"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return 0, err
	}
	if len(doc.Chart.Result) == 0 || doc.Chart.Result[0].Meta.RegularMarketPrice <= 0 {
		return 0, errors.New("yahoo has no price")
	}
	return doc.Chart.Result[0].Meta.RegularMarketPrice, nil
}

func flexFloat(v interface{}) (float64, error) {
	switch n := v.(type) {
	case float64:
		if n > 0 {
			return n, nil
		}
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		if err == nil && f > 0 {
			return f, nil
		}
	}
	return 0, errors.New("price missing")
}
