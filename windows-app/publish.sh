#!/usr/bin/env bash
# Build Windows Live Desk, bump/publish version.json + exes + positions to the
# public update host (GitHub → Render static site).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

REPO_DIR="${UPDATE_HOST_DIR:-$ROOT/update-host}"
GH_REPO="${UPDATE_GH_REPO:-jggranzotto-wq/trihealth-livedesk-updates}"
# Public base URL served by Render static site (override if slug differs)
UPDATE_BASE="${UPDATE_BASE:-https://trihealth-livedesk-updates.onrender.com}"
BRANCH="${UPDATE_BRANCH:-main}"

VERSION_FILE="$ROOT/VERSION"
if [[ ! -f "$VERSION_FILE" ]]; then
  echo "1.2.0" > "$VERSION_FILE"
fi

# Optional: bump patch when PUBLISH_BUMP=1
if [[ "${PUBLISH_BUMP:-0}" == "1" ]]; then
  cur="$(tr -d '[:space:]' < "$VERSION_FILE")"
  IFS=. read -r MA MI PA <<<"$cur"
  PA=$((PA + 1))
  echo "${MA}.${MI}.${PA}" > "$VERSION_FILE"
fi

VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
echo "==> Publishing Live Desk v${VERSION}"

command -v go >/dev/null
command -v git >/dev/null
command -v sha256sum >/dev/null
command -v python3 >/dev/null

mkdir -p "$REPO_DIR/public" "$ROOT/dist"

echo "==> Building Windows amd64 exes"
LDFLAGS_COMMON="-s -w -X main.AppVersion=${VERSION} -X main.updateBaseURL=${UPDATE_BASE}"
GOOS=windows GOARCH=amd64 go build -ldflags "${LDFLAGS_COMMON} -H windowsgui" -o "$ROOT/TriHealth-LiveDesk.exe" .
GOOS=windows GOARCH=amd64 go build -ldflags "${LDFLAGS_COMMON}" -o "$ROOT/TriHealth-LiveDesk-console.exe" .

SHA_GUI=$(sha256sum "$ROOT/TriHealth-LiveDesk.exe" | awk '{print $1}')
SHA_CON=$(sha256sum "$ROOT/TriHealth-LiveDesk-console.exe" | awk '{print $1}')
SIZE_GUI=$(wc -c < "$ROOT/TriHealth-LiveDesk.exe" | tr -d ' ')
SIZE_CON=$(wc -c < "$ROOT/TriHealth-LiveDesk-console.exe" | tr -d ' ')

RELEASED_AT="$(TZ=America/Toronto date '+%Y-%m-%dT%H:%M:%S%z' | sed -E 's/([0-9]{2})([0-9]{2})$/\1:\2/')"

cp -f "$ROOT/TriHealth-LiveDesk.exe" "$REPO_DIR/public/TriHealth-LiveDesk.exe"
cp -f "$ROOT/TriHealth-LiveDesk-console.exe" "$REPO_DIR/public/TriHealth-LiveDesk-console.exe"
# Application releases deliberately preserve public positions.json and scan.json.

cat > "$REPO_DIR/public/version.json" <<JSON
{
  "version": "${VERSION}",
  "released_at": "${RELEASED_AT}",
  "exe": {
    "url": "${UPDATE_BASE}/TriHealth-LiveDesk.exe",
    "sha256": "${SHA_GUI}",
    "size": ${SIZE_GUI}
  },
  "console_exe": {
    "url": "${UPDATE_BASE}/TriHealth-LiveDesk-console.exe",
    "sha256": "${SHA_CON}",
    "size": ${SIZE_CON}
  },
  "positions_url": "${UPDATE_BASE}/positions.json",
  "scan_url": "${UPDATE_BASE}/scan.json",
  "notes": "v${VERSION}: Windows Chart tab adds Analyze and unlimited favorites. Crypto and stock search, TradingView, 1h/4h/1D/1W."
}
JSON

# Keep the existing desktop and mobile web UI unchanged.

