#!/bin/sh
# The daily run, started by crontab (installed by fetcher/deploy.mjs): the
# deals, then Thomas's new AH receipts, then his Lidl Plus receipts and coupons,
# then the shelf prices from Checkjebon, and last the nightly Claude check
# (fetcher/review.sh, only with REVIEW_MODE=on).
# MODE in config.env decides for the deals, AH_MODE for the AH receipts,
# LIDL_MODE for Lidl Plus, PRICES_MODE for the shelf prices: dry-run (counts
# only, sends nothing) or push. All four default to dry-run.
# The log is capped: past 512 KB it moves to fetcher.log.1 (one old copy).
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/fetcher.log"
setting() {
  if [ -f "$DIR/config.env" ]; then
    sed -n "s/^$1=//p" "$DIR/config.env" | tail -n 1
  fi
}
MODE="$(setting MODE)"
case "$MODE" in push|dry-run) ;; *) MODE=dry-run ;; esac
AH_MODE="$(setting AH_MODE)"
case "$AH_MODE" in push|dry-run) ;; *) AH_MODE=dry-run ;; esac
LIDL_MODE="$(setting LIDL_MODE)"
case "$LIDL_MODE" in push|dry-run) ;; *) LIDL_MODE=dry-run ;; esac
PRICES_MODE="$(setting PRICES_MODE)"
case "$PRICES_MODE" in push|dry-run) ;; *) PRICES_MODE=dry-run ;; esac
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 524288 ]; then
  mv "$LOG" "$LOG.1"
fi
cd "$DIR" || exit 1
# The start marker of this run: fetcher/review.mjs reads the log from the last one on.
echo "$(date -Is) run start" >> "$LOG"
/usr/bin/node "$DIR/fetcher/fetch.mjs" "$MODE" >> "$LOG" 2>&1
echo "$(date -Is) exit $?" >> "$LOG"
# The receipts run whatever the deals did: they do not depend on each other.
/usr/bin/node "$DIR/fetcher/ah_import.mjs" "$AH_MODE" >> "$LOG" 2>&1
echo "$(date -Is) ah exit $?" >> "$LOG"
# Lidl Plus whatever AH did: its own session, its own state, its own exit line.
/usr/bin/node "$DIR/fetcher/lidl_import.mjs" "$LIDL_MODE" >> "$LOG" 2>&1
echo "$(date -Is) lidl exit $?" >> "$LOG"
# The shelf prices last, whatever came before: Checkjebon has nothing to do with the rest.
/usr/bin/node "$DIR/fetcher/prices.mjs" "$PRICES_MODE" >> "$LOG" 2>&1
echo "$(date -Is) prices exit $?" >> "$LOG"
# The nightly check last: it reads what the runs above did (REVIEW_MODE=on only).
sh "$DIR/fetcher/review.sh"
