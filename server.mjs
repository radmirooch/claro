import http from 'node:http';
import { readFile, access, mkdir, chmod, open, writeFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WhisperAdapter, validateWav } from './lib/whisper.mjs';
import { QwenAdapter } from './lib/qwen.mjs';
import { warmModels } from './lib/warmup.mjs';
import { OllamaTranslator, localURL } from './lib/translation.mjs';
import { LANGUAGES, languageByCode } from './public/languages.js';

import { MODULES } from './public/modules.js';
import { SessionStore } from './lib/sessions.mjs';
import { sessionRoute } from './lib/session-api.mjs';

const root = new URL('./public/', import.meta.url);
const assets = {
  '/': ['index.html', 'text/html'],
  '/appearance.js': ['appearance.js', 'text/javascript'],
  '/app.js': ['app.js', 'text/javascript'],
  '/languages.js': ['languages.js', 'text/javascript'],
  '/audio.js': ['audio.js', 'text/javascript'],
  '/capture-worklet.js': ['capture-worklet.js', 'text/javascript'],
  '/state.js': ['state.js', 'text/javascript'],
  '/dom.js': ['dom.js', 'text/javascript'],
  '/preferences.js': ['preferences.js', 'text/javascript'],
  '/render.js': ['render.js', 'text/javascript'],
  '/render-history.js': ['render-history.js', 'text/javascript'],
  '/translation-jobs.js': ['translation-jobs.js', 'text/javascript'],
  '/gloss-jobs.js': ['gloss-jobs.js', 'text/javascript'],
  '/capture.js': ['capture.js', 'text/javascript'],
  '/watch.js': ['watch.js', 'text/javascript'],
  '/readiness.js': ['readiness.js', 'text/javascript'],
  '/settings.js': ['settings.js', 'text/javascript'],
  '/persistence.js': ['persistence.js', 'text/javascript'],
  '/library.js': ['library.js', 'text/javascript'],
  '/participant-settings.js': ['participant-settings.js', 'text/javascript'],
  '/demo.js': ['demo.js', 'text/javascript'],
  '/live.js': ['live.js', 'text/javascript'],
  '/stream.js': ['stream.js', 'text/javascript'],
  '/annotations.js': ['annotations.js', 'text/javascript'],
  '/participants.js': ['participants.js', 'text/javascript'],
  '/reading.js': ['reading.js', 'text/javascript'],
  '/modules.js': ['modules.js', 'text/javascript'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/mobile': ['index.html', 'text/html'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/style.css': ['style.css', 'text/css']
};
const fail = (status, message) => Object.assign(new Error(message), { status });
async function body(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max)
      throw fail(413, 'Слишком большой фрагмент.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function createApp({
  asr,
  engines = null,
  defaultEngine = 'whisper',
  translator = null,
  glosser = null,
  store = null,
  health = () => ({ ready: true }),
  port = 4317
}) {
  const token = randomUUID(),
    subscribers = new Set();
  let busy = false,
    translating = false,
    glossing = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const boundPort = server.address()?.port || port;
      const hosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
      if (!hosts.has(req.headers.host))
        throw fail(403, 'Недопустимый адрес.');
      if (
        req.headers.origin &&
        ![`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`].includes(
          req.headers.origin
        )
      )
        throw fail(403, 'Недопустимый источник.');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        const data = await readFile(new URL(file, root));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(data);
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        const translation = translator
          ? await translator.status()
          : { ready: false, provider: null, message: 'Локальный переводчик не настроен' };
        const engineStates = engines
          ? Object.fromEntries(Object.entries(engines).map(([key, value]) => [key, value.health()]))
          : { whisper: health() };
        const gloss = glosser ? await glosser.status() : { ready: false };
        return json(200, {
          token,
          ...health(),
          engines: engineStates,
          default_engine: defaultEngine,
          translator: translation.ready,
          translation,
          gloss,
          storage: { enabled: Boolean(store) },
          features: {
            sessions: Boolean(store),
            translation_streaming: true,
            live_translation: true,
            live_glosses: true,
            gloss_streaming: true,
            full_interlinear: true,
            manual_participants: true,
            diarization: false,
            voice_identity: false
          },
          modules: MODULES,
          languages: LANGUAGES,
          version: 1
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (url.searchParams.get('token') !== token)
          throw fail(403, 'Нужен токен сессии.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        subscribers.add(res);
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        req.on('close', () => {
          clearInterval(timer);
          subscribers.delete(res);
        });
        return;
      }
      if (url.pathname.startsWith('/api/sessions')) {
        if (!store)
          throw fail(404, 'Не найдено.');
        if (req.headers['x-session-token'] !== token)
          throw fail(403, 'Нужен токен сессии.');
        return json(200, await sessionRoute(req, url, store));
      }
      if (req.method !== 'POST')
        throw fail(404, 'Не найдено.');
      if (req.headers['x-session-token'] !== token)
        throw fail(403, 'Нужен токен сессии.');
      if (url.pathname === '/api/transcribe') {
        const engine = url.searchParams.get('engine') || defaultEngine;
        const selected = engines ? engines[engine] : engine === 'whisper' ? { asr, health } : null;
        if (!selected)
          throw fail(400, 'Неизвестный движок распознавания.');
        if (!selected.health().ready)
          throw fail(503, selected.health().message || 'Модель ещё загружается.');
        if (busy)
          throw fail(429, 'Распознавание занято.');
        const language = url.searchParams.get('language') || 'es';
        if (!languageByCode(language))
          throw fail(400, 'Неподдерживаемый язык.');
        let live;
        if (url.searchParams.has('caption_id')) {
          const id = url.searchParams.get('caption_id'),
            revision = Number(url.searchParams.get('revision')),
            interval = Number(url.searchParams.get('interval'));
          const finalValue = url.searchParams.get('final');
          if (
            !/^[a-zA-Z0-9_-]{1,100}$/.test(id) ||
            !Number.isSafeInteger(revision) ||
            revision < 1 ||
            ![1, 1.5, 2].includes(interval) ||
            !['true', 'false'].includes(finalValue)
          )
            throw fail(400, 'Некорректное обновление субтитров.');
          live = { id, revision, interval, final: finalValue === 'true' };
        }
        busy = true;
        try {
          const wav = await body(req, 500000);
          let duration;
          try {
            duration = validateWav(wav);
          } catch (e) {
            throw fail(400, e.message);
          }
          const started = performance.now();
          const text = await selected.asr.transcribe(wav, language, live);
          const event = {
            version: 1,
            type: 'caption',
            id: live?.id || randomUUID(),
            revision: live?.revision || 1,
            engine,
            source_language: language,
            text,
            translation: null,
            final: live?.final ?? true,
            audio_seconds: duration,
            processing_ms: Math.round(performance.now() - started),
            created_at: new Date().toISOString()
          };
          for (const client of subscribers)
            client.write(`data: ${JSON.stringify(event)}\n\n`);
          return json(200, event);
        } finally {
          busy = false;
        }
      }
      if (
        ['/api/translate', '/api/translate-stream', '/api/gloss', '/api/gloss-stream'].includes(
          url.pathname
        )
      ) {
        const hints = url.pathname.startsWith('/api/gloss'),
          provider = hints ? glosser : translator;
        const streaming = url.pathname.endsWith('-stream');
        let input;
        try {
          input = JSON.parse((await body(req, 40000)).toString());
        } catch {
          throw fail(400, 'Нужен JSON.');
        }
        // "language" remains accepted for v0.1 clients, but target is now explicit.
        const source = input?.source_language ?? input?.language,
          target = input?.target_language;
        if (
          typeof input?.text !== 'string' ||
          !input.text.trim() ||
          input.text.length > 3000 ||
          !languageByCode(source) ||
          !languageByCode(target) ||
          (input.caption_id != null &&
            (typeof input.caption_id !== 'string' || input.caption_id.length > 100))
        )
          throw fail(400, 'Укажи текст, source_language и target_language из списка языков.');
        if (
          hints &&
          (typeof input.translation !== 'string' ||
            !input.translation.trim() ||
            input.translation.length > 4000)
        )
          throw fail(400, 'Для подсказок нужен перевод фразы.');
        const response = {
          version: 1,
          type: hints ? 'gloss' : 'translation',
          caption_id: input.caption_id ?? null,
          source_language: source,
          target_language: target
        };
        if (hints && source === target)
          return json(200, { ...response, glosses: [], processing_ms: 0 });
        if (source === target)
          return json(200, { ...response, translation: input.text, processing_ms: 0 });
        if (!provider || !(await provider.status()).ready)
          throw fail(
            503,
            hints ? 'Модель подсказок не установлена.' : 'Локальный переводчик пока не готов.'
          );
        if (hints ? glossing : translating)
          throw fail(429, hints ? 'Подсказки заняты.' : 'Переводчик занят.');
        if (hints)
          glossing = true;
        else
          translating = true;
        const controller = new AbortController();
        const disconnected = () => {
          if (!res.writableEnded)
            controller.abort();
        };
        res.on('close', disconnected);
        try {
          const started = performance.now();
          let output;
          if (streaming) {
            res.writeHead(200, {
              'Content-Type': 'application/x-ndjson; charset=utf-8',
              'X-Accel-Buffering': 'no'
            });
            res.flushHeaders();
            const partial = output => {
              if (!res.destroyed)
                res.write(
                  JSON.stringify({
                    ...response,
                    ...output,
                    final: false,
                    processing_ms: Math.round(performance.now() - started)
                  }) + '\n'
                );
            };
            output = hints
              ? {
                  glosses: await provider.gloss(
                    input.text,
                    source,
                    target,
                    input.translation,
                    controller.signal,
                    glosses => partial({ glosses })
                  )
                }
              : {
                  translation: await provider.translate(
                    input.text,
                    source,
                    target,
                    translation => partial({ translation }),
                    controller.signal
                  )
                };
          } else
            output = hints
              ? {
                  glosses: await provider.gloss(
                    input.text,
                    source,
                    target,
                    input.translation,
                    controller.signal
                  )
                }
              : {
                  translation: await provider.translate(
                    input.text,
                    source,
                    target,
                    undefined,
                    controller.signal
                  )
                };
          const event = {
            ...response,
            ...output,
            processing_ms: Math.round(performance.now() - started)
          };
          for (const client of subscribers)
            client.write(`data: ${JSON.stringify(event)}\n\n`);
          if (streaming) {
            res.end(JSON.stringify({ ...event, final: true }) + '\n');
            return;
          }
          return json(200, event);
        } catch (error) {
          if (streaming && res.headersSent) {
            res.end(
              JSON.stringify({
                error: hints ? 'Не удалось завершить подсказки.' : 'Не удалось завершить перевод.',
                final: true
              }) + '\n'
            );
            return;
          }
          throw error;
        } finally {
          res.off('close', disconnected);
          if (hints)
            glossing = false;
          else
            translating = false;
        }
      }
      throw fail(404, 'Не найдено.');
    } catch (error) {
      if (!res.headersSent)
        json(error.status || 502, {
          error: error.status ? error.message : 'Локальный движок недоступен или не успел ответить.'
        });
      else
        res.end();
    }
  });
  server.on('close', () => {
    for (const client of subscribers)
      client.end();
  });
  return server;
}

