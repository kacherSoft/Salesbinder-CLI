#!/usr/bin/env bash
set -u
CLI_DIR="/home/kacher/.openclaw/workspace/Salesbinder-CLI"
PID="3885595"
SESSION_ID="wild-orbit"
SLACK_TARGET="user:U07RG76P3EE"
SLACK_REPLY_TO="1782559916.924249"
CHECKPOINT="$HOME/.salesbinder/cache/item-full-sync-only-default.json"
LOG_DIR="$HOME/.openclaw/workspace/logs"
MONITOR_LOG="$LOG_DIR/item-full-sync-monitor.log"
mkdir -p "$LOG_DIR"
cd "$CLI_DIR" || exit 1

send_slack() {
  local msg="$1"
  openclaw message send --channel slack --target "$SLACK_TARGET" --reply-to "$SLACK_REPLY_TO" --message "$msg" >>"$MONITOR_LOG" 2>&1 || true
}

status_json() {
  env $(grep -v '^#' .env | xargs) SALESBINDER_READ_BACKEND=postgresql node packages/cli/dist/cli.js cache status 2>/dev/null || echo '{}'
}

make_report() {
  local now status running pid_alive cp page item_idx estimated_processed item_count stock_count sync_status sync_msg run_id started updated failed_msg rate429 line_docs doc_count
  now="$(date '+%Y-%m-%d %H:%M:%S %Z')"
  status="$(status_json)"
  pid_alive="no"
  if ps -p "$PID" >/dev/null 2>&1; then pid_alive="yes"; fi
  cp="{}"
  if [ -f "$CHECKPOINT" ]; then cp="$(cat "$CHECKPOINT" 2>/dev/null || echo '{}')"; fi

  page="$(node -e 'const fs=require("fs"); const p=process.argv[1]; try{const j=JSON.parse(fs.readFileSync(p,"utf8")); console.log(j.page??"?")}catch{console.log("-")}' "$CHECKPOINT")"
  item_idx="$(node -e 'const fs=require("fs"); const p=process.argv[1]; try{const j=JSON.parse(fs.readFileSync(p,"utf8")); console.log(j.itemIndex??"?")}catch{console.log("-")}' "$CHECKPOINT")"
  estimated_processed="$(node -e 'const fs=require("fs"); const p=process.argv[1]; try{const j=JSON.parse(fs.readFileSync(p,"utf8")); const page=Number(j.page||1), idx=Number(j.itemIndex||0); console.log(Math.max(0,(page-1)*100+idx))}catch{console.log("?")}' "$CHECKPOINT")"
  item_count="$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{let j=JSON.parse(s);console.log(j.item_count??"?")}catch{console.log("?")}})')"
  stock_count="$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{let j=JSON.parse(s);console.log(j.stock_location_count??"?")}catch{console.log("?")}})')"
  doc_count="$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{let j=JSON.parse(s);console.log(j.document_count??"?")}catch{console.log("?")}})')"
  line_docs="$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{let j=JSON.parse(s);console.log((j.sync_status?.documentsProcessed??"?")+"/"+(j.sync_status?.lineItemsProcessed??"?"))}catch{console.log("?/?")}})')"
  sync_status="$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{let j=JSON.parse(s);console.log(j.sync_status?.status??"?")}catch{console.log("?")}})')"
  sync_msg="$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{let j=JSON.parse(s);console.log(j.sync_status?.message??"")}catch{console.log("")}})')"
  failed_msg="$(printf '%s\n%s' "$status" "$cp" | grep -iE '429|rate.?limit|too many requests' | head -3 | tr '\n' ' ' || true)"
  rate429="No 429 seen"
  if [ -n "$failed_msg" ]; then rate429="⚠️ Possible 429/rate-limit: $failed_msg"; fi

  if [ "$sync_status" = "success" ] || [ "$pid_alive" = "no" ]; then
    printf '*SalesBinder item-only full sync status* — %s\n• Process alive: `%s`\n• Sync status: `%s` — %s\n• Checkpoint: page `%s`, item `%s` (~`%s` items scanned this run)\n• DB total rows: items `%s`, stock rows `%s`, docs `%s`\n• Documents/line items processed by this run: `%s`\n• 429 check: %s\n\nEm sẽ stop monitor nếu run đã xong/fail.' "$now" "$pid_alive" "$sync_status" "$sync_msg" "$page" "$item_idx" "$estimated_processed" "$item_count" "$stock_count" "$doc_count" "$line_docs" "$rate429"
  else
    printf '*SalesBinder item-only full sync status* — %s\n• Running: yes (pid `%s`)\n• Sync status: `%s` — %s\n• Checkpoint: page `%s`, item `%s` (~`%s` items scanned this run)\n• DB total rows: items `%s`, stock rows `%s`, docs `%s`\n• Documents/line items processed by this run: `%s`\n• 429 check: %s' "$now" "$PID" "$sync_status" "$sync_msg" "$page" "$item_idx" "$estimated_processed" "$item_count" "$stock_count" "$doc_count" "$line_docs" "$rate429"
  fi
}

# Wait 15 minutes before first scheduled report; Kacher already got immediate status just before this monitor.
while true; do
  sleep 900
  report="$(make_report)"
  echo "$(date -Is) $report" >>"$MONITOR_LOG"
  send_slack "$report"
  status="$(status_json)"
  sync_status="$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{let j=JSON.parse(s);console.log(j.sync_status?.status??"?")}catch{console.log("?")}})')"
  if [ "$sync_status" = "success" ] || [ "$sync_status" = "failed" ] || ! ps -p "$PID" >/dev/null 2>&1; then
    exit 0
  fi
done
