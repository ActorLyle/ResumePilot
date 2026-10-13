#!/bin/bash
set -u

cd "$(dirname "$0")" || exit 1

if [ ! -d "node_modules" ]; then
  echo "Installing project dependencies..."
  if ! npm install; then
    echo "Dependency installation failed. Check Node.js and npm, then try again."
    read -r -p "Press Return to close this window..."
    exit 1
  fi
fi

npm start &
server_pid=$!
ready=0
for _ in {1..30}; do
  if curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:3002/api/health" 2>/dev/null | grep -q 'resume-expert-ark-proxy' \
    && curl --noproxy '*' -fsS --max-time 1 "http://localhost:5173/api/health" 2>/dev/null | grep -q 'resume-expert-ark-proxy'; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit $?
  fi
  sleep 1
done

if [ "$ready" -eq 1 ]; then
  open "http://localhost:5173"
else
  echo "The resume expert did not start. Check the service output and make sure ports 5173 and 3002 are available."
  read -r -p "Press Return to close this window..."
  exit 1
fi

wait "$server_pid"
