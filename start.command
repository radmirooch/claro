#!/bin/zsh
set -eu
unsetopt BG_NICE
cd "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  print -u2 'Node.js не найден. Установите Node.js 22.13+ с https://nodejs.org.'
  exit 1
fi
port=$(node <<'NODE'
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13))
  process.exit(1);
try {
  process.loadEnvFile('.env');
} catch (error) {
  if (error.code !== 'ENOENT')
    process.exit(1);
}
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  process.exit(1);
console.log(port);
NODE
) || {
  print -u2 'Не удалось прочитать PORT. Проверьте настройки и версию Node.js 22.13+.'
  exit 1
}
url="http://127.0.0.1:$port/"
server_ready() {
  curl --silent --fail --max-time 1 --output /dev/null "${url}api/config"
}
open_window() {
  if [[ -d '/Applications/Google Chrome.app' || -d "$HOME/Applications/Google Chrome.app" ]]; then
    open -na 'Google Chrome' --args "--app=$url"
  else
    open "$url"
  fi
}
if server_ready; then
  open_window
  exit 0
fi

server_pid=''
stop_server() {
  if [[ -n "$server_pid" ]]; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap stop_server EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
launch_server() {
  node "$PWD/server.mjs" &
  server_pid=$!
}
launch_server
# Each probe takes at most one second, keeping the total wait within 30 seconds.
deadline=$(( SECONDS + 30 ))
while (( SECONDS < deadline )); do
  if server_ready; then
    open_window
    print 'Claro работает. Закройте это окно, чтобы остановить'
    wait "$server_pid"
    exit $?
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    print -u2 'Сервер остановился. Проверьте сообщение выше и повторите запуск.'
    exit 1
  fi
  sleep 0.2
done
print -u2 'Сервер не ответил за 30 секунд. Проверьте PORT и сообщения выше, затем повторите запуск.'
exit 1
