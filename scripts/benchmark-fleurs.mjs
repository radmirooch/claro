// Run against an idle local Claro. Input data and reports belong in .runtime/.
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {validateWav} from '../lib/whisper.mjs';
import {OllamaTranslator} from '../lib/translation.mjs';
import {encodeWav} from '../public/audio.js';
import {CaptionQueue, LiveBuffer} from '../public/live.js';

const directory = resolve(process.argv[2] || '.runtime/eval-fleurs-es');
const mode = process.argv[3] || 'asr';
if (!['asr', 'live', 'cadence', 'translation'].includes(mode)) throw new Error('Choose asr, live, cadence or translation.');
const engines = ['qwen', 'whisper'];
const base = new URL(process.env.CLARO_BENCHMARK_URL || 'http://127.0.0.1:4317');
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) {
  throw new Error('The benchmark requires a loopback Claro URL.');
}
const count = 48;
const dataset = {name: 'google/fleurs', revision: '4683b04', source: 'es_419/dev'};

async function readSplit(file) {
  const tsv = await readFile(join(directory, file), 'utf8');
  return tsv.trim().split(/\r?\n/u).map(row => {
    const [id, file, original, reference, , samples, gender] = row.split('\t');
    return {id, file, original, reference, samples: Number(samples), gender};
  });
}

function rank(value) {
  return createHash('sha256').update(`claro-fleurs-v1:${value}`).digest('hex');
}

function sample(rows, limit = count, maxSamples = 192000) {
  const candidates = rows.filter(row => row.samples >= 64000 && row.samples <= maxSamples && /^\d+\.wav$/u.test(row.file))
    .map(row => ({...row, rank: rank(row.file)})).sort((a, b) => a.rank.localeCompare(b.rank));
  const result = [];
  const used = new Set();
  for (let i = 0; i < limit; i++) {
    const gender = i % 2 ? 'MALE' : 'FEMALE';
    const row = candidates.find(row => row.gender === gender && !used.has(row.id));
    if (!row) throw new Error(`Not enough distinct ${gender} prompts for the fixed sample.`);
    const {rank, ...clip} = row;
    used.add(clip.id);
    result.push(clip);
  }
  return result;
}

function words(text) {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [];
}

function wordErrors(reference, hypothesis) {
  let row = Array.from({length: hypothesis.length + 1}, (_, i) => i);
  for (const [i, expected] of reference.entries()) {
    const next = [i + 1];
    for (const [j, actual] of hypothesis.entries()) {
      next.push(Math.min(row[j] + Number(expected !== actual), row[j + 1] + 1, next[j] + 1));
    }
    row = next;
  }
  return row.at(-1);
}

function percentile(values, fraction) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function summarize(results) {
  const accuracy = summarizeErrors(results);
  const audio = results.reduce((sum, row) => sum + row.audio_seconds, 0);
  const times = results.map(row => row.processing_ms);
  return {clips: results.length, ...accuracy, audio_seconds: audio,
    exact_clips: results.filter(row => row.errors === 0).length,
    p50_ms: percentile(times, .5), p95_ms: percentile(times, .95),
    real_time_factor: times.reduce((sum, ms) => sum + ms, 0) / (audio * 1000)};
}

function summarizeErrors(results) {
  const errors = results.reduce((sum, row) => sum + row.errors, 0);
  const joined = results.reduce((sum, row) => sum + row.errors_joined_lines, 0);
  const words = results.reduce((sum, row) => sum + row.words, 0);
  return {errors, words, wer: errors / words, errors_joined_lines: joined, wer_joined_lines: joined / words};
}

