import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {validateGlosses, validateInterlinear, sourceUnits, parseGlossPrefix} from '../public/annotations.js';
import {OllamaTranslator} from '../lib/translation.mjs';
import {createApp} from '../server.mjs';

test('glosses attach only to exact, unambiguous, non-overlapping words or expressions', () => {
  const text = '¿Nos vemos mañana? la mesa está junto a la puerta.';
  const spans = validateGlosses(text,[{source:'Nos vemos',meaning:'увидимся'},{source:'vemos',meaning:'видим'},{source:'mes',meaning:'месяц'},{source:'invented',meaning:'ошибка'},{source:'mesa',meaning:'стол'},{source:'la',meaning:'артикль'},{source:'puerta',meaning:'дверь'}]);
  assert.deepEqual(spans.map(s=>s.source),['Nos vemos','mesa','puerta']);
  assert.ok(spans.every(s=>text.slice(s.start,s.end)===s.source));
  assert.deepEqual(validateGlosses('hola hola',[{source:'hola',meaning:'привет'}]),[]);
  assert.deepEqual(validateGlosses('Hola',[{source:'Hola',meaning:'x'.repeat(81)}]),[]);
  assert.equal(validateGlosses('你好世界',[{source:'世界',meaning:'мир'}])[0].start,2);
});

test('local gloss model receives context, JSON schema, CPU limits; hallucinated spans are discarded', async () => {
  let payload;
  const model = http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;payload=JSON.parse(body);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:{content:JSON.stringify({meanings:['один','стол']})}}));
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  try {
    const adapter = new OllamaTranslator('qwen3:4b',`http://127.0.0.1:${model.address().port}`,'chat');
    const result = await adapter.gloss('Una mesa','es','ru','Один стол');
    assert.equal(result.length,2);assert.equal(result[1].source,'mesa');
    assert.equal(payload.think,false);assert.equal(payload.options.num_gpu,0);assert.equal(payload.format.properties.meanings.maxItems,2);
    assert.equal(JSON.parse(payload.messages[1].content).translation,'Один стол');
  } finally {model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}
});

test('gloss API authenticates and preserves the caption identity', async()=>{
  const glosser = {status:async()=>({ready:true}),gloss:async()=>[{source:'mesa',meaning:'стол',start:4,end:8}]};
  const app = createApp({asr:{},glosser,port:0});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  try{
    const config=await(await fetch(base+'/api/config')).json();assert.equal(config.gloss.ready,true);
    const body=JSON.stringify({caption_id:'phrase-a',text:'Una mesa',translation:'Один стол',source_language:'es',target_language:'ru'});
    assert.equal((await fetch(base+'/api/gloss',{method:'POST',body})).status,403);
    const response=await(await fetch(base+'/api/gloss',{method:'POST',headers:{'X-Session-Token':config.token},body})).json();
    assert.equal(response.type,'gloss');assert.equal(response.caption_id,'phrase-a');assert.equal(response.glosses[0].meaning,'стол');
  }finally{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));}
});

test('a slow gloss does not lock ASR or sentence translation and is cancelled on disconnect', async()=>{
  let started, aborted;
  const began=new Promise(resolve=>started=resolve), cancelled=new Promise(resolve=>aborted=resolve);
  const glosser={status:async()=>({ready:true}),gloss:(_text,_source,_target,_translation,signal)=>new Promise((resolve,reject)=>{
    started();signal.addEventListener('abort',()=>{aborted();reject(signal.reason);},{once:true});
  })};
  const translator={status:async()=>({ready:true}),translate:async()=> 'Привет'};
  const app=createApp({asr:{transcribe:async()=> 'Hola'},glosser,translator,port:0});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.address().port}`;
  const controller=new AbortController();
  try {
    const {token}=await(await fetch(base+'/api/config')).json(),headers={'X-Session-Token':token};
    const input={caption_id:'slow',text:'Hola',translation:'Привет',source_language:'es',target_language:'ru'};
    const hint=fetch(base+'/api/gloss',{method:'POST',headers,body:JSON.stringify(input),signal:controller.signal}).catch(()=>null);
    await began;
    assert.equal((await fetch(base+'/api/gloss',{method:'POST',headers,body:JSON.stringify(input)})).status,429,'at most one gloss inference');
    const translation=await(await fetch(base+'/api/translate',{method:'POST',headers,body:JSON.stringify(input)})).json();
    assert.equal(translation.translation,'Привет');
    const {encodeWav}=await import('../public/audio.js');
    const caption=await(await fetch(base+'/api/transcribe?language=es',{method:'POST',headers,body:encodeWav(new Float32Array(16000),16000)})).json();
    assert.equal(caption.text,'Hola');
    controller.abort();await hint;await cancelled;
  }finally{controller.abort();app.closeAllConnections();await new Promise(resolve=>app.close(resolve));}
});

test('streamed hint JSON yields complete objects only, including escaped quotes and braces',()=>{
  const item={source:'mesa',meaning:'стол } \"кафе\"'};
  const prefix='{"glosses":['+JSON.stringify(item);
  for(let i=0;i<prefix.length;i++)assert.deepEqual(parseGlossPrefix(prefix.slice(0,i)),[]);
  assert.deepEqual(parseGlossPrefix(prefix+', {"source":"next'),[item]);
  assert.deepEqual(parseGlossPrefix(prefix+']}'),[item]);
});

test('interlinear rejects incomplete or punctuation-only meanings instead of claiming full coverage',async()=>{
 const model=http.createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:{content:'{"meanings":["привет","?"]}'}}));});
 await new Promise(r=>model.listen(0,'127.0.0.1',r));
 try{const adapter=new OllamaTranslator('qwen3:4b',`http://127.0.0.1:${model.address().port}`,'chat');await assert.rejects(adapter.gloss('Hello world','en','ru','Привет мир'),/не все/);}
 finally{model.closeAllConnections();await new Promise(r=>model.close(r));}
});

test('long interlinear requests batch outputs while retaining full context and global indices',async()=>{
 const calls=[];
 const model=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw),input=JSON.parse(payload.messages.at(-1).content);calls.push(input);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:{content:JSON.stringify({meanings:input.units.map(u=>'слово '+u.index)})}}));});
 await new Promise(r=>model.listen(0,'127.0.0.1',r));
 try{const adapter=new OllamaTranslator('qwen3:4b',`http://127.0.0.1:${model.address().port}`,'chat'),text=Array.from({length:35},(_,i)=>'word'+i).join(' ');const result=await adapter.gloss(text,'en','ru','Полный контекст');assert.equal(calls.length,3);assert.ok(calls.every(c=>c.original===text));assert.equal(result.length,35);assert.equal(result[34].meaning,'слово 34');}
 finally{model.closeAllConnections();await new Promise(r=>model.close(r));}
});
