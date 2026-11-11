#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

setup_url='https://github.com/radmirooch/claro/blob/main/docs/setup.md'
next_action='Проверьте требования в инструкции и повторите установку.'
trap 'printf "Установка остановлена. %s\n%s\n" "$next_action" "$setup_url" >&2' ERR

printf 'Проверяем macOS 14+ и Apple Silicon.\n'
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  printf 'Установка одной командой поддерживает macOS 14+ на Apple Silicon. Ручная установка — %s\n' "$setup_url" >&2
  exit 1
fi
macos_version=$(sw_vers -productVersion)
if (( ${macos_version%%.*} < 14 )); then
  printf 'Нужна macOS 14 или новее. Инструкция — %s\n' "$setup_url" >&2
  exit 1
fi

printf 'Проверяем Node.js 22.13+.\n'
node_ready() {
  command -v node >/dev/null 2>&1 && node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1);
  '
}
if ! node_ready; then
  if command -v brew >/dev/null 2>&1; then
    printf 'Нужен Node.js 22.13+. Выполнить brew install node? [Y/n] ' > /dev/tty || {
      printf 'Откройте Терминал, выполните brew install node и повторите установку.\n' >&2
      exit 1
    }
    answer=''
    read -r answer < /dev/tty || exit 1
    case "$answer" in
      ''|y|Y|yes|YES)
        next_action='Выполните brew install node и проверьте node --version.'
        brew install node
        hash -r
        ;;
      *)
        printf 'Установите Node.js с https://nodejs.org и повторите установку.\n'
        exit 1
        ;;
    esac
  else
    printf 'Установите Node.js 22.13+ с https://nodejs.org и повторите установку.\n' >&2
    exit 1
  fi
  if ! node_ready; then
    printf 'В PATH по-прежнему старая версия Node.js. Проверьте node --version и повторите установку.\n' >&2
    exit 1
  fi
fi

printf 'Проверяем git и папку Claro.\n'
if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
  printf 'Установите инструменты командной строки командой xcode-select --install, затем повторите установку.\n' >&2
  exit 1
fi
source_directory="$PWD"
if [[ -f "${BASH_SOURCE[0]:-}" ]]; then
  source_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
fi
next_action='Проверьте доступ к GitHub и локальные изменения в папке Claro, затем повторите установку.'
if [[ -f "$source_directory/scripts/setup.mjs" && -f "$source_directory/server.mjs" && -e "$source_directory/.git" ]]; then
  claro_directory="$source_directory"
else
  claro_directory="${CLARO_HOME:-$HOME/Claro}"
  if [[ -e "$claro_directory" ]]; then
    if [[ ! -e "$claro_directory/.git" || ! -f "$claro_directory/server.mjs" ]]; then
      printf 'Папка %s уже существует и не является репозиторием Claro. Выберите другую через CLARO_HOME.\n' "$claro_directory" >&2
      exit 1
    fi
    git -C "$claro_directory" pull --ff-only
  else
    git clone https://github.com/radmirooch/claro.git "$claro_directory"
  fi
fi
cd "$claro_directory"
claro_directory=$(pwd -P)

printf 'Проверяем uv для окружения распознавания.\n'
if ! command -v uv >/dev/null 2>&1; then
  printf 'Устанавливаем uv официальным установщиком astral.sh/uv/install.sh.\n'
  next_action='Проверьте доступ к https://astral.sh/uv/install.sh и повторите установку.'
  curl -fsSL https://astral.sh/uv/install.sh | sh
  hash -r
  command -v uv >/dev/null 2>&1
fi

printf 'Устанавливаем модели Claro, уже установленные используются повторно.\n'
next_action='Исправьте указанную выше ошибку и повторите npm run setup из папки Claro.'
node scripts/setup.mjs

printf 'Создаём ярлык в папке Applications пользователя.\n'
next_action='Проверьте права на ~/Applications и наличие существующего Claro.command.'
mkdir -p "$HOME/Applications"
launcher="$HOME/Applications/Claro.command"
if [[ -e "$launcher" && ! -L "$launcher" ]]; then
  printf 'Файл %s уже существует. Переместите его и повторите установку.\n' "$launcher" >&2
  exit 1
fi
chmod +x "$claro_directory/start.command"
ln -sfn "$claro_directory/start.command" "$launcher"
model_size=$(du -sh .runtime/huggingface .runtime/models 2>/dev/null | awk '{print $1}' | paste -sd ' ' -)
printf 'Установлено в %s\nМодели занимают (распознавание и перевод) — %s\nЗапуск — двойной клик по %s\nУдаление — bash "%s/scripts/uninstall.sh"\n' "$claro_directory" "$model_size" "$launcher" "$claro_directory"
