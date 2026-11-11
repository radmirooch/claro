import { mkdir, access, rename, rm, readFile, stat } from 'node:fs/promises';
import { createWriteStream, createReadStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { project, run, ensureEnvSettings } from './setup-common.mjs';

const runtime = `${project}.runtime`;
const archive = `${runtime}/ollama-darwin.tgz`;
const binary = `${runtime}/ollama/ollama`;
const version = 'v0.40.15';
const sha256 = '607c79d5d6315ef9d896db83adde736a4c0057196329843544e79b95afb260a8';
const endpoint = 'http://127.0.0.1:11435';

async function ensureBinary() {
  try {
    await access(binary, constants.X_OK);
    console.log('Перевод — Ollama уже установлена.');
    return;
  } catch {}
  await mkdir(`${runtime}/ollama`, { recursive: true });
  try {
    await access(archive);
  } catch {
    console.log('Перевод — скачиваем Ollama с проверкой SHA-256.');
    const temporary = `${archive}.part`;
    try {
      const response = await fetch(`https://github.com/ollama/ollama/releases/download/${version}/ollama-darwin.tgz`);
      if (!response.ok)
        throw new Error(`Не удалось скачать Ollama (HTTP ${response.status}). Повторите установку.`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      await rename(temporary, archive);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive))
    hash.update(chunk);
  if (hash.digest('hex') !== sha256)
    throw new Error('Контрольная сумма Ollama не совпала. Удалите .runtime/ollama-darwin.tgz и повторите установку.');
  await run('tar', ['-xzf', archive, '-C', `${runtime}/ollama`]);
}

export async function localOllamaModelInstalled(model, directory = `${runtime}/models`) {
  // Local registry manifests let repeated setup finish without starting Ollama.
  const match = model.match(/^(?:([a-zA-Z0-9_-]+)\/)?([a-zA-Z0-9_.-]+)(?::([a-zA-Z0-9_.-]+))?$/u);
  if (!match || [match[1], match[2], match[3]].some(part => part === '.' || part === '..'))
    return false;
  const [, namespace = 'library', name, tag = 'latest'] = match;
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'manifests', 'registry.ollama.ai', namespace, name, tag), 'utf8'));
    if (!manifest.config || !manifest.layers?.length)
      return false;
    for (const layer of [manifest.config, ...manifest.layers]) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(layer.digest))
        return false;
      const blob = await stat(join(directory, 'blobs', layer.digest.replace(':', '-')));
      if (!blob.isFile() || blob.size !== layer.size)
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function installedModels() {
  const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(1000) });
  if (!response.ok)
    throw new Error('Ollama недоступна. Повторите установку.');
  return (await response.json()).models || [];
}

export async function ensureOllamaModel(model, models) {
  if (models.some(item => item.name === model || item.name === `${model}:latest`)) {
    console.log(`Модель ${model} — уже установлена.`);
    return;
  }
  console.log(`Модель ${model} — скачиваем, дождитесь завершения.`);
  const response = await fetch(`${endpoint}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false })
  });
  if (!response.ok || (await response.json()).status !== 'success')
    throw new Error(`Не удалось установить модель ${model}. Повторите npm run setup.`);
}

export async function setupTranslation(model = 'translategemma:4b', { gloss = false } = {}) {
  if (process.platform !== 'darwin')
    throw new Error('Эта установка Ollama предназначена для macOS. См. docs/setup.md.');
  await ensureBinary();
  const requested = gloss ? [...new Set([model, 'qwen3:4b'])] : [model];
  const missing = [];
  for (const name of requested) {
    if (await localOllamaModelInstalled(name))
      console.log(`Модель ${name} — уже установлена.`);
    else
      missing.push(name);
  }
  let engine;
  const stop = () => engine?.kill('SIGTERM');
  const interrupted = () => {
    stop();
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    let models;
    if (missing.length) {
      try {
        models = await installedModels();
      } catch {
        console.log('Перевод — запускаем локальную Ollama для установки.');
        engine = spawn(binary, ['serve'], {
          stdio: 'ignore',
          env: {
            ...process.env,
            OLLAMA_HOST: '127.0.0.1:11435',
            OLLAMA_MODELS: `${runtime}/models`,
            OLLAMA_NO_CLOUD: '1'
          }
        });
        let launchFailed = false;
        engine.once('error', () => { launchFailed = true; });
        for (let attempt = 0; attempt < 40; attempt++) {
          if (launchFailed || engine.exitCode !== null)
            break;
          try {
            models = await installedModels();
            break;
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!models)
          throw new Error('Ollama не запустилась. Проверьте порт 11435 и повторите npm run setup.');
      }
      for (const name of missing)
        await ensureOllamaModel(name, models);
    }
    await ensureEnvSettings(`${project}.env`, {
      OLLAMA_MODEL: model,
      OLLAMA_URL: endpoint,
      OLLAMA_BIN: '.runtime/ollama/ollama'
    });
    console.log('Настройки — недостающие ключи добавлены, существующие значения сохранены.');
  } finally {
    stop();
    if (engine?.pid && engine.exitCode === null) {
      const timeout = setTimeout(() => engine.kill('SIGKILL'), 3000);
      await new Promise(resolve => engine.once('exit', resolve));
      clearTimeout(timeout);
    }
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setupTranslation(process.argv[2]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
