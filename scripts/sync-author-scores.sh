#!/usr/bin/env bash
# Crawls the scene graph and syncs author scores to the production Fly DB.
#
# Usage:
#   yarn syncSceneGraph
#
# What it does:
#   1. Runs crawlSceneGraph into a temp SQLite file
#   2. Exports the resulting author_score rows as SQL
#   3. Pipes them into the prod DB via fly ssh console
#   4. Restarts the machine so loadAuthorAffinity() picks up the new scores
#
# Requirements: fly CLI authenticated, correct app context set.

set -euo pipefail

TMPDB=$(mktemp /tmp/blueska-crawl-XXXXXX.db)
trap "rm -f '$TMPDB'" EXIT

echo "==> Crawling scene graph into $TMPDB..."
FEEDGEN_SQLITE_LOCATION="$TMPDB" yarn --silent crawlSceneGraph

ROW_COUNT=$(sqlite3 "$TMPDB" "SELECT COUNT(*) FROM author_score;")
echo ""
echo "==> Syncing $ROW_COUNT author_score rows to prod..."
sqlite3 "$TMPDB" \
  "SELECT 'INSERT OR REPLACE INTO author_score(did,score,tier,updatedAt) VALUES(' || quote(did) || ',' || score || ',' || quote(tier) || ',' || quote(updatedAt) || ');' FROM author_score;" \
  | fly ssh console --command "sqlite3 /data/blueska.db"

echo "==> Restarting machine to load new scores..."
MACHINE_ID=$(fly machine list --json | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
fly machine restart "$MACHINE_ID"

echo ""
echo "Done. The feed will use updated author scores within ~30s."
