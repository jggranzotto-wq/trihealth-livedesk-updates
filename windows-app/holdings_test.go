package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setupHoldings(t *testing.T) {
	t.Helper()
	exeDir = t.TempDir()
	t.Setenv("APPDATA", t.TempDir())
	positions := []byte(`{
	  "note": "remote",
	  "positions": [],
	  "holdings": [{"symbol": "SHIB", "qty": 10, "binance": "SHIBUSDT"}],
	  "closed": [{"symbol": "USELESS", "realized_pnl_usd": 1.26}],
	  "watch": [{"symbol": "BTC", "binance": "BTCUSDT"}]
	}`)
	if err := os.WriteFile(filepath.Join(exeDir, "positions.json"), positions, 0644); err != nil {
		t.Fatal(err)
	}
}

func putHoldings(t *testing.T, mux *http.ServeMux, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/api/user-holdings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestUserHoldingsOverrideRemoteAndSurviveDiskRefresh(t *testing.T) {
	setupHoldings(t)
	mux := http.NewServeMux()
	registerHoldingsRoutes(mux)

	rec := putHoldings(t, mux, `{
	  "holdings": [
	    {"account": "Wealthsimple", "symbol": "shop.to", "qty": 4, "cost_basis": 320.5},
	    {"account": "Binance", "symbol": "btc", "qty": 0.25},
	    {"account": "Crypto.com", "symbol": "usd", "qty": 50}
	  ]
	}`)
	if rec.Code != 200 {
		t.Fatalf("put %d %s", rec.Code, rec.Body.String())
	}
	var saved userHoldingsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if !saved.Override || len(saved.Holdings) != 3 {
		t.Fatalf("saved %#v", saved)
	}
	if saved.Holdings[0].Symbol != "SHOP.TO" || saved.Holdings[0].Account != "Wealthsimple" {
		t.Fatalf("normalized %#v", saved.Holdings[0])
	}
	if saved.Holdings[0].CostBasis == nil || *saved.Holdings[0].CostBasis != 320.5 {
		t.Fatalf("cost %#v", saved.Holdings[0].CostBasis)
	}
	if saved.Holdings[1].CostBasis != nil {
		t.Fatal("missing cost basis should stay omitted")
	}
	if !strings.Contains(saved.Path, filepath.Join("TriHealth-LiveDesk", "user-holdings.json")) {
		t.Fatalf("path %s", saved.Path)
	}
	if _, err := os.Stat(saved.Path); err != nil {
		t.Fatal(err)
	}

	remote, err := os.ReadFile(filepath.Join(exeDir, "positions.json"))
	if err != nil {
		t.Fatal(err)
	}
	served := loadConfigBytes()
	if string(served) == string(remote) {
		t.Fatal("served config should differ once the user has saved holdings")
	}
	var doc map[string]interface{}
	if err := json.Unmarshal(served, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["holdings_source"] != "user" {
		t.Fatalf("source %#v", doc["holdings_source"])
	}
	if _, ok := doc["closed"]; !ok {
		t.Fatal("overlay dropped closed trades")
	}
	holds := doc["holdings"].([]interface{})
	if len(holds) != 3 {
		t.Fatalf("holds %#v", holds)
	}
	first := holds[0].(map[string]interface{})
	if first["symbol"] != "SHOP.TO" || first["binance"] != nil {
		t.Fatalf("stock row %#v", first)
	}
	second := holds[1].(map[string]interface{})
	if second["binance"] != "BTCUSDT" || second["cryptocom"] != "BTC_USD" {
		t.Fatalf("coin row %#v", second)
	}
	third := holds[2].(map[string]interface{})
	if third["kind"] != "cash" {
		t.Fatalf("cash row %#v", third)
	}

	// A later remote pull writes a different positions.json. The user file and
	// the served desk list stay on the saved rows.
	userBytes, err := os.ReadFile(saved.Path)
	if err != nil {
		t.Fatal(err)
	}
	replacement := []byte(`{"note":"newer","positions":[],"holdings":[{"symbol":"DOGE","qty":9}],"watch":[{"symbol":"BTC"}]}`)
	if err := os.WriteFile(filepath.Join(exeDir, "positions.json"), replacement, 0644); err != nil {
		t.Fatal(err)
	}
	again := loadConfigBytes()
	if err := json.Unmarshal(again, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["holdings_source"] != "user" {
		t.Fatal("refresh brought remote holdings back")
	}
	if doc["holdings"].([]interface{})[0].(map[string]interface{})["symbol"] != "SHOP.TO" {
		t.Fatalf("desk holdings changed: %s", again)
	}
	after, err := os.ReadFile(saved.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(userBytes) {
		t.Fatal("remote refresh rewrote the user holdings file")
	}
	onDisk, err := os.ReadFile(filepath.Join(exeDir, "positions.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "DOGE") {
		t.Fatal("positions.json should still be the remote payload")
	}

	// Edit one row, then delete it.
	edited := putHoldings(t, mux, `{
	  "holdings": [
	    {"id": "`+saved.Holdings[0].ID+`", "account": "Wealthsimple", "symbol": "SHOP.TO", "qty": 8, "cost_basis": 320.5},
	    {"account": "Binance", "symbol": "BTC", "qty": 0.25}
	  ]
	}`)
	if edited.Code != 200 {
		t.Fatalf("edit %d %s", edited.Code, edited.Body.String())
	}
	served = loadConfigBytes()
	if !strings.Contains(string(served), `"qty":8`) && !strings.Contains(string(served), `"qty": 8`) {
		t.Fatalf("edited qty missing: %s", served)
	}

	del := httptest.NewRequest(http.MethodDelete, "/api/user-holdings", nil)
	drec := httptest.NewRecorder()
	mux.ServeHTTP(drec, del)
	if drec.Code != 200 {
		t.Fatalf("delete %d %s", drec.Code, drec.Body.String())
	}
	if _, err := os.Stat(saved.Path); !os.IsNotExist(err) {
		t.Fatalf("user file still present: %v", err)
	}
	served = loadConfigBytes()
	if strings.Contains(string(served), "SHOP.TO") || strings.Contains(string(served), "holdings_source") {
		t.Fatalf("cleared override still applied: %s", served)
	}
	if !strings.Contains(string(served), "DOGE") {
		t.Fatalf("remote holdings should show again: %s", served)
	}
}

func TestUserHoldingsRejectsBadRows(t *testing.T) {
	setupHoldings(t)
	mux := http.NewServeMux()
	registerHoldingsRoutes(mux)
	cases := []string{
		`{"holdings":[{"account":"Wealthsimple","symbol":"../etc","qty":1}]}`,
		`{"holdings":[{"account":"Wealthsimple","symbol":"BTC","qty":-1}]}`,
		`{"holdings":[{"account":"<script>","symbol":"BTC","qty":1}]}`,
		`{"holdings":[{"symbol":"BTC","qty":1,"cost_basis":-5}]}`,
	}
	for _, body := range cases {
		rec := putHoldings(t, mux, body)
		if rec.Code != 400 {
			t.Fatalf("body %s -> %d %s", body, rec.Code, rec.Body.String())
		}
	}
	if _, err := os.Stat(userHoldingsPath()); !os.IsNotExist(err) {
		t.Fatal("rejected save still wrote a file")
	}
}

func TestEmptyUserListStillWins(t *testing.T) {
	setupHoldings(t)
	mux := http.NewServeMux()
	registerHoldingsRoutes(mux)
	rec := putHoldings(t, mux, `{"holdings":[]}`)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	served := loadConfigBytes()
	var doc map[string]interface{}
	if err := json.Unmarshal(served, &doc); err != nil {
		t.Fatal(err)
	}
	holds, ok := doc["holdings"].([]interface{})
	if !ok || len(holds) != 0 || doc["holdings_source"] != "user" {
		t.Fatalf("empty override: %s", served)
	}
}

func TestNoUserFileKeepsRemoteBytes(t *testing.T) {
	setupHoldings(t)
	raw, err := os.ReadFile(filepath.Join(exeDir, "positions.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(loadConfigBytes()) != string(raw) {
		t.Fatal("config changed with no user holdings file")
	}
}

func TestQuoteParsers(t *testing.T) {
	px, err := parseCNBCLast([]byte(`{"barData":{"priceBars":[{"close":"10.5"},{"close":"11.25"}]}}`))
	if err != nil || px != 11.25 {
		t.Fatalf("cnbc %v %v", px, err)
	}
	px, err = parseYahooLast([]byte(`{"chart":{"result":[{"meta":{"regularMarketPrice":189.5}}]}}`))
	if err != nil || px != 189.5 {
		t.Fatalf("yahoo %v %v", px, err)
	}
	if yahooSymbol("SHOP.TO") != "SHOP.TO" || yahooSymbol("BRK.B") != "BRK-B" {
		t.Fatalf("yahoo symbols %s %s", yahooSymbol("SHOP.TO"), yahooSymbol("BRK.B"))
	}
	if !looksLikeStock("SHOP.TO") || !looksLikeStock("BRK-B") || looksLikeStock("BTC") || looksLikeStock("BTC-USD") {
		t.Fatal("stock detection")
	}
}

func TestStockPriceHandlerUsesStub(t *testing.T) {
	prev := quoteStock
	quoteStock = func(sym string) (float64, string, error) {
		if sym != "AAPL" {
			t.Fatalf("sym %s", sym)
		}
		return 190, "cnbc", nil
	}
	t.Cleanup(func() { quoteStock = prev })
	mux := http.NewServeMux()
	registerHoldingsRoutes(mux)
	req := httptest.NewRequest(http.MethodGet, "/api/stock/price?symbol=aapl", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"price":190`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}