async function readAudio(clips) {
  const extracted = join(directory, 'extracted');
  await mkdir(extracted, {recursive: true});
  execFileSync('tar', ['-xzf', join(directory, 'dev.tar.gz'), '-C', extracted, '--', ...clips.map(clip => `dev/${clip.file}`)]);
  for (const clip of clips) {
    const file = join(extracted, `${clip.file}.pcm16.wav`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(extracted, 'dev', clip.file),
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', file]);
    clip.audio = await readFile(file);
    validateWav(clip.audio);
  }
}

async function localTranscriber(required = engines) {
  const config = await (await fetch(new URL('/api/config', base), {signal: AbortSignal.timeout(5000)})).json();
  for (const engine of required) {
    if (!config.engines?.[engine]?.ready) throw new Error(`${engine} is not ready in local Claro.`);
  }
  return async (engine, audio, live = {}) => {
    const query = new URLSearchParams({engine, language: 'es', ...live});
    const response = await fetch(new URL(`/api/transcribe?${query}`, base), {method: 'POST', body: audio,
      headers: {'X-Session-Token': config.token}, signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error(`${engine}: ${response.status} ${(await response.json()).error}`);
    return response.json();
  };
}

function scored(clip, text) {
  const reference = words(clip.reference);
  // Keep the shipped output as the main score. This second score shows how
  // newline separators inserted mid-word by whisper.cpp affect the comparison.
  const joined = text.replace(/(?<=\p{L})\r?\n(?=\p{L})/gu, '');
  return {text, words: reference.length, errors: wordErrors(reference, words(text)),
    errors_joined_lines: wordErrors(reference, words(joined))};
}

async function report(mode, rows, summary, settings = {}) {
  await writeFile(join(directory, `${mode}.json`), JSON.stringify({dataset, settings, summary, rows}, null, 2) + '\n');
  console.log(summary);
}

function summarizeLive(results) {
  const firstText = results.map(row => row.first_text_ms).filter(Number.isFinite);
  return {clips: results.length, ...summarizeErrors(results),
    first_text_p50_ms: percentile(firstText, .5), first_text_p95_ms: percentile(firstText, .95),
    final_text_p50_ms: percentile(results.map(row => row.final_text_ms).filter(Number.isFinite), .5),
    clips_without_final_text: results.filter(row => row.final_text_ms === null).length,
    dropped: results.reduce((sum, row) => sum + row.dropped, 0),
    requests: results.reduce((sum, row) => sum + row.requests, 0),
    processing_ms: results.reduce((sum, row) => sum + row.processing_ms, 0)};
}

async function measureSpeech(clips) {
  const live = mode === 'live';
  if (live) clips = clips.filter(clip => clip.samples <= 120000).slice(0, 6);
  await readAudio(clips);
  const transcribe = await localTranscriber();
  for (const engine of engines) await transcribe(engine, clips[0].audio);
  const rows = [];
  for (const [i, clip] of clips.entries()) {
    const {audio, ...source} = clip;
    const row = {...source, engines: {}};
    for (const engine of i % 4 < 2 ? engines : engines.toReversed()) {
      const result = live ? await replay(transcribe, engine, audio) : await transcribe(engine, audio);
      row.engines[engine] = {...result, ...scored(clip, result.text)};
    }
    rows.push(row);
    if (live || rows.length % 8 === 0) console.log(`${mode} ${rows.length}/${clips.length}`);
  }
  const summary = Object.fromEntries(engines.map(engine => {
    const results = rows.map(row => row.engines[engine]);
    return [engine, live ? summarizeLive(results) : summarize(results)];
  }));
  await report(mode, rows, summary, live ? {interval_seconds: 1.5, pause_seconds: 1.2, audio_limit_seconds: 8, threshold: .012} : {});
}

async function measureCadence(clips) {
  const intervals = [1.5, 1];
  await readAudio(clips);
  const transcribe = await localTranscriber(['qwen']);
  for (const interval of intervals) await replay(transcribe, 'qwen', clips[0].audio, interval);
  const rows = [];
  for (const [i, clip] of clips.entries()) {
    const runs = {};
    for (const interval of i % 2 ? intervals.toReversed() : intervals) {
      const result = await replay(transcribe, 'qwen', clip.audio, interval);
      runs[interval] = {...result, ...scored(clip, result.text)};
    }
    rows.push({id: clip.id, file: clip.file, reference: clip.original, runs});
    console.log(`cadence ${rows.length}/${clips.length}`);
  }
  const summary = Object.fromEntries(intervals.map(interval => [interval, summarizeLive(rows.map(row => row.runs[interval]))]));
  await report(mode, rows, summary, {engine: 'qwen', intervals_seconds: intervals, pause_seconds: 1.2, audio_limit_seconds: 8, threshold: .012});
}

async function replay(transcribe, engine, wav, interval = 1.5) {
  // The WAV has been validated and can contain non-audio RIFF chunks.
  let pcm;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') {
      pcm = new Float32Array(size / 2 + 24000); // 1.5 s of silence to finalize the last phrase.
      for (let i = 0; i < size / 2; i++) pcm[i] = wav.readInt16LE(offset + 8 + i * 2) / 32768;
      break;
    }
    offset += 8 + size + size % 2;
  }
  const buffer = new LiveBuffer(16000, interval, .012, 8, 1.2);
  const queue = new CaptionQueue(), id = randomUUID(), events = [];
  let processing = false, failure, dropped = 0;
  const start = performance.now();
  async function drain() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        const params = {caption_id: job.id, revision: job.revision, final: job.final, interval};
        const event = await transcribe(engine, encodeWav(job.audio, 16000), params);
        events.push({...event, arrived_ms: Math.round(performance.now() - start)});
      }
    } catch (error) {failure = error; queue.clear();}
    finally {processing = false;}
  }
  for (let i = 0; i < pcm.length && !failure; i += 2048) {
    const end = Math.min(i + 2048, pcm.length);
    await sleep(Math.max(0, start + end / 16 - performance.now()));
    const {update} = buffer.push(pcm.subarray(i, end));
    if (update) {
      if (queue.push({...update, id: `${id}_${update.sequence}`})) dropped++;
      void drain();
    }
  }
  while (processing) await sleep(20);
  if (failure) throw failure;
  const finals = events.filter(event => event.final && event.text);
  return {text: finals.map(event => event.text).join(' '), dropped,
    requests: events.length, processing_ms: events.reduce((sum, event) => sum + event.processing_ms, 0),
    first_text_ms: events.find(event => event.text)?.arrived_ms ?? null, final_text_ms: finals.at(-1)?.arrived_ms ?? null};
}