# Zip for manual install / first download
ZIP_OUT="/workspace/TriHealth-LiveDesk-Windows.zip"
STAGE="$ROOT/dist/zipstage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -f "$ROOT/TriHealth-LiveDesk.exe" "$STAGE/"
cp -f "$ROOT/TriHealth-LiveDesk-console.exe" "$STAGE/"
cp -f "$ROOT/positions.json" "$STAGE/"
cp -f "$ROOT/README.txt" "$STAGE/" 2>/dev/null || true
cp -f "$ROOT/LiveDesk.html" "$STAGE/" 2>/dev/null || true
cp -f "$ROOT/LiveDesk.hta" "$STAGE/" 2>/dev/null || true
cp -f "$ROOT/Run-LiveDesk.bat" "$STAGE/" 2>/dev/null || true
cp -f "$ROOT/TriHealth-LiveDesk.ps1" "$STAGE/" 2>/dev/null || true
rm -f "$ZIP_OUT"
if command -v zip >/dev/null 2>&1; then
  ( cd "$STAGE" && zip -9 -r "$ZIP_OUT" . )
else
  python3 - <<PYZ
import zipfile, os
from pathlib import Path
stage = Path("$STAGE")
out = Path("$ZIP_OUT")
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in stage.rglob("*"):
        if f.is_file():
            z.write(f, f.relative_to(stage).as_posix())
print(f"zipped {out} ({out.stat().st_size} bytes)")
PYZ
fi
cp -f "$ZIP_OUT" "$REPO_DIR/public/TriHealth-LiveDesk-Windows.zip"

# Ensure git repo
if [[ ! -d "$REPO_DIR/.git" ]]; then
  git clone "https://github.com/${GH_REPO}.git" "$REPO_DIR.tmp"
  # Move public content into clone
  mkdir -p "$REPO_DIR.tmp/public"
  cp -a "$REPO_DIR/public/." "$REPO_DIR.tmp/public/"
  rm -rf "$REPO_DIR"
  mv "$REPO_DIR.tmp" "$REPO_DIR"
fi

cd "$REPO_DIR"
# Ensure remote
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/${GH_REPO}.git"

# .gitignore keep large binaries tracked intentionally
if [[ ! -f .gitignore ]]; then
  cat > .gitignore <<'GI'
.DS_Store
*.log
GI
fi

# Minimal render hint
cat > render.yaml <<YAML
services:
  - type: web
    name: trihealth-livedesk-updates
    runtime: static
    repo: https://github.com/${GH_REPO}
    branch: ${BRANCH}
    buildCommand: "true"
    staticPublishPath: ./public
    headers:
      - path: /*
        name: Cache-Control
        value: "no-store, no-cache, must-revalidate, max-age=0"
      - path: /positions.json
        name: Cache-Control
        value: "no-store, no-cache, must-revalidate, max-age=0"
      - path: /version.json
        name: Cache-Control
        value: "no-store, no-cache, must-revalidate, max-age=0"
      - path: /scan.json
        name: Cache-Control
        value: "no-store, no-cache, must-revalidate, max-age=0"
YAML

git add -A
if git diff --cached --quiet; then
  echo "==> No changes to commit"
else
  git -c user.email="livedesk-bot@trihealth.local" -c user.name="Live Desk Publisher" \
    commit -m "Publish Live Desk v${VERSION}"
fi

# Push (uses gh credentials / GH_TOKEN)
git push -u origin HEAD:"${BRANCH}" 2>&1 || {
  # First push may need to set upstream on empty repo
  git push --set-upstream origin "${BRANCH}" 2>&1
}

echo "==> Published v${VERSION}"
echo "    Update base: ${UPDATE_BASE}"
echo "    version.json: ${UPDATE_BASE}/version.json"
echo "    Zip: ${ZIP_OUT}"
echo "    GUI sha256: ${SHA_GUI}"

# After push: if https://trihealth-livedesk-updates.onrender.com/version.json is stale,
# trigger deploy for Render service srv-dbialtvb9u1s73disg60 (auto-deploy webhook may need GitHub app access).
