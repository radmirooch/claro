import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readJSONLines} from '../public/stream.js';
import {OllamaTranslator} from '../lib/translation.mjs';
import {createApp} from '../server.mjs';
const listen=async server=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;};
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
test('NDJSON decodes Russian across byte boundaries and accepts an unterminated last record',async()=>{
 const bytes=new TextEncoder().encode('{"text":"Привет"}\n{"text":"мир"}'),events=[];
 await readJSONLines(new ReadableStream({start(c){for(const b of bytes)c.enqueue(Uint8Array.of(b));c.close();}}),e=>events.push(e));
 assert.deepEqual(events,[{text:'Привет'},{text:'мир'}]);
});
test('Ollama emits incremental plain text before completion and rejects a truncated stream',async()=>{
 let finish, truncated=false, payload;
 const engine=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;payload=JSON.parse(body);
  res.writeHead(200,{'Content-Type':'application/x-ndjson'});
  res.write(JSON.stringify({message:{content:'Привет'},done:false})+'\n');
  finish=()=>res.end(truncated?'':JSON.stringify({message:{content:' мир'},done:true})+'\n');
 });
 const base=await listen(engine),adapter=new OllamaTranslator('translategemma:4b',base);
 try {
  const partials=[];const result=adapter.translate('Hello world','en','ru',text=>partials.push(text));
  while(!partials.length)await new Promise(r=>setTimeout(r,5));
  assert.equal(payload.stream,true);assert.deepEqual(partials,['Привет']);finish();assert.equal(await result,'Привет мир');
  truncated=true;finish=null;
  const failed=assert.rejects(adapter.translate('Hi','en','ru',()=>{}),/оборвался/);
  while(!finish)await new Promise(r=>setTimeout(r,5));finish();await failed;
 }finally{finish?.();await close(engine);}
});
test('stream API sends the first translation before completion and does not block ASR',async()=>{
 let finish;
 const server=createApp({port:0,asr:{transcribe:async()=> 'Hola'},translator:{status:async()=>({ready:true}),translate:async(_t,_s,_d,partial)=>{partial('При');await new Promise(resolve=>{finish=resolve;});return 'Привет';}}});
 const base=await listen(server);
 try {
  const {token}=await(await fetch(base+'/api/config')).json();
  const response=await fetch(base+'/api/translate-stream',{method:'POST',headers:{'X-Session-Token':token},body:JSON.stringify({caption_id:'caption',text:'Hola',source_language:'es',target_language:'ru'})});
  const reader=response.body.getReader();const first=new TextDecoder().decode((await reader.read()).value);
  assert.match(first,/"translation":"При"/);assert.match(first,/"final":false/);
  const {encodeWav}=await import('../public/audio.js');
  const asr=await fetch(base+'/api/transcribe',{method:'POST',headers:{'X-Session-Token':token},body:encodeWav(new Float32Array(16000),16000)});
  assert.equal(asr.status,200);finish();
  let rest='';for(;;){const {value,done}=await reader.read();if(done)break;rest+=new TextDecoder().decode(value);}
  assert.match(rest,/"translation":"Привет"/);assert.match(rest,/"final":true/);
 }finally{finish?.();await close(server);}
});

test('Ollama gloss stream yields a validated word before the remaining JSON arrives',async()=>{
 let finish,payload;
 const engine=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;payload=JSON.parse(body);
  res.writeHead(200,{'Content-Type':'application/x-ndjson'});
  res.write(JSON.stringify({message:{content:'{"meanings":["один",'},done:false})+'\n');
  finish=()=>res.end(JSON.stringify({message:{content:'"стол"]}'},done:true})+'\n');
 });
 const base=await listen(engine),adapter=new OllamaTranslator('qwen3:4b',base);
 try{
  const partials=[];const result=adapter.gloss('Una mesa','es','ru','Стол',undefined,hints=>partials.push(hints));
  while(!partials.length)await new Promise(r=>setTimeout(r,5));
  assert.equal(payload.stream,true);assert.equal(partials[0][0].meaning,'один');finish();
  assert.equal((await result).length,2);
 }finally{finish?.();await close(engine);}
});

test('gloss stream API sends correlated hints before completion, with translation available concurrently',async()=>{
 let finish;
 const server=createApp({port:0,asr:{},translator:{status:async()=>({ready:true}),translate:async()=> 'Стол'},glosser:{status:async()=>({ready:true}),gloss:async(_t,_s,_d,_translation,_signal,partial)=>{
  const hints=[{source:'mesa',meaning:'стол'}];partial(hints);await new Promise(resolve=>{finish=resolve;});return hints;
 }}});
 const base=await listen(server);
 try{
  const {token}=await(await fetch(base+'/api/config')).json(),headers={'X-Session-Token':token};
  const body=JSON.stringify({caption_id:'word',text:'Una mesa',translation:'Стол',source_language:'es',target_language:'ru'});
  const response=await fetch(base+'/api/gloss-stream',{method:'POST',headers,body});const reader=response.body.getReader();
  const first=new TextDecoder().decode((await reader.read()).value);
  assert.match(first,/"meaning":"стол"/);assert.match(first,/"caption_id":"word"/);assert.match(first,/"final":false/);
  assert.equal((await fetch(base+'/api/translate',{method:'POST',headers,body})).status,200);
  finish();let rest='';for(;;){const {value,done}=await reader.read();if(done)break;rest+=new TextDecoder().decode(value);}
  assert.match(rest,/"final":true/);
 }finally{finish?.();await close(server);}
});
