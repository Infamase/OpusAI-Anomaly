#!/usr/bin/env sh
# Mac / Linux: installs what the game needs (first run only), starts it and
# opens it in your browser. Press Ctrl+C to stop.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."
  exit 1
fi
[ -d node_modules ] || npm install || exit 1
echo "Starting the game at http://localhost:5173 (Ctrl+C to stop)"
npm run dev -- --open
