// Auto-update + remote positions for Tri-Health Live Desk (Windows).
// Read-only. No API keys. No trading.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// AppVersion is the embedded build version. Overridden at build via -ldflags.
var AppVersion = "1.2.8"

// updateBaseURL is the public host for version.json / positions.json / exes.
// Overridden at build via -ldflags if the Render URL differs.
var updateBaseURL = "https://trihealth-livedesk-updates.onrender.com"

const (
	versionPath        = "/version.json"
	positionsRemote    = "/positions.json"
	updateCheckEvery   = 10 * time.Minute
	positionsPullEvery = 30 * time.Second
)

type remoteAsset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size,omitempty"`
}

type remoteVersion struct {
	Version      string       `json:"version"`
	ReleasedAt   string       `json:"released_at,omitempty"`
	Exe          remoteAsset  `json:"exe"`
	ConsoleExe   *remoteAsset `json:"console_exe,omitempty"`
	PositionsURL string       `json:"positions_url,omitempty"`
	Notes        string       `json:"notes,omitempty"`
}

func versionJSONURL() string {
	return strings.TrimRight(updateBaseURL, "/") + versionPath
}

func positionsJSONURL() string {
	return strings.TrimRight(updateBaseURL, "/") + positionsRemote
}

func cleanupOldBinaries() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	old := exe + ".old"
	if err := os.Remove(old); err == nil {
		log.Printf("removed leftover %s", old)
	}
	// Also clean .new leftovers from failed updates
	_ = os.Remove(exe + ".new")
}

func parseSemver(v string) (major, minor, patch int, ok bool) {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	v = strings.TrimPrefix(v, "V")
	parts := strings.Split(v, ".")
	if len(parts) < 1 || len(parts) > 3 {
		return 0, 0, 0, false
	}
	nums := make([]int, 3)
	for i := 0; i < len(parts); i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil {
			return 0, 0, 0, false
		}
		nums[i] = n
	}
	return nums[0], nums[1], nums[2], true
}

// versionNewer reports whether remote is strictly newer than local.
func versionNewer(remote, local string) bool {
	rm, ri, rp, rok := parseSemver(remote)
	lm, li, lp, lok := parseSemver(local)
	if !rok || !lok {
		// Fall back to unequal string: treat different remote as newer only if not equal
		return remote != "" && remote != local
	}
	if rm != lm {
		return rm > lm
	}
	if ri != li {
		return ri > li
	}
	return rp > lp
}

func fetchRemoteVersion() (*remoteVersion, error) {
	url := cacheBust(versionJSONURL())
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "TriHealth-LiveDesk/"+AppVersion)
	req.Header.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	req.Header.Set("Pragma", "no-cache")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("version.json HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var v remoteVersion
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, err
	}
	if v.Version == "" || v.Exe.URL == "" || v.Exe.SHA256 == "" {
		return nil, fmt.Errorf("version.json missing version/exe.url/exe.sha256")
	}
	return &v, nil
}

func downloadAndHash(url, dest string) (sha string, size int64, err error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("User-Agent", "TriHealth-LiveDesk/"+AppVersion)
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", 0, fmt.Errorf("download HTTP %d from %s", resp.StatusCode, url)
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
	if err != nil {
		return "", 0, err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, 200<<20)) // 200MB cap
	closeErr := f.Close()
	if err != nil {
		_ = os.Remove(dest)
		return "", 0, err
	}
	if closeErr != nil {
		_ = os.Remove(dest)
		return "", 0, closeErr
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func isConsoleBuild() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	base := strings.ToLower(filepath.Base(exe))
	return strings.Contains(base, "console")
}

func applySelfUpdate(v *remoteVersion) error {
	if runtime.GOOS != "windows" {
		return fmt.Errorf("self-update only supported on Windows (current %s)", runtime.GOOS)
	}
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}

	asset := v.Exe
	if isConsoleBuild() && v.ConsoleExe != nil && v.ConsoleExe.URL != "" {
		asset = *v.ConsoleExe
	}
	wantHash := strings.ToLower(strings.TrimSpace(asset.SHA256))
	tmp := exePath + ".new"
	log.Printf("downloading update %s -> %s", v.Version, asset.URL)
	gotHash, size, err := downloadAndHash(asset.URL, tmp)
	if err != nil {
		return err
	}
	if asset.Size > 0 && size != asset.Size {
		_ = os.Remove(tmp)
		return fmt.Errorf("size mismatch: got %d want %d", size, asset.Size)
	}
	if !strings.EqualFold(gotHash, wantHash) {
		_ = os.Remove(tmp)
		return fmt.Errorf("sha256 mismatch: got %s want %s", gotHash, wantHash)
	}
	old := exePath + ".old"
	_ = os.Remove(old) // ignore
	// Windows allows renaming a running executable.
	if err := os.Rename(exePath, old); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename running exe to .old: %w", err)
	}
	if err := os.Rename(tmp, exePath); err != nil {
		// Try to restore
		_ = os.Rename(old, exePath)
		_ = os.Remove(tmp)
		return fmt.Errorf("rename .new into place: %w", err)
	}
	log.Printf("update %s installed (%d bytes); relaunching", v.Version, size)
	cmd := exec.Command(exePath, os.Args[1:]...)
	cmd.Dir = filepath.Dir(exePath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		// Best effort restore
		_ = os.Rename(exePath, tmp)
		_ = os.Rename(old, exePath)
		return fmt.Errorf("relaunch: %w", err)
	}
	os.Exit(0)
	return nil
}

