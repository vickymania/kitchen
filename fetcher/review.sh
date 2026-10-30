#!/bin/sh
# The nightly check, last in run.sh, only with REVIEW_MODE=on in config.env
# (default off). A headless Claude Code session (claude -p, the owner's own
# login on this server) reads the run log and the new purchases
# (fetcher/review.mjs prepare writes the prompt), checks the product-to-item
# links through the kitchen MCP server only (the reviewer device's token,
# which Claude never sees), fixes the clear-cut ones and answers a report;
# fetcher/review.mjs save keeps it in review-state/ and sends it to the app,
# also when Claude failed (not logged in, timeout, crash): then the report
# says so.
#
# Lean and locked down: a short system prompt of its own instead of Claude
# Code's (--system-prompt), no built-in tool at all (--tools ""), no skills
# or commands, no other MCP server (--strict-mcp-config), no user settings or
# plugins (--setting-sources project in an empty folder), only the kitchen
# tools below; anything else is denied without asking (--permission-mode
# dontAsk). Once a day, at most REVIEW_MAX_TURNS turns (25) and
# REVIEW_MAX_USD dollars (1), stopped after REVIEW_TIMEOUT seconds (900).
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$DIR/fetcher.log"
STATE="$DIR/review-state"
setting() {
  if [ -f "$DIR/config.env" ]; then
    sed -n "s/^$1=//p" "$DIR/config.env" | tail -n 1
  fi
}
[ "$(setting REVIEW_MODE)" = "on" ] || exit 0
MODEL="$(setting REVIEW_MODEL)"
[ -n "$MODEL" ] || MODEL=claude-sonnet-5-5
CLAUDE="$(setting REVIEW_CLAUDE)"
[ -n "$CLAUDE" ] || CLAUDE="$HOME/.local/bin/claude"
TURNS="$(setting REVIEW_MAX_TURNS)"
case "$TURNS" in ''|*[!0-9]*) TURNS=25 ;; esac
SECONDS_MAX="$(setting REVIEW_TIMEOUT)"
case "$SECONDS_MAX" in ''|*[!0-9]*) SECONDS_MAX=900 ;; esac
BUDGET="$(setting REVIEW_MAX_USD)"
case "$BUDGET" in ''|*[!0-9.]*) BUDGET=1 ;; esac
TOOLS="mcp__kitchen__kitchen_recent_purchases mcp__kitchen__kitchen_product_ratings mcp__kitchen__kitchen_pantry_get mcp__kitchen__kitchen_prices mcp__kitchen__kitchen_item_alias mcp__kitchen__kitchen_product_move"
SYSTEM="You check the nightly run of a household grocery app. Use only the kitchen tools. Follow the user's rules exactly and answer only with the JSON object asked for."

cd "$DIR" || exit 1
/usr/bin/node "$DIR/fetcher/review.mjs" prepare >> "$LOG" 2>&1
case $? in
  0) ;;
  3) exit 0 ;;
  *) echo "$(date -Is) review exit 1" >> "$LOG"; exit 1 ;;
esac
chmod 700 "$STATE"
rm -f "$STATE/claude.json" "$STATE/claude.err"
# An empty working folder: no CLAUDE.md, no project settings, nothing to read.
mkdir -p "$STATE/cwd"
if [ -x "$CLAUDE" ]; then
  # shellcheck disable=SC2086 # TOOLS is split on purpose: one argument per tool
  (cd "$STATE/cwd" && timeout "$SECONDS_MAX" "$CLAUDE" -p \
    --model "$MODEL" \
    --max-turns "$TURNS" \
    --max-budget-usd "$BUDGET" \
    --output-format json \
    --no-session-persistence \
    --system-prompt "$SYSTEM" \
    --tools "" \
    --disable-slash-commands \
    --setting-sources project \
    --strict-mcp-config --mcp-config "$STATE/mcp.json" \
    --permission-mode dontAsk \
    --allowedTools $TOOLS \
    < "$STATE/prompt.txt" > "$STATE/claude.json" 2> "$STATE/claude.err")
  CODE=$?
else
  echo "no claude at $CLAUDE" > "$STATE/claude.err"
  CODE=127
fi
/usr/bin/node "$DIR/fetcher/review.mjs" save "$CODE" >> "$LOG" 2>&1
echo "$(date -Is) review exit $?" >> "$LOG"
