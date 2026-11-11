// Compare the same PCM WAV locally; no audio/text leaves the Mac.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateWav } from '../lib/whisper.mjs';
import { encodeWav } from '../public/audio.js';
import { LiveBuffer, CaptionQueue } from '../public/live.js';
const args = process.argv.slice(2),
  file = args.find(a => !a.startsWith('--'));
const option = (name, fallback) =>
  args
    .find(a => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') || fallback;
if (!file)
  throw new Error(
    'Usage: npm run benchmark:asr -- audio.wav [--interval=1.5] [--language=es] [--translation] [--output=.runtime/benchmark.json]'
  );
const interval = Number(option('interval', '1.5')),
  language = option('language', 'es');
if (![1, 1.5, 2].includes(interval))
  throw new Error('Interval must be 1, 1.5 or 2');
const base = option('url', 'http://127.0.0.1:4317');
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw new Error('Only localhost benchmarks are supported.');
let config = await (await fetch(base + '/api/config')).json();
const engines = option('engines', 'qwen,whisper').split(',');
for (
  let attempt = 0;
  attempt < 60 && engines.some(engine => !config.engines?.[engine]?.ready);
  attempt++
) {
  await sleep(1000);
  config = await (await fetch(base + '/api/config')).json();
}
for (const engine of engines)
  if (!config.engines?.[engine]?.ready)
    throw new Error(
      `${engine} is not ready; use --engines=qwen or --engines=whisper to test one engine.`
    );
const wav = await readFile(file);
validateWav(wav);
let pcm;
for (let i = 12; i + 8 <= wav.length;) {
  const size = wav.readUInt32LE(i + 4),
    start = i + 8;
  if (wav.toString('ascii', i, i + 4) === 'data') {
    pcm = new Float32Array(size / 2);
    for (let n = 0; n < pcm.length; n++)
      pcm[n] = wav.readInt16LE(start + 2 * n) / 32768;
    break;
  }
  i = start + size + (size % 2);
}
if (!pcm)
  throw new Error('Missing PCM');
async function post(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'X-Session-Token': config.token },
    body,
    signal: AbortSignal.timeout(70000)
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error);
  return result;
}
async function live(engine, withTranslation) {
  const buffer = new LiveBuffer(16000, interval),
    queue = new CaptionQueue(),
    id = randomUUID(),
    events = [];
  let processing = false,
    dropped = 0,
    failure;
  const start = performance.now();
  const translation = withTranslation
    ? post(
        '/api/translate',
        JSON.stringify({
          text: 'Hola, me gustaría reservar una mesa para dos personas mañana a las ocho. No quiero una mesa cerca de la puerta.',
          source_language: 'es',
          target_language: 'ru'
        })
      )
    : null;
  // Attach rejection immediately while PCM is replayed.
  const translated = translation?.then(
    value => ({ ...value, arrived_ms: Math.round(performance.now() - start) }),
    error => ({ error: error.message })
  );
  async function drain() {
    if (processing)
      return;
    processing = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        const params = new URLSearchParams({
          engine,
          language,
          caption_id: job.id,
          revision: job.revision,
          final: job.final,
          interval
        });
        const result = await post('/api/transcribe?' + params, encodeWav(job.audio, 16000));
        events.push({
          ...result,
          arrived_ms: Math.round(performance.now() - start),
          lag_ms: Math.round(performance.now() - job.at)
        });
      }
    } catch (error) {
      failure = error;
      queue.clear();
    } finally {
      processing = false;
    }
  }
  const padded = new Float32Array(pcm.length + 16000);
  padded.set(pcm);
  for (let i = 0; i < padded.length; i += 1600) {
    const target = (i + 1600) / 16;
    await sleep(Math.max(0, start + target - performance.now()));
    const { update } = buffer.push(padded.slice(i, Math.min(i + 1600, padded.length)));
    if (update) {
      if (queue.push({ ...update, id: id + '_' + update.sequence, at: performance.now() }))
        dropped++;
      void drain();
    }
    if (failure)
      break;
  }
  while (processing || queue.length)
    await sleep(20);
  if (failure)
    throw failure;
  return { engine, interval, withTranslation, dropped, events, translation: await translated };
}
const results = {
  created_at: new Date().toISOString(),
  audio_seconds: pcm.length / 16000,
  interval,
  language,
  offline: [],
  live: []
};
for (const engine of engines) {
  for (let run = 0; run < 3; run++) {
    const result = await post('/api/transcribe?' + new URLSearchParams({ engine, language }), wav);
    results.offline.push({ engine, run, ...result });
    console.log(`${engine} offline ${run}: ${result.processing_ms} ms · ${result.text}`);
  }
  const result = await live(engine, false);
  results.live.push(result);
  console.log(
    `${engine} live: first text ${result.events.find(e=>e.text)?.arrived_ms} ms, max lag ${Math.max(...result.events.map(e=>e.lag_ms))} ms, dropped ${result.dropped}`
  );
}
if (args.includes('--translation')) {
  const engine = config.engines?.qwen?.ready ? 'qwen' : 'whisper';
  results.live.push(await live(engine, true));
}
const output = option('output');
if (output) {
  await writeFile(output, JSON.stringify(results, null, 2) + '\n');
  console.log(`Saved: ${output}`);
} else
  console.log(JSON.stringify(results, null, 2));