func checkAndApplyUpdate() {
	v, err := fetchRemoteVersion()
	if err != nil {
		log.Printf("update check failed: %v", err)
		return
	}
	log.Printf("remote version %s (local %s)", v.Version, AppVersion)
	if !versionNewer(v.Version, AppVersion) {
		return
	}
	log.Printf("newer version available: %s > %s", v.Version, AppVersion)
	if err := applySelfUpdate(v); err != nil {
		log.Printf("self-update failed: %v", err)
	}
}

// lastPositionsPullAt is set whenever a remote pull succeeds (even if unchanged).
var lastPositionsPullAt time.Time
var lastPositionsPullURL string
var lastPositionsPullBytes int
var lastPositionsPullChanged bool
var lastPositionsPullErr string

type positionsPullResult struct {
	OK       bool   `json:"ok"`
	Changed  bool   `json:"changed"`
	Bytes    int    `json:"bytes"`
	URL      string `json:"url"`
	PulledAt string `json:"pulled_at"`
	Error    string `json:"error,omitempty"`
	Source   string `json:"source"`
	Version  string `json:"app_version"`
}

func cacheBust(url string) string {
	sep := "?"
	if strings.Contains(url, "?") {
		sep = "&"
	}
	return url + sep + "_=" + strconv.FormatInt(time.Now().UnixNano(), 10)
}

func pullRemotePositions() positionsPullResult {
	base := positionsJSONURL()
	url := cacheBust(base)
	res := positionsPullResult{URL: base, Source: "remote", Version: AppVersion}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		res.Error = err.Error()
		lastPositionsPullErr = res.Error
		return res
	}
	req.Header.Set("User-Agent", "TriHealth-LiveDesk/"+AppVersion)
	req.Header.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	req.Header.Set("Pragma", "no-cache")
	client := &http.Client{Timeout: 12 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("positions pull: %v", err)
		res.Error = err.Error()
		lastPositionsPullErr = res.Error
		return res
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		msg := fmt.Sprintf("HTTP %d", resp.StatusCode)
		log.Printf("positions pull %s", msg)
		res.Error = msg
		lastPositionsPullErr = res.Error
		return res
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		res.Error = err.Error()
		lastPositionsPullErr = res.Error
		return res
	}
	var c Config
	if err := json.Unmarshal(body, &c); err != nil {
		log.Printf("positions pull: invalid JSON: %v", err)
		res.Error = "invalid JSON: " + err.Error()
		lastPositionsPullErr = res.Error
		return res
	}
	// Refuse empty junk
	if len(c.Positions) == 0 && len(c.Holdings) == 0 && len(c.Watch) == 0 {
		log.Printf("positions pull: empty payload ignored")
		res.Error = "empty payload ignored"
		lastPositionsPullErr = res.Error
		return res
	}
	path := filepath.Join(exeDir, "positions.json")
	changed := true
	if cur, err := os.ReadFile(path); err == nil && string(cur) == string(body) {
		changed = false
	}
	if changed {
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, body, 0644); err != nil {
			log.Printf("positions pull write tmp: %v", err)
			res.Error = err.Error()
			lastPositionsPullErr = res.Error
			return res
		}
		if err := os.Rename(tmp, path); err != nil {
			_ = os.Remove(tmp)
			log.Printf("positions pull rename: %v", err)
			res.Error = err.Error()
			lastPositionsPullErr = res.Error
			return res
		}
	}
	// Remote bytes stay in positions.json. A saved user list is applied only
	// in memory, so this pull cannot put the server holdings back.
	served := applyUserHoldings(body)
	cfgMu.Lock()
	cachedCfg = served
	cfgMu.Unlock()
	if _, userOwned := readUserHoldings(); userOwned {
		log.Printf("user holdings kept; remote holdings were not applied to the desk")
	}
	now := time.Now()
	lastPositionsPullAt = now
	lastPositionsPullURL = base
	lastPositionsPullBytes = len(body)
	lastPositionsPullChanged = changed
	lastPositionsPullErr = ""
	res.OK = true
	res.Changed = changed
	res.Bytes = len(body)
	loc, _ := time.LoadLocation("America/Toronto")
	if loc == nil {
		loc = time.FixedZone("ET", -4*3600)
	}
	res.PulledAt = now.In(loc).Format(time.RFC3339)
	if changed {
		log.Printf("positions.json refreshed from %s (%d bytes)", base, len(body))
	} else {
		log.Printf("positions.json unchanged from %s (%d bytes)", base, len(body))
	}
	return res
}

func startUpdateLoops() {
	cleanupOldBinaries()
	// Immediate check (non-blocking)
	go func() {
		time.Sleep(2 * time.Second)
		checkAndApplyUpdate()
		pullRemotePositions()
	}()
	go func() {
		t := time.NewTicker(updateCheckEvery)
		defer t.Stop()
		for range t.C {
			checkAndApplyUpdate()
		}
	}()
	go func() {
		t := time.NewTicker(positionsPullEvery)
		defer t.Stop()
		for range t.C {
			pullRemotePositions()
		}
	}()
}
