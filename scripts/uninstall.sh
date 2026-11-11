#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
project=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
if [[ "$project" == / || "$project" == "$HOME" || ! -f "$project/server.mjs" || ! -f "$project/package.json" ]]; then
  printf 'Не удалось определить папку Claro. Запустите scripts/uninstall.sh из проекта.\n' >&2
  exit 1
fi
trap 'printf "Удаление остановлено. Проверьте права на папку Claro и повторите команду.\n" >&2' ERR
confirm() {
  local answer=''
  printf '%s [y/N] ' "$1" > /dev/tty || return 1
  read -r answer < /dev/tty || return 1
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes ]]
}

printf 'Останавливаем сервер Claro этой папки.\n'
server_pid=''
if [[ -f "$project/.runtime/claro.pid" ]]; then
  read -r server_pid < "$project/.runtime/claro.pid" || true
fi
# Also find servers started before the PID file was introduced.
candidates="${server_pid} $(pgrep -f 'node .*server[.]mjs' || true)"
for candidate in $candidates; do
  [[ "$candidate" =~ ^[0-9]+$ ]] || continue
  server_command=$(ps -p "$candidate" -o command= || true)
  server_directory=$(lsof -a -p "$candidate" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)
  if [[ "$server_directory" == "$project" && "$server_command" == *node*server.mjs* ]]; then
    kill -TERM "$candidate" 2>/dev/null || true
    for ((attempt=0; attempt<50; attempt++)); do
      kill -0 "$candidate" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$candidate" 2>/dev/null; then
      printf 'Сервер ещё работает. Закройте окно запуска и повторите удаление.\n' >&2
      exit 1
    fi
    printf 'Сервер остановлен.\n'
  fi
done
rm -rf -- "$project/.runtime"
printf 'Удалено — %s/.runtime\n' "$project"
launcher="$HOME/Applications/Claro.command"
if [[ -L "$launcher" && "$(readlink "$launcher")" == "$project/start.command" ]]; then
  rm -- "$launcher"
  printf 'Удалено — %s\n' "$launcher"
fi
if [[ -d "$project/data" ]] && confirm 'Удалить сохранённые разговоры в data/?'; then
  rm -rf -- "$project/data"
  printf 'Удалено — %s/data\n' "$project"
fi
if [[ -d "$project/data" ]]; then
  printf 'Разговоры сохранены в %s/data. Папка проекта сохранена вместе с ними.\n' "$project"
elif confirm "Удалить папку проекта $project?"; then
  cd "$HOME"
  rm -rf -- "$project"
  printf 'Удалено — %s\n' "$project"
else
  printf 'Папка проекта сохранена — %s\n' "$project"
fi
printf 'Удаление завершено. Данные из CLARO_DATA_DIR, если он задан, остаются по выбранному пути.\n'
