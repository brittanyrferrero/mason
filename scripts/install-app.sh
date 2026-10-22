#!/bin/sh
# Builds Mason and swaps it into ~/Applications. Quitting Mason only detaches: sessions keep running in tmux
# and reappear when the new version opens.
set -e
cd "$(dirname "$0")/.."
npm run dist >/dev/null   # also signs it (scripts/sign.mjs), so macOS keeps the permissions you granted
# Mason has to be fully gone before the swap: if it's still running, `open` below just brings the old copy forward.
# Ask nicely first; if it hasn't quit after 10 seconds, stop it (safe: sessions live in tmux, not in Mason).
gone() { for i in $(seq 1 "$1"); do pgrep -xq Mason || return 0; sleep 0.5; done; ! pgrep -xq Mason; }
if pgrep -xq Mason; then
  osascript -e 'quit app "Mason"' >/dev/null 2>&1 || true
  gone 20 || { pkill -TERM -x Mason; gone 10; } || { pkill -KILL -x Mason; gone 6; } || { echo "Mason wouldn't quit, so it wasn't replaced." >&2; exit 1; }
fi
rm -rf ~/Applications/Mason.app
cp -R dist/mac-arm64/Mason.app ~/Applications/
open ~/Applications/Mason.app
echo "Mason updated and reopened."
