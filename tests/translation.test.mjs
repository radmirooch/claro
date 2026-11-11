import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createApp} from '../server.mjs';
import {OllamaTranslator, localURL} from '../lib/translation.mjs';
import {LANGUAGES} from '../public/languages.js';

async function listen(server) {await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`;}
async function close(server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}

test('translation API preserves source, target and caption ID across all catalog languages', async () => {
  const calls = [];
  const translator = {status: async () => ({ready:true}), translate: async (...args) => {calls.push(args); return 'translated';}};
  const server = createApp({asr: {}, translator, port:0}); const base = await listen(server);
  try {
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.languages.length, 10); assert.equal(config.translator, true);
    const send = input => fetch(base + '/api/translate', {method:'POST',headers:{'X-Session-Token':config.token},body:JSON.stringify(input)});
    for (const lang of LANGUAGES) {
      const source = lang.code === 'en' ? 'es' : 'en';
      const result = await (await send({text:'Test', source_language:source, target_language:lang.code, caption_id:'c-1'})).json();
      assert.equal(result.source_language,source); assert.equal(result.target_language,lang.code); assert.equal(result.caption_id,'c-1');
      assert.deepEqual(calls.at(-1).slice(0,3), ['Test',source,lang.code]);assert.equal(calls.at(-1)[4].aborted,false);
    }
    const same = await (await send({text:'Hello', source_language:'en',target_language:'en'})).json();
    assert.equal(same.translation,'Hello'); assert.equal(calls.length,10);
    for (const invalid of [null, {}, {text:'hello',source_language:'en',target_language:'xx'}, {text:'x'.repeat(3001),source_language:'es',target_language:'ru'}]) assert.equal((await send(invalid)).status,400);
  } finally {await close(server);}
});

test('busy translator is bounded and readiness reflects actual provider', async () => {
  let release, ready = false;
  const translator = {status:async () => ({ready}), translate:() => new Promise(resolve => {release = resolve;})};
  const server = createApp({asr:{}, translator, port:0}), base = await listen(server);
  try {
    const config = await (await fetch(base+'/api/config')).json(); assert.equal(config.translator,false);
    const send = () => fetch(base+'/api/translate',{method:'POST',headers:{'X-Session-Token':config.token},body:JSON.stringify({text:'Hola',source_language:'es',target_language:'ru'})});
    assert.equal((await send()).status,503); ready = true;
    const first = send();
    while (!release) await new Promise(resolve => setTimeout(resolve,5));
    assert.equal((await send()).status,429); release('Привет'); assert.equal((await first).status,200);
  } finally {release?.(''); await close(server);}
});

test('Ollama adapter checks installed model and sends the selected language pair without thinking', async () => {
  let request, invalid = false;
  const engine = http.createServer(async (req,res) => {
    res.setHeader('Content-Type','application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({models:[{name:'test:4b'}]}));
    let body=''; for await (const chunk of req) body+=chunk;
    request=JSON.parse(body);
    res.end(JSON.stringify({message:{content:invalid ? 'not JSON' : JSON.stringify({translation:'¿Dónde está la estación?'})}}));
  });
  const base=await listen(engine);
  try {
    const adapter = new OllamaTranslator('test:4b',base);
    assert.equal((await adapter.status()).ready,true);
    assert.equal((await new OllamaTranslator('missing',base).status()).ready,false);
    assert.equal(await adapter.translate('Где станция?','ru','es'),'¿Dónde está la estación?');
    assert.equal(request.think,false); assert.equal(request.stream,false);
    assert.match(request.messages[0].content,/Russian/); assert.match(request.messages[0].content,/Spanish/);
    assert.equal(request.messages[1].content,'Где станция?');
    invalid=true; await assert.rejects(adapter.translate('Hi','en','ja'),/формат/);
    for (const url of ['https://example.com','http://192.168.1.2:8080','http://user:pass@localhost:11434']) assert.throws(() => localURL(url));
  } finally {await close(engine);}
});

test('translation-tuned profile uses a single message, mapped Chinese code and plain text', async () => {
  let payload;
  const engine = http.createServer(async (req,res) => {
    let body=''; for await (const chunk of req) body+=chunk; payload=JSON.parse(body);
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({message:{content:'明天见。'}}));
  });
  const base=await listen(engine);
  try {
    const adapter = new OllamaTranslator('translategemma:4b',base);
    assert.equal(await adapter.translate('See you tomorrow.','en','zh'),'明天见。');
    assert.equal(payload.messages.length,1); assert.equal(payload.messages[0].role,'user');
    assert.match(payload.messages[0].content,/zh-Hans/); assert.match(payload.messages[0].content,/\n\n\nSee you tomorrow\.$/);
    assert.equal(payload.format,undefined); assert.equal(payload.think,undefined);
  } finally {await close(engine);}
});

test('SSE carries original captions and correlated translations', async () => {
  const translator={status:async()=>({ready:true}),translate:async()=> 'Привет'};
  const server=createApp({asr:{transcribe:async()=> 'Hola'},translator,port:0}); const base=await listen(server);
  let reader;
  try {
    const {token}=await (await fetch(base+'/api/config')).json();
    const stream=await fetch(base+'/api/events?token='+token); reader=stream.body.getReader();
    await reader.read();
    const headers={'X-Session-Token':token};
    const {encodeWav}=await import('../public/audio.js');
    const caption=await (await fetch(base+'/api/transcribe?language=es',{method:'POST',headers,body:encodeWav(new Float32Array(16000),16000)})).json();
    const original=new TextDecoder().decode((await reader.read()).value);
    assert.match(original,/"type":"caption"/); assert.ok(original.includes(caption.id));
    await fetch(base+'/api/translate',{method:'POST',headers,body:JSON.stringify({text:'Hola',source_language:'es',target_language:'ru',caption_id:caption.id})});
    const translated=new TextDecoder().decode((await reader.read()).value);
    assert.match(translated,/"type":"translation"/); assert.ok(translated.includes(caption.id)); assert.ok(translated.includes('Привет'));
  } finally {await reader?.cancel(); await close(server);}
});

test('cancelling a translation request propagates to its provider and releases the busy guard',async()=>{
 let begin,abort;
 const started=new Promise(r=>begin=r),aborted=new Promise(r=>abort=r);
 const translator={status:async()=>({ready:true}),translate:(_t,_s,_d,_partial,signal)=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{abort();reject(signal.reason);},{once:true});begin();})};
 const server=createApp({asr:{},translator,port:0}),base=await listen(server),controller=new AbortController();
 try {
  const {token}=await(await fetch(base+'/api/config')).json();
  const pending=fetch(base+'/api/translate',{method:'POST',headers:{'X-Session-Token':token},body:JSON.stringify({text:'Hola',source_language:'es',target_language:'ru'}),signal:controller.signal}).catch(()=>null);
  await started;controller.abort();await pending;await aborted;await new Promise(r=>setImmediate(r));
  translator.translate=async()=> 'Привет';
  assert.equal((await fetch(base+'/api/translate',{method:'POST',headers:{'X-Session-Token':token},body:JSON.stringify({text:'Hola',source_language:'es',target_language:'ru'})})).status,200);
 } finally {controller.abort();await close(server);}
});
