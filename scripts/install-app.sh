#!/bin/sh
# Builds Mason and swaps it into ~/Applications. Quitting Mason only detaches: sessions keep running in tmux
# and reappear when the new version opens.
set -e
cd "$(dirname "$0")/.."
npm run dist >/dev/null   # also signs it (scripts/sign.mjs), so macOS keeps the permissions you granted
if pgrep -xq Mason; then
  osascript -e 'quit app "Mason"'
  for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq Mason || break; sleep 0.5; done
fi
rm -rf ~/Applications/Mason.app
cp -R dist/mac-arm64/Mason.app ~/Applications/
open ~/Applications/Mason.app
echo "Mason updated and reopened."
