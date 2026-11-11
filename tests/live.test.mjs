import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveBuffer, CaptionQueue, LatestQueue, TranslationQueue} from '../public/live.js';
import {encodeWav} from '../public/audio.js';
import {createApp} from '../server.mjs';

test('stopping flushes an unfinished utterance once and translation FIFO reports overload without discarding older jobs', () => {
  const buffer = new LiveBuffer(16000,1.5);
  for(let i=0;i<8;i++) buffer.push(new Float32Array(1600).fill(.05));
  const final=buffer.flush(); assert.equal(final.final,true); assert.equal(final.audio.length,12800);
  assert.equal(buffer.flush(),null);
  const queue=new TranslationQueue(2), a={event:{id:'a'}},b={event:{id:'b'}},c={event:{id:'c'}};
  queue.push(a);queue.push(a);queue.push(b);assert.equal(queue.length,2);
  assert.equal(queue.push(c),c);assert.equal(queue.shift(),a);assert.equal(queue.shift(),b);
});

test('live snapshots retain context, revise one caption and finalize on silence', () => {
  const buffer = new LiveBuffer(16000, 1.5);
  const voice = new Float32Array(1600).fill(.05), silence = new Float32Array(1600);
  for (let i = 0; i < 30; i++) assert.equal(buffer.push(silence).update, undefined);
  const updates = [];
  for (let i = 0; i < 35; i++) {const {update} = buffer.push(voice); if (update) updates.push(update);}
  for (let i = 0; i < 13; i++) {const {update} = buffer.push(silence); if (update) updates.push(update);}
  assert.deepEqual(updates.map(e => e.final), [false, false, true]);
  assert.deepEqual(updates.map(e => e.revision), [1, 2, 3]);
  assert.ok(updates.every(e => e.sequence === 1));
  assert.ok(updates[1].audio.length > updates[0].audio.length);
  assert.deepEqual(updates[1].audio.slice(0, updates[0].audio.length), updates[0].audio);
  for (let i = 0; i < 20; i++) assert.equal(buffer.push(silence).update, undefined);
  let next; for (let i = 0; i < 15; i++) next = buffer.push(voice).update || next;
  assert.equal(next.sequence, 2);
});

test('continuous speech is bounded; pending revisions coalesce and finals win', () => {
  const buffer = new LiveBuffer(16000, 1), updates = [];
  for (let i = 0; i < 250; i++) {const {update} = buffer.push(new Float32Array(1600).fill(.1)); if (update) updates.push(update);}
  assert.equal(updates.filter(e => e.final).length, 2);
  assert.ok(updates.every(e => e.audio.length <= 12 * 16000));
  const queue = new CaptionQueue();
  queue.push({id:'a',revision:1,final:false}); queue.push({id:'a',revision:2,final:false}); queue.push({id:'a',revision:3,final:true});
  queue.push({id:'a',revision:2,final:false});
  assert.equal(queue.length, 1); assert.equal(queue.shift().final, true);
  for (let i = 0; i < 10; i++) queue.push({id:String(i),revision:1,final:true});
  assert.equal(queue.length, 3); assert.equal(queue.shift().id, '7');
  const translations = new LatestQueue();
  translations.push('old'); assert.equal(translations.push('fresh'), 'old');
  assert.equal(translations.length, 1); assert.equal(translations.shift(), 'fresh');
});

test('caption revisions route to selected engine while translation is still running', async () => {
  let release, requested;
  const translator = {status:async () => ({ready:true}), translate:() => new Promise(resolve => {release=resolve;})};
  const server = createApp({port:0, defaultEngine:'qwen', translator, engines:{qwen:{health:() => ({ready:true}), asr:{transcribe:async (wav, language, live) => {requested=live; return live.final ? 'Hola mundo.' : 'Hola';}}}}});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const config = await (await fetch(base+'/api/config')).json();
    assert.equal(config.default_engine,'qwen'); assert.equal(config.engines.qwen.ready,true);
    const headers = {'X-Session-Token':config.token};
    const translation = fetch(base+'/api/translate',{method:'POST',headers,body:JSON.stringify({text:'Previous',source_language:'es',target_language:'ru'})});
    while (!release) await new Promise(resolve => setTimeout(resolve,1));
    const body = encodeWav(new Float32Array(16000).fill(.1),16000);
    const partial = await (await fetch(base+'/api/transcribe?engine=qwen&caption_id=one&revision=1&final=false&interval=1.5',{method:'POST',headers,body})).json();
    assert.equal(partial.final,false); assert.equal(partial.id,'one'); assert.equal(partial.text,'Hola'); assert.equal(requested.interval,1.5);
    const final = await (await fetch(base+'/api/transcribe?engine=qwen&caption_id=one&revision=2&final=true&interval=1.5',{method:'POST',headers,body})).json();
    assert.equal(final.final,true); assert.equal(final.id,partial.id); assert.equal(final.revision,2);
    assert.equal((await fetch(base+'/api/transcribe?engine=bad',{method:'POST',headers,body})).status,400);
    assert.equal((await fetch(base+'/api/transcribe?caption_id=one&revision=0&final=false&interval=1.5',{method:'POST',headers,body})).status,400);
    release('Предыдущая'); assert.equal((await translation).status,200);
  } finally {release?.(''); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
});
