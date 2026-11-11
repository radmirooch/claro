# Установка и настройка

Все загрузки моделей и бинарников — явные команды установки. `npm start` ничего не скачивает.

## Требования

- **Node.js 22.13+**. У Node-части нет npm-зависимостей, `npm install` не нужен.
- **macOS на Apple Silicon** для Qwen3-ASR (MLX/Metal). Whisper.cpp и Ollama работают и на других платформах, но там проект не проверялся.
- **uv** — для Python-окружения Qwen.
- **OpenSSL** — только для LAN-моста к телефону (`npm run mobile`).
- **cloudflared** — только для временного туннеля (`npm run remote`).

## 1. Распознавание речи (ASR)

### Qwen3-ASR (основной, рекомендуется)

```sh
npm run setup:qwen:mac
```

Создаёт `.runtime/qwen-venv`, ставит `mlx-qwen3-asr==0.4.4` и скачивает `moona3k/mlx-qwen3-asr-0.6b-4bit` (~0.5 ГБ, ревизия `4c59c533f95c84afb796655e814709034f826f04`) в `.runtime/huggingface`. Это community-реализация на MLX, а не официальный CUDA-рантайм. При старте сервер прогревает модель коротким тихим фрагментом и только после этого разрешает запись.

Если окружение Qwen найдено, он становится движком по умолчанию. Можно работать только с Qwen, без Whisper.

### Whisper.cpp (альтернатива для сравнения)

Нужен `whisper-server` из [whisper.cpp](https://github.com/ggml-org/whisper.cpp) и **мультиязычная** GGML-модель. Модели `.en` не подходят. Сервер сам запускает `whisper-server` на порту 4318, если найдёт модель. Путь по умолчанию: `~/.cache/whisper-models/ggml-large-v3-turbo.bin`. Если Whisper уже запущен отдельно, укажи `WHISPER_URL`.

## 2. Перевод (Ollama)

### Локально в проекте (macOS)

```sh
npm run setup:translation:mac            # TranslateGemma 4B
npm run setup:translation:mac -- qwen3:4b  # или другая модель
```

Скачивает официальный Ollama v0.40.15 с проверкой контрольной суммы (~186 МБ) и модель (~3.3 ГБ) в `.runtime/`. Ollama работает на порту 11435 с `OLLAMA_NO_CLOUD=1`. Скрипт создаёт `.env`, только если его ещё нет. Иначе он выводит строки, которые нужно добавить вручную. Существующая установка Ollama не трогается.

### Уже установленная Ollama

```sh
ollama pull translategemma:4b
ollama pull qwen3:4b      # для подстрочного перевода (значения слов)
```

Для подстрочного перевода нужна вторая модель, `GLOSS_MODEL`, по умолчанию `qwen3:4b`. Без неё перевод фраз работает, а значения слов — нет.

### Профили промптов

- `translategemma`: одно сообщение пользователю, ответ простым текстом с потоковой выдачей. Выбирается автоматически для имён на `translategemma`.
- `chat`: thinking выключен, ответ в виде JSON. Подходит для qwen3 и других чат-моделей.

Для своих имён моделей профиль задаётся через `OLLAMA_PROFILE`.

## Переменные окружения

`.env` читается при старте. Переменные из shell имеют приоритет. Шаблон — `.env.example`.

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `CLARO_DATA_DIR` | `<проект>/data` | Каталог SQLite-хранилища разговоров, файл `claro.sqlite`, права каталога `700` и файла `600` |
| `CLARO_STORAGE` | включено | `off` отключает хранилище и API разговоров. Сохранение также отключается настройкой «Сохранять разговоры» в клиенте |
| `PORT` | `4317` | Порт приложения (только 127.0.0.1) |
| `ASR_ENGINE` | `qwen`, если установлен, иначе `whisper` | Движок по умолчанию. В интерфейсе можно переключить |
| `QWEN_PYTHON` | `.runtime/qwen-venv/bin/python` | Python с mlx-qwen3-asr |
| `QWEN_MODEL` | локальный снапшот 0.6B-4bit | Другой чекпойнт. Его нужно скачать заранее |
| `WHISPER_PORT` | `4318` | Порт управляемого whisper-server |
| `WHISPER_BIN` | `whisper-server` из PATH | Путь к бинарнику |
| `WHISPER_MODEL` | `~/.cache/whisper-models/ggml-large-v3-turbo.bin` | GGML-модель |
| `WHISPER_CPU` | — | `1` отключает Metal |
| `WHISPER_URL` | — | Подключиться к уже запущенному Whisper вместо собственного |
| `OLLAMA_MODEL` | — | Модель перевода фраз. Пусто — перевод выключен |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Адрес Ollama, только loopback |
| `OLLAMA_BIN` | — | Запустить Ollama автоматически, если адрес недоступен |
| `OLLAMA_PROFILE` | авто | `translategemma` или `chat` |
| `OLLAMA_NUM_GPU` | `0` | `0` — CPU, `99` — полный GPU. GPU быстрее, но делит Metal с Qwen |
| `OLLAMA_NUM_THREAD` | `2` | Потоки CPU для перевода |
| `GLOSS_MODEL` | `qwen3:4b` | Модель значений слов |
| `GLOSS_URL` | `OLLAMA_URL` | Отдельный экземпляр Ollama для значений слов |
| `GLOSS_NUM_GPU` | `0` | GPU для значений слов |
| `CLOUDFLARED_BIN` | `cloudflared` из PATH | Для `npm run remote` |
| `QWEN_SETUP_PYTHON` | `3.12` | Версия Python для venv Qwen (передаётся в `uv venv --python`) |
| `CLARO_BENCHMARK_URL` | `http://127.0.0.1:4317` | Адрес Claro для скриптов бенчмарков |

Модель значений слов создаётся, только когда задан `OLLAMA_MODEL`.

Модели в Ollama остаются в памяти 30 минут после последнего запроса.

**Текущая конфигурация этого Mac** (M4, 16 ГБ): TranslateGemma 4B на GPU (`OLLAMA_NUM_GPU=99`), Qwen3 4B для значений слов на CPU, Ollama проекта запускается через `OLLAMA_BIN`.

## Запуск

```sh
npm start            # или ./start.command
```

Серверные изменения требуют перезапуска. Файлы из `public/` отдаются с диска без сборки, поэтому достаточно обновить страницу.

## Бенчмарки

```sh
npm run benchmark:asr -- /path/to/speech.wav --interval=1.5 --translation --output=.runtime/benchmark.json
node scripts/benchmark-fleurs.mjs .runtime/eval-fleurs-es asr|live|cadence|translation
```

Запускай при остановленном микрофоне: тесты делят движки с живой записью. На вход — WAV PCM16 моно 16 кГц, 0,1–15 с. Результаты и методика — в [benchmarks/](benchmarks/).
