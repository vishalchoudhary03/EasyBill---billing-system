#!/usr/bin/env bash
# ================================================================
# deploy.sh — EasyBill deploy script with cache-busting
#
# Stamps a fresh version identifier into index.html (meta tag) and
# sw.js (SW_VERSION constant) on every deploy, so:
#   - The Service Worker registration URL (?v=VERSION) changes,
#     forcing browsers to re-evaluate sw.js instead of reusing a
#     stale cached copy of the script itself.
#   - sw.js's CACHE_NAME changes, which causes the `activate` event
#     to purge every previous version's cache automatically.
#
# Usage:
#   ./deploy.sh
#
# Requires: firebase-tools CLI installed and authenticated
#           (npm install -g firebase-tools && firebase login)
# ================================================================
set -euo pipefail

# Prefer the short git commit hash when available (stable, human-
# readable, and unique per deploy); fall back to a timestamp.
if git rev-parse --short HEAD >/dev/null 2>&1; then
  VERSION="$(git rev-parse --short HEAD)"
else
  VERSION="$(date +%s)"
fi

echo "Deploying EasyBill version: ${VERSION}"

HTML_FILE="index.html"
SW_FILE="sw.js"

if [ ! -f "$HTML_FILE" ] || [ ! -f "$SW_FILE" ]; then
  echo "Error: expected ${HTML_FILE} and ${SW_FILE} in the current directory." >&2
  exit 1
fi

# Make backups so we can always restore the placeholder afterwards, even
# if something goes wrong mid-deploy.
cp "$HTML_FILE" "${HTML_FILE}.bak"
cp "$SW_FILE" "${SW_FILE}.bak"

# Inject the version into both files.
sed -i.tmp "s/__APP_VERSION__/${VERSION}/g" "$HTML_FILE" && rm -f "${HTML_FILE}.tmp"
sed -i.tmp "s/__APP_VERSION__/${VERSION}/g" "$SW_FILE" && rm -f "${SW_FILE}.tmp"

# Deploy to Firebase Hosting.
firebase deploy --only hosting

# Restore the source files to their placeholder state so the working
# tree stays clean and the next deploy starts fresh (important if
# index.html / sw.js are tracked in git).
mv "${HTML_FILE}.bak" "$HTML_FILE"
mv "${SW_FILE}.bak" "$SW_FILE"

echo "Deploy complete. Version ${VERSION} is now live."