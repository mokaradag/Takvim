#!/bin/bash
# MERGEN Rota · Bilgin UI kabul koşusu (yalnızca geliştirme; Linux/macOS).
#
# Gerçek uygulamayı (üretim derlemesi, `next start`) bellek içi SQL Server ikizi ve sentetik veriyle başlatır, her
# yanıtı yerel OpenAI uyumlu köprü üzerinden Claude Haiku 4.5'e (düşünme kapalı, tek çağrı, model kimliği her çağrıda
# doğrulanır) gönderir ve Bilgin'i Playwright ile ARAYÜZDEN kullanır. Kayıtlar $UI_ACCEPTANCE_DIR altındadır.
#
#   NEXT_TELEMETRY_DISABLED=1 npx next build
#   scripts/ui-acceptance/run.sh            # bütün profiller: G F C E D A B
#   scripts/ui-acceptance/run.sh A B        # yalnızca bazı profiller
#   node scripts/ui-acceptance/report.cjs "$UI_ACCEPTANCE_DIR/out"
#
# Gereken: Claude CLI (`claude`) ve kimlik bilgisi (bkz. scripts/planner-claude-model.mjs), Playwright Chromium.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
export UI_ACCEPTANCE_DIR=${UI_ACCEPTANCE_DIR:-${TMPDIR:-/tmp}/rota-ui-acceptance}
mkdir -p "$UI_ACCEPTANCE_DIR/out"
declare -A SICIL=( [A]=920001 [B]=920002 [C]=920003 [D]=920004 [E]=920005 [F]=920006 [G]=920007 )
declare -A PORT=( [A]=8101 [B]=8102 [C]=8103 [D]=8104 [E]=8105 [F]=8106 [G]=8107 )
if ! curl -s -o /dev/null http://127.0.0.1:18731/v1/models; then
  BRIDGE_LEDGER="$UI_ACCEPTANCE_DIR/ledger.jsonl" BRIDGE_CALLS="$UI_ACCEPTANCE_DIR/calls.jsonl" BRIDGE_MAX_CALLS=${BRIDGE_MAX_CALLS:-140} \
    nohup node "$HERE/haikuBridge.mjs" > "$UI_ACCEPTANCE_DIR/bridge.log" 2>&1 < /dev/null &
  BRIDGE=$!; sleep 1
fi
MASTER=$(node -e "console.log(require('crypto').createHash('sha256').update('ui-acceptance').digest('base64url'))")
PROFILES=${*:-G F C E D A B}
for P in $PROFILES; do
  LOG="$UI_ACCEPTANCE_DIR/app-$P.log"; : > "$LOG"
  ( cd "$ROOT" && NEXT_TELEMETRY_DISABLED=1 MERGEN_ROTA_DB_SERVER=sql.ui.internal MERGEN_ROTA_DB_DATABASE=MERGEN_Rota MERGEN_ROTA_AUTH_MODE=development \
    MERGEN_ROTA_DEV_IDENTITY_ENABLED=true MERGEN_ROTA_DEV_SICIL=${SICIL[$P]} MERGEN_ROTA_AI_ENABLED=true MERGEN_ROTA_AI_TOOLS_ENABLED=true \
    MERGEN_ROTA_AI_BASE_URL=http://127.0.0.1:18731/v1 MERGEN_ROTA_AI_DEFAULT_API_KEY=ui-acceptance-key MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY=$MASTER \
    MERGEN_ROTA_AI_MODEL_REGISTRY_PATH="$HERE/registry.json" MERGEN_ROTA_AI_ANSWER_COMPOSITION=true MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS=200000 \
    MERGEN_ROTA_LOG_FORMAT=json NODE_OPTIONS="${NODE_OPTIONS:-} --import file://$HERE/loader.mjs" \
    setsid node node_modules/next/dist/bin/next start -p ${PORT[$P]} > "$LOG" 2>&1 < /dev/null & echo $! > "$UI_ACCEPTANCE_DIR/app.pid" )
  for _ in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:${PORT[$P]}/ && break; sleep 1; done
  node "$HERE/drive.cjs" "$HERE/scenarios/$P.json" "$UI_ACCEPTANCE_DIR/out" | tee -a "$UI_ACCEPTANCE_DIR/run.log"
  kill -- -"$(cat "$UI_ACCEPTANCE_DIR/app.pid")" 2>/dev/null; sleep 2
done
[ -n "${BRIDGE:-}" ] && kill "$BRIDGE"