function characterNgrams(text, order) {
  const characters = [...text.normalize('NFC').replace(/\s/gu, '')];
  const counts = new Map();
  for (let i = 0; i + order <= characters.length; i++) {
    const key = characters.slice(i, i + order).join('');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return {counts, total: Math.max(0, characters.length - order + 1)};
}

function chrF(pairs) {
  let precision = 0, recall = 0, orders = 0;
  for (let order = 1; order <= 6; order++) {
    let matches = 0, candidateTotal = 0, referenceTotal = 0;
    for (const [candidate, reference] of pairs) {
      const a = characterNgrams(candidate, order), b = characterNgrams(reference, order);
      candidateTotal += a.total;
      referenceTotal += b.total;
      for (const [key, count] of a.counts) matches += Math.min(count, b.counts.get(key) || 0);
    }
    if (!candidateTotal || !referenceTotal) continue;
    orders++;
    precision += matches / candidateTotal;
    recall += matches / referenceTotal;
  }
  return precision && recall ? 500 * precision * recall / (orders * (4 * precision + recall)) : 0;
}

async function measureTranslation(clips) {
  const russian = new Map((await readSplit('ru-dev.tsv')).map(row => [row.id, row.original]));
  const rows = clips.filter(clip => russian.has(clip.id)).slice(0, 20)
    .map(clip => ({id: clip.id, source: clip.original, reference: russian.get(clip.id), models: {}}));
  process.loadEnvFile(new URL('../.env', import.meta.url));
  const summary = {};
  for (const model of ['translategemma:4b', 'qwen3:4b']) {
    const adapter = new OllamaTranslator(model, process.env.OLLAMA_URL);
    if (!(await adapter.status()).ready) throw new Error(`${model} is not installed in local Ollama.`);
    await adapter.translate('Muchas gracias por tu ayuda.', 'es', 'ru');
    for (const [i, row] of rows.entries()) {
      const start = performance.now();
      try {
        const text = await adapter.translate(row.source, 'es', 'ru');
        row.models[model] = {text, elapsed_ms: Math.round(performance.now() - start), chrf2: chrF([[text, row.reference]])};
      } catch (error) {
        row.models[model] = {text: '', error: error.message};
      }
      if ((i + 1) % 5 === 0) console.log(`${model} ${i + 1}/${rows.length}`);
    }
    const times = rows.map(row => row.models[model].elapsed_ms).filter(Number.isFinite);
    summary[model] = {phrases: rows.length, failures: rows.length - times.length, chrf2: chrF(rows.map(row => [row.models[model].text, row.reference])),
      p50_ms: percentile(times, .5), p95_ms: percentile(times, .95)};
  }
  await report(mode, rows, summary, {target: 'ru_ru/dev', num_gpu: Number(process.env.OLLAMA_NUM_GPU ?? 0), threads: Number(process.env.OLLAMA_NUM_THREAD ?? 2)});
}

const rows = await readSplit('dev.tsv');
if (mode === 'cadence') await measureCadence(sample(rows, 12, 120000));
else if (mode === 'translation') await measureTranslation(sample(rows));
else await measureSpeech(sample(rows));