async function main() {
  try {
    process.loadEnvFile(new URL('./.env', import.meta.url));
  } catch (e) {
    if (e.code !== 'ENOENT')
      throw e;
  }
  let store;
  if (process.env.CLARO_STORAGE !== 'off') {
    try {
      const directory = process.env.CLARO_DATA_DIR
        ? resolve(process.env.CLARO_DATA_DIR)
        : fileURLToPath(new URL('./data/', import.meta.url));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const databasePath = join(directory, 'claro.sqlite');
      const file = await open(databasePath, 'a', 0o600);
      await file.close();
      await chmod(databasePath, 0o600);
      store = new SessionStore(databasePath);
    } catch {
      console.error('Хранилище разговоров недоступно. Субтитры продолжают работать.');
    }
  }
  const port = Number(process.env.PORT || 4317);
  const enginePort = Number(process.env.WHISPER_PORT || 4318);
  const engineURL = localURL(process.env.WHISPER_URL || `http://127.0.0.1:${enginePort}`);
  const model =
    process.env.WHISPER_MODEL || `${homedir()}/.cache/whisper-models/ggml-large-v3-turbo.bin`;
  let state = { ready: false, installed: true, message: 'Whisper загружается…' },
    child,
    translationChild;
  const translator = process.env.OLLAMA_MODEL
    ? new OllamaTranslator(
        process.env.OLLAMA_MODEL,
        process.env.OLLAMA_URL,
        process.env.OLLAMA_PROFILE
      )
    : null;
  const glosser = translator
    ? new OllamaTranslator(
        process.env.GLOSS_MODEL || 'qwen3:4b',
        process.env.GLOSS_URL || process.env.OLLAMA_URL,
        'chat'
      )
    : null;
  const qwenPython =
    process.env.QWEN_PYTHON ||
    fileURLToPath(new URL('./.runtime/qwen-venv/bin/python', import.meta.url));
  let qwen;
  const defaultQwenModel = fileURLToPath(
    new URL(
      './.runtime/huggingface/hub/models--moona3k--mlx-qwen3-asr-0.6b-4bit/snapshots/4c59c533f95c84afb796655e814709034f826f04',
      import.meta.url
    )
  );
  try {
    await access(qwenPython);
    qwen = new QwenAdapter({
      python: qwenPython,
      model: process.env.QWEN_MODEL || defaultQwenModel,
      env: { HF_HOME: fileURLToPath(new URL('./.runtime/huggingface', import.meta.url)) }
    });
  } catch {}
  const engines = { whisper: { asr: new WhisperAdapter(engineURL), health: () => state } };
  if (qwen) {
    const loadingStarted = Date.now();
    engines.qwen = {
      asr: qwen,
      health: () => {
        if (!qwen.state.ready && /загружается|прогревается/u.test(qwen.state.message) && Date.now() - loadingStarted > 120000)
          return { ready: false, message: 'Распознавание не загрузилось за 2 минуты. Проверьте установку и перезапустите Claro.' };
        return qwen.state;
      }
    };
  }
  const defaultEngine = process.env.ASR_ENGINE || (qwen ? 'qwen' : 'whisper');
  if (!engines[defaultEngine]) {
    qwen?.close();
    store?.close();
    throw new Error('Выбранный ASR_ENGINE не установлен.');
  }
  const app = createApp({
    engines,
    defaultEngine,
    translator,
    glosser,
    store,
    health: () => engines[defaultEngine].health(),
    port
  });
  app.once('close', () => store?.close());
  await new Promise((resolve, reject) => {
    app.once('error', error => {
      qwen?.close();
      store?.close();
      reject(error);
    });
    app.listen(port, '127.0.0.1', resolve);
  });
  const warming = new AbortController();
  const pidFile = new URL('./.runtime/claro.pid', import.meta.url);
  let ownsPidFile = false;
  let stopping = false;
  const stop = async () => {
    if (stopping)
      return;
    stopping = true;
    warming.abort();
    child?.kill('SIGTERM');
    qwen?.close();
    translationChild?.kill('SIGTERM');
    app.close();
    app.closeAllConnections();
    if (ownsPidFile) {
      try {
        if ((await readFile(pidFile, 'utf8')).trim() === String(process.pid))
          await unlink(pidFile);
      } catch {}
    }
    setTimeout(() => process.exit(), 500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  try {
    await mkdir(new URL('./.runtime/', import.meta.url), { recursive: true });
    await writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });
    ownsPidFile = true;
  } catch {
    console.error('Не удалось записать файл процесса. Для остановки закройте окно запуска.');
  }
  console.log(`Claro: http://127.0.0.1:${port}`);
  if (translator && process.env.OLLAMA_BIN) {
    // Only start an explicitly configured engine; never alter an existing daemon.
    let reachable = false;
    try {
      reachable = (await fetch(`${translator.url}/api/tags`, { signal: AbortSignal.timeout(1000) }))
        .ok;
    } catch {}
    if (stopping)
      return;
    if (!reachable) {
      translationChild = spawn(process.env.OLLAMA_BIN, ['serve'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          OLLAMA_HOST: new URL(translator.url).host,
          OLLAMA_MODELS: fileURLToPath(new URL('./.runtime/models', import.meta.url)),
          OLLAMA_NO_CLOUD: '1'
        }
      });
      translationChild.on('error', () =>
        console.error('Не удалось запустить Ollama. Проверь OLLAMA_BIN.')
      );
    }
  }
  if (stopping)
    return;
  void warmModels([translator, glosser], { signal: warming.signal });
  try {
    if (!process.env.WHISPER_URL) {
      await access(model);
      if (stopping)
        return;
      const args = [
        '-m',
        model,
        '--host',
        '127.0.0.1',
        '--port',
        String(enginePort),
        '-l',
        'es',
        '-t',
        '4',
        '-bs',
        '1',
        '-bo',
        '1',
        '-nf',
        '-sns'
      ];
      if (process.env.WHISPER_CPU === '1')
        args.push('-ng');
      child = spawn(process.env.WHISPER_BIN || 'whisper-server', args, {
        stdio: ['ignore', 'ignore', 'ignore']
      });
      child.on('error', error => {
        state = {
          ready: false,
          installed: error.code !== 'ENOENT',
          message: error.code === 'ENOENT'
            ? 'Распознавание не установлено — запустите npm run setup.'
            : 'Не удалось запустить whisper-server. Проверь WHISPER_BIN.'
        };
      });
      child.on('exit', code => {
        state = {
          ready: false,
          message: `Whisper завершился (${code}). Проверь модель или попробуй WHISPER_CPU=1.`
        };
      });
    }
    let attempts = 0;
    const poll = setInterval(async () => {
      if (child && (child.exitCode !== null || !child.pid))
        return clearInterval(poll);
      if (++attempts > 80) {
        state = {
          ready: false,
          message: 'Whisper не ответил за 2 минуты. Проверь настройки и перезапусти сервер.'
        };
        return clearInterval(poll);
      }
      try {
        const r = await fetch(`${engineURL}/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) {
          state = { ready: true, message: 'Whisper готов' };
          clearInterval(poll);
          console.log('Whisper готов. Аудио обрабатывается локально.');
        }
      } catch {}
    }, 1500);
    poll.unref();
  } catch {
    state = { ready: false, installed: false, message: 'Распознавание не установлено — запустите npm run setup.' };
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(e => {
    console.error(e.message);
    process.exitCode = 1;
  });
