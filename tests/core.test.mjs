import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeWav, PhraseBuffer} from '../public/audio.js';
import {validateWav} from '../lib/whisper.mjs';
import {createApp} from '../server.mjs';

test('resampling creates valid 16k mono WAV, clips PCM safely', () => {
  const samples = new Float32Array(48000).fill(2);
  const wav = Buffer.from(encodeWav(samples, 48000));
  assert.equal(validateWav(wav), 1); assert.equal(wav.readInt16LE(44), 32767);
  assert.throws(() => validateWav(wav.subarray(0, 100)), /Неполный/);
  assert.throws(() => validateWav(Buffer.from('not audio')), /WAV/);
});
test('silence never submits; speech with trailing silence produces a phrase', () => {
  const buffer = new PhraseBuffer(16000, 4);
  for (let i = 0; i < 20; i++) assert.equal(buffer.push(new Float32Array(1600)).audio, undefined);
  for (let i = 0; i < 5; i++) buffer.push(new Float32Array(1600).fill(.05));
  let phrase; for (let i = 0; i < 6; i++) phrase = buffer.push(new Float32Array(1600)).audio || phrase;
  assert.ok(phrase?.length > 8000);
});
test('HTTP contract: authentication, validation, errors and caption metadata', async () => {
  let calls = 0;
  const port = 0;
  const server = createApp({port, asr: {async transcribe() {calls++; return 'Hola, ¿qué tal?';}}});
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const config = await (await fetch(`${url}/api/config`)).json();
    const wav = Buffer.from(encodeWav(new Float32Array(16000).fill(.1), 16000));
    assert.equal((await fetch(`${url}/api/transcribe`, {method:'POST', body:wav})).status, 403);
    const headers = {'X-Session-Token': config.token};
    assert.equal((await fetch(`${url}/api/transcribe`, {method:'POST', headers, body:'bad'})).status, 400);
    assert.equal((await fetch(`${url}/api/transcribe?language=xx`, {method:'POST', headers, body:wav})).status, 400);
    assert.equal((await fetch(`${url}/api/transcribe`, {method:'POST', headers:{...headers, Origin:'https://example.com'}, body:wav})).status, 403);
    const event = await (await fetch(`${url}/api/transcribe?language=es`, {method:'POST', headers, body:wav})).json();
    assert.equal(event.text, 'Hola, ¿qué tal?'); assert.equal(event.source_language, 'es'); assert.equal(event.translation, null); assert.equal(event.audio_seconds, 1); assert.equal(calls, 1);
    assert.equal((await fetch(`${url}/api/translate`, {method:'POST', headers, body:'{}'})).status, 400);
    assert.equal((await fetch(`${url}/api/translate`, {method:'POST', headers, body:JSON.stringify({text:'Hola', source_language:'es',target_language:'ru'})})).status, 503);
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
});
