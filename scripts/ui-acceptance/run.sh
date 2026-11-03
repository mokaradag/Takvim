#!/bin/bash
# MERGEN Rota arayüz kabulü: Linux/macOS, Bash 3.2 ve üzeri.
# Önce npm ci ve NEXT_TELEMETRY_DISABLED=1 npx next build çalıştırılır.
# Tarayıcı kurulumu: npm install --no-save --package-lock=false playwright
# Ardından npx playwright install chromium çalıştırılır; Claude CLI kimliği hazır olmalıdır.
# Kullanım: scripts/ui-acceptance/run.sh A B (varsayılan: bütün profiller).
# Her koşu kendi dizinini, kanıtlarını ve model çağrı bütçesini kullanır; önceki koşular korunur.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT"
node -e "require.resolve('playwright')" >/dev/null
if ! command -v claude >/dev/null; then printf 'Claude CLI bulunamadı; model kabulü çalıştırılamaz.\n' >&2; exit 1; fi
BASE=${UI_ACCEPTANCE_DIR:-${TMPDIR:-/tmp}/rota-ui-acceptance}
mkdir -p "$BASE/runs"
export UI_ACCEPTANCE_DIR
UI_ACCEPTANCE_DIR=$(mktemp -d "$BASE/runs/run-XXXXXXXX")
export UI_RUN_ID
UI_RUN_ID=$(node -e "console.log(require('crypto').randomUUID())")
mkdir "$UI_ACCEPTANCE_DIR/out"
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({runId:process.env.UI_RUN_ID}))" "$UI_ACCEPTANCE_DIR/run.json"
BRIDGE=''
APP=''
cleanup() {
  if [ -n "$APP" ]; then kill "$APP" 2>/dev/null || true; wait "$APP" 2>/dev/null || true; APP=''; fi
  if [ -n "$BRIDGE" ]; then kill "$BRIDGE" 2>/dev/null || true; wait "$BRIDGE" 2>/dev/null || true; BRIDGE=''; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Her dinleyici yalnızca döngü arayüzündedir; dolu bir bağlantı noktası asla yeniden kullanılmaz.
probe_port() {
  node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.on("error",()=>process.exit(1)); s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close());' "$1"
}
export BRIDGE_PORT=${BRIDGE_PORT:-18731}
probe_port "$BRIDGE_PORT"
BRIDGE_LEDGER="$UI_ACCEPTANCE_DIR/ledger.jsonl" BRIDGE_CALLS="$UI_ACCEPTANCE_DIR/calls.jsonl" BRIDGE_MAX_CALLS=${BRIDGE_MAX_CALLS:-140} \
  node "$HERE/haikuBridge.mjs" > "$UI_ACCEPTANCE_DIR/bridge.log" 2>&1 &
BRIDGE=$!
ready=0
for _ in $(seq 1 30); do
  kill -0 "$BRIDGE" 2>/dev/null || exit 1
  if curl -fsS -o /dev/null "http://127.0.0.1:$BRIDGE_PORT/v1/models" 2>/dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ]
MASTER=$(node -e "console.log(require('crypto').createHash('sha256').update('ui-acceptance').digest('base64url'))")
LOADER=$(node --input-type=module -e 'import {pathToFileURL} from "node:url"; console.log(pathToFileURL(process.argv[1]).href)' "$HERE/loader.mjs")
PROFILES=${*:-G F C E D A B}
for P in $PROFILES; do
  case "$P" in
    A) SICIL=920001; PORT=8101;; B) SICIL=920002; PORT=8102;; C) SICIL=920003; PORT=8103;;
    D) SICIL=920004; PORT=8104;; E) SICIL=920005; PORT=8105;; F) SICIL=920006; PORT=8106;;
    G) SICIL=920007; PORT=8107;; *) printf 'Geçersiz profil: %s\n' "$P" >&2; exit 1;;
  esac
  probe_port "$PORT"
  LOG="$UI_ACCEPTANCE_DIR/app-$P.log"
  NEXT_TELEMETRY_DISABLED=1 MERGEN_ROTA_DB_SERVER=sql.ui.internal MERGEN_ROTA_DB_DATABASE=MERGEN_Rota MERGEN_ROTA_AUTH_MODE=development \
    MERGEN_ROTA_DEV_IDENTITY_ENABLED=true MERGEN_ROTA_DEV_SICIL=$SICIL MERGEN_ROTA_AI_ENABLED=true MERGEN_ROTA_AI_TOOLS_ENABLED=true \
    MERGEN_ROTA_AI_BASE_URL="http://127.0.0.1:$BRIDGE_PORT/v1" MERGEN_ROTA_AI_DEFAULT_API_KEY=ui-acceptance-key MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY=$MASTER \
    MERGEN_ROTA_AI_MODEL_REGISTRY_PATH="$HERE/registry.json" MERGEN_ROTA_AI_ANSWER_COMPOSITION=true MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS=200000 \
    MERGEN_ROTA_LOG_FORMAT=json NODE_OPTIONS="${NODE_OPTIONS:-} --import=$LOADER" \
    node node_modules/next/dist/bin/next start -H 127.0.0.1 -p "$PORT" > "$LOG" 2>&1 &
  APP=$!
  ready=0
  for _ in $(seq 1 60); do
    kill -0 "$APP" 2>/dev/null || exit 1
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then ready=1; break; fi
    sleep 1
  done
  [ "$ready" = 1 ]
  node "$HERE/drive.cjs" "$HERE/scenarios/$P.json" "$UI_ACCEPTANCE_DIR/out" | tee -a "$UI_ACCEPTANCE_DIR/run.log"
  kill "$APP"; wait "$APP" 2>/dev/null || true; APP=''
done
node "$HERE/report.cjs" "$UI_ACCEPTANCE_DIR/out" | tee "$UI_ACCEPTANCE_DIR/report.md"
printf 'Kabul kanıtı: %s\n' "$UI_ACCEPTANCE_DIR"
