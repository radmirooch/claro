import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {encodeWav} from '../public/audio.js';
import {LiveBuffer, CaptionQueue, TranslationQueue, readingBlocks} from '../public/live.js';
import {LANGUAGES, languageByCode} from '../public/languages.js';
import {defaultParticipants,readParticipants,assignSpeaker,SPEAKER_COLORS} from '../public/participants.js';
import {createModuleBus} from '../public/modules.js';
import {splitFinalCaption,draftTail} from '../public/reading.js';
import {sourceUnits} from '../public/annotations.js';
import {readJSONLines} from '../public/stream.js';

async function harness({live=false,streaming=false,glossStreaming=false} = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id,{value:'',_text:'',get textContent(){return this.children.length ? this.children.map(n=>n.textContent).join('') : this._text;},set textContent(v){this._text=v;this.children=[];},hidden:false,disabled:false,options:[],children:[],attributes:{},scrollTop:0,scrollHeight:1000,clientHeight:400,classList:{toggle(){}},add(option){this.options.push(option);},append(...items){for(const item of items){item.parent=this;this.children.push(item);}},remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);},replaceChildren(){this.children=[];},setAttribute(k,v){this.attributes[k]=v;},showModal(){},close(){}});
    return elements.get(id);
  };
  for (const [id,value] of Object.entries({engine:'qwen',interval:'1.5',threshold:'.012',translationMode:'always',translationLayout:'line',showOriginal:'show',showParticipants:'hide',textSize:'normal',readingMode:'live'})) {element(id).value=value; element(id).options=[{value}];}
  element('historyPanel').hidden=true;
  const requests=[], pending=[];
  const context = vm.createContext({console,structuredClone,splitFinalCaption,draftTail,defaultParticipants,readParticipants,assignSpeaker,SPEAKER_COLORS,createModuleBus,encodeWav,LiveBuffer,CaptionQueue,TranslationQueue,readingBlocks,LANGUAGES,languageByCode,readJSONLines,URLSearchParams,AbortSignal,AbortController,performance,crypto:webcrypto,
    Option:class {constructor(label,value){this.label=label;this.value=value;}},
    document:{getElementById:element,createElement:()=>element('node'+Math.random()),createTextNode:text=>({textContent:text}),body:{classList:{toggle(){}},setAttribute(){}}},
    localStorage:{getItem:()=>null,setItem(){}},window:{addEventListener(){}},setInterval(){},setTimeout,
    navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}],getAudioTracks:()=>[{}]})}},
    AudioContext:class {constructor(){this.sampleRate=16000;this.audioWorklet={addModule:async()=>{}};} async resume(){} close(){return Promise.resolve();} createMediaStreamSource(){return {connect(node){return node;},disconnect(){}};} createGain(){return {gain:{},connect(){},disconnect(){}};}},
    AudioWorkletNode:class {constructor(){this.port={};}connect(node){return node;}disconnect(){}},
    fetch:async(path,options)=>{
      if(path==='/api/config')return {ok:true,json:async()=>({token:'test',translator:true,default_engine:'qwen',engines:{qwen:{ready:true}},translation:{},gloss:{ready:true},features:{live_translation:live,translation_streaming:streaming,gloss_streaming:glossStreaming}})};
      if(path.startsWith('/api/transcribe')) {
        const p=new URL(path,'http://localhost').searchParams;
        return {ok:true,json:async()=>({id:p.get('caption_id'),revision:Number(p.get('revision')),final:p.get('final')==='true',source_language:'es',text:'Texto '+p.get('caption_id')+' '+p.get('revision')+(p.get('final')==='true'?'.':''),audio_seconds:options.body.byteLength/32000,created_at:new Date().toISOString(),processing_ms:10,engine:'qwen'})};
      }
      const input=JSON.parse(options.body);requests.push({path,input});
      if(path==='/api/gloss-stream') {
        const encoder=new TextEncoder();
        return new Response(new ReadableStream({start(controller){
          controller.enqueue(encoder.encode(JSON.stringify({caption_id:input.caption_id,glosses:sourceUnits(input.text).map(unit=>({...unit,meaning:'текст'})),final:false})+'\n'));
          pending.push(Object.assign(()=>{controller.enqueue(encoder.encode(JSON.stringify({caption_id:input.caption_id,glosses:sourceUnits(input.text).map(unit=>({...unit,meaning:'текст'})),final:true})+'\n'));controller.close();},{path}));
        }}),{headers:{'Content-Type':'application/x-ndjson'}});
      }
      if (path==='/api/translate-stream') {
        const encoder=new TextEncoder();
        return new Response(new ReadableStream({start(controller){
          controller.enqueue(encoder.encode(JSON.stringify({caption_id:input.caption_id,translation:'Черновик '+input.text,final:false})+'\n'));
          pending.push(()=>{controller.enqueue(encoder.encode(JSON.stringify({caption_id:input.caption_id,translation:'Перевод '+input.caption_id,final:true})+'\n'));controller.close();});
        }}),{headers:{'Content-Type':'application/x-ndjson'}});
      }
      return new Promise(resolve=>pending.push(Object.assign(()=>resolve({ok:true,json:async()=>path==='/api/gloss'?{glosses:sourceUnits(input.text).map(unit=>({...unit,meaning:'текст'}))}:{translation:'Перевод '+input.caption_id,processing_ms:5000}}),{path})));
    }
  });
  const run = source => vm.runInContext(source,context);
  run((await readFile(new URL('../public/annotations.js',import.meta.url),'utf8')).replaceAll('export function','function'));
  run((await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,''));
  const settle=()=>new Promise(resolve=>setImmediate(resolve)); await settle();
  async function feed(frames,volume=.05){for(let i=0;i<frames;i++)run(`capture.port.onmessage({data:new Float32Array(1600).fill(${volume})})`);await settle();}
  async function release(path){const index=path ? pending.findIndex(item=>item.path===path) : 0;assert.ok(index>=0 && pending.length,'model request pending');pending.splice(index,1)[0]();await settle();}
  return {element,run,feed,release,settle,requests,pending};
}

test('conversation keeps successive captions and attaches delayed FIFO translations after microphone stop',async()=>{
  const h=await harness(); await h.run('start()');
  await h.feed(15);
  const firstId=h.run('current.id');
  assert.equal(h.run('current.final'),false);assert.equal(h.requests.length,0);
  assert.match(h.element('messageList').textContent,/Перевод после паузы/);
  await h.feed(13,0); assert.equal(h.requests.length,1);
  await h.feed(15); await h.feed(13,0);
  await h.feed(15);
  assert.equal(h.run('messages.size'),3);assert.equal(h.run('translationQueue.length'),1);
  h.element('messageFeed').scrollTop=200;h.element('messageFeed').onscroll();
  assert.equal(h.run('followConversation'),false);
  h.run('stop()');await h.settle();
  assert.equal(h.run('history.length'),3,'stop flushes final unfinished audio');
  assert.equal(h.run('history.every(e=>e.final)'),true);
  await h.release();
  assert.match(h.element('messageList').children[0].textContent,new RegExp('Перевод '+firstId));
  assert.equal(h.element('messageFeed').scrollTop,200,'late translation does not steal scroll position');
  await h.release();await h.release();
  assert.equal(h.run('history.every(e=>e.translation === "Перевод "+e.id)'),true);
  assert.equal(h.requests.length,3);assert.equal(h.run('messages.size'),3);
  assert.equal(h.element('messageList').children.length,3);
  h.element('jumpLatest').onclick();assert.equal(h.element('messageFeed').scrollTop,1000);
  await h.run('start()');assert.equal(h.run('messages.size'),3,'restart preserves conversation');h.run('stop()');
});

test('live translation streams before ASR finalization, coalesces drafts and finishes on the corrected final text',async()=>{
  const h=await harness({live:true,streaming:true});await h.run('start()');await h.feed(15);
  assert.equal(h.requests.length,1);assert.equal(h.run('current.final'),false);
  assert.match(h.element('messageList').textContent,/Черновик/);
  assert.equal(h.run('current.translation_status'),'provisional');
  await h.feed(15);await h.feed(13,0);
  const finalText=h.run('current.text');
  assert.equal(h.run('current.final'),true);assert.equal(h.run('translationQueue.length'),1);
  assert.equal(h.run('pendingPartial'),null,'final replaces a superseded queued draft');
  await h.release();
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].input.text,finalText);
  assert.equal(h.run('current.translation_status'),'streaming');
  assert.equal(h.element('messageList').children.length,1);
  await h.release();assert.equal(h.run('current.translation_status'),'ready');
  assert.equal(h.run('history[0].translation'),h.run('current.translation'));h.run('stop()');
});

test('tap mode waits for reveal, then automatically annotates its message while capture continues',async()=>{
  const h=await harness();h.element('translationMode').value='tap';h.element('translationMode').onchange();h.element('translationLayout').value='words';
  await h.run('start()');await h.feed(15);await h.feed(13,0);
  assert.equal(h.requests.length,0);
  const first=h.element('messageList').children[0];
  first.children.at(-1).children.find(node=>node.textContent==='Перевести').onclick();
  await h.release('/api/translate');assert.equal(h.requests[1].path,'/api/gloss');
  await h.feed(15);
  assert.equal(h.run('running'),true);assert.equal(h.run('messages.size'),2,'ASR continues while hints are pending');
  await h.release('/api/gloss');
  assert.match(first.textContent,/текст/);assert.doesNotMatch(h.element('messageList').children[1].textContent,/текст/);
  h.run('stop()');await h.settle();
});

test('automatic hints do not block the next translation or ASR; delayed results stay on their caption',async()=>{
  const h=await harness();h.element('translationLayout').value='words';await h.run('start()');
  await h.feed(15);await h.feed(13,0);await h.release('/api/translate');
  assert.equal(h.requests.at(-1).path,'/api/gloss');
  const first=h.run('current.id');
  await h.feed(15);await h.feed(13,0);
  assert.equal(h.run('messages.size'),2);assert.equal(h.requests.at(-1).path,'/api/translate');
  await h.release('/api/translate');
  assert.equal(h.run('history.every(e=>e.translation_status==="ready")'),true,'translation completes before slow hints');
  assert.equal(h.run('glossQueue.length'),1);
  await h.release('/api/gloss');
  assert.equal(h.run(`messages.get('${first}').gloss_status`),'ready');
  assert.equal(h.run('current.glosses'),undefined);
  await h.release('/api/gloss');assert.equal(h.run('current.gloss_status'),'ready');
  assert.equal(h.run('running'),true);h.run('stop()');
});

test('draft hints start before a speech pause, discard corrected text and coalesce pending revisions',async()=>{
  const h=await harness({live:true});h.element('translationLayout').value='words';await h.run('start()');await h.feed(15);
  await h.release('/api/translate');assert.equal(h.requests.at(-1).path,'/api/gloss');assert.equal(h.run('current.final'),false);
  await h.feed(15);await h.release('/api/translate');
  await h.feed(15);await h.release('/api/translate');
  assert.equal(h.run('glossQueue.length'),1,'only latest draft for a caption is retained');
  await h.release('/api/gloss');assert.equal(h.run('current.glosses'),undefined,'a corrected ASR revision rejects stale hints');
  assert.equal(h.requests.at(-1).input.text,h.run('current.text'));
  await h.release('/api/gloss');assert.equal(h.run('current.gloss_status'),'ready');
  h.run('stop()');await h.settle();await h.release('/api/translate');await h.release('/api/gloss');
});

test('switching hints off aborts the job and ignores its late result',async()=>{
  const h=await harness();h.element('translationLayout').value='words';await h.run('start()');await h.feed(15);await h.feed(13,0);await h.release('/api/translate');
  h.element('translationLayout').value='line';h.element('translationLayout').onchange();
  assert.equal(h.run('activeGloss.controller.signal.aborted'),true);
  await h.release('/api/gloss');assert.equal(h.run('current.glosses'),undefined);
  h.run('stop()');
});

test('hint backlog is bounded and favours completed phrases over draft revisions',async()=>{
  const h=await harness();h.element('translationLayout').value='words';
  h.run(`for(let i=0;i<12;i++){const e={id:'queued'+i,text:'Texto '+i,translated_text:'Texto '+i,translation:'Текст',source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()};show(e);requestGloss(e);}`);
  assert.equal(h.run('glossQueue.length'),8);assert.equal(h.requests.length,1);
  assert.equal(h.run('[...messages.values()].filter(e=>e.gloss_status==="overflow").length'),3);
  h.element('clear').onclick();await h.release('/api/gloss');
  assert.equal(h.run('messages.size'),0);assert.equal(h.run('glossQueue.length'),0);
});

test('clear prevents a pending translation from restoring removed messages',async()=>{
  const h=await harness();await h.run('start()');await h.feed(15);await h.feed(13,0);
  h.element('clear').onclick();await h.release();
  assert.equal(h.run('messages.size'),0);assert.equal(h.run('history.length'),0);
  assert.equal(h.element('messageList').children.length,0);assert.equal(h.element('emptyState').hidden,false);
});

test('clearing a live streamed draft ignores both late translation and final ASR results',async()=>{
  const h=await harness({live:true,streaming:true});await h.run('start()');await h.feed(15);
  assert.match(h.element('messageList').textContent,/Черновик/);
  h.element('clear').onclick();await h.release();await h.settle();
  assert.equal(h.run('messages.size'),0);assert.equal(h.run('history.length'),0);
  assert.equal(h.element('messageList').children.length,0);
});

test('reading resumes at the bottom without a freeze button, and late content above keeps the visible anchor',async()=>{
  const h=await harness();const feed=h.element('messageFeed');
  feed.scrollTop=590;feed.onscroll();assert.equal(h.run('followConversation'),false);
  feed.scrollTop=600;feed.onscroll();assert.equal(h.run('followConversation'),true);
  h.run(`
    let geometryShift=0;
    const visibleText={classList:{contains:()=>true},getBoundingClientRect:()=>({top:100+geometryShift,bottom:200+geometryShift})};
    const row={querySelectorAll:()=>[visibleText],querySelector:()=>visibleText};
    messageRows.set('anchor',row);
    $('messageFeed').getBoundingClientRect=()=>({top:100,bottom:500});
    const savedAnchor=readingAnchor($('messageFeed'));
    geometryShift=45;
    restoreReadingAnchor($('messageFeed'),savedAnchor);
  `);
  assert.equal(feed.scrollTop,645,'height added above the visible text is compensated');
});

test('word hints keep one original without repeated labels; sentence mode shows the full translation',async()=>{
 const h=await harness();h.element('translationLayout').value='words';
 h.run(`show({id:'hint-demo',demo:true,source_language:'es',target_language:'ru',text:'Nos vemos mañana.',translation:'Увидимся завтра.',translation_status:'ready',glosses:[{source:'mañana',meaning:'завтра'}],final:true,created_at:new Date().toISOString()},false)`);
 const row=h.element('messageList').children[0];
 assert.equal(row.children.filter(node=>node.className==='message-original').length,1);
 assert.equal(row.children.filter(node=>node.className==='message-translation').length,0);
 assert.equal(row.children.some(node=>node.className==='message-meta'),false);
 assert.equal(row.children.some(node=>node.className==='message-actions'),false);
 h.element('lineMode').onclick();
 assert.equal(row.children.find(node=>node.className==='message-translation').textContent,'Увидимся завтра.');
});

test('first streamed word hint is visible before completion while microphone stays on',async()=>{
  const h=await harness({live:true,glossStreaming:true});h.element('translationLayout').value='words';await h.run('start()');await h.feed(15);await h.release('/api/translate');
  assert.equal(h.run('current.final'),false);assert.equal(h.run('current.gloss_status'),'pending');
  assert.match(h.element('messageList').textContent,/текст/);assert.equal(h.run('running'),true);
  await h.release('/api/gloss-stream');assert.equal(h.run('current.gloss_status'),'ready');
  h.run('stop()');await h.settle();await h.release('/api/translate');await h.release('/api/gloss-stream');
});

test('participant corrections survive ASR revisions and captions-only disables interlinear work',async()=>{
 const h=await harness({live:true});h.element('translationLayout').value='words';await h.run('start()');await h.feed(15);
 h.run("assignSpeaker(current,'self',participants)");await h.feed(15);
 assert.equal(h.run('current.speaker_id'),'self');assert.equal(h.run('current.speaker_assignment.origin'),'manual');
 h.element('translationMode').value='off';h.element('translationMode').onchange();await h.release('/api/translate');
 assert.equal(h.requests.some(r=>r.path.startsWith('/api/gloss')),false);h.run('stop()');
});

test('growing a partial word invalidates its earlier meaning rather than attaching it to a different word',async()=>{
 const h=await harness();assert.equal(h.run("compatibleSource('la cafetería','la cafe')"),false);
 assert.equal(h.run("compatibleSource('la cafetería abre','la cafetería')"),true);
});

test('steady reading keeps revisions in a separate draft and translates only a finalized phrase',async()=>{
 const h=await harness({live:true});h.element('readingMode').value='steady';
 await h.run('start()');await h.feed(15);await h.feed(15);
 assert.equal(h.element('messageList').children.length,0);assert.equal(h.element('draftPanel').hidden,false);
 assert.match(h.element('draftText').textContent,/Texto/);assert.equal(h.requests.length,0,'no repeated draft translation');
 await h.feed(13,0);assert.equal(h.element('draftPanel').hidden,true);assert.equal(h.element('messageList').children.length,1);
 assert.equal(h.requests.length,1);const original=h.run('history[0].text');
 await h.feed(15);assert.equal(h.run('history[0].text'),original);assert.equal(h.element('messageList').children.length,1);
 h.run('stop()');await h.settle();
});

test('steady reading sends a long sentence to translation as one complete request',async()=>{
 const h=await harness();h.element('readingMode').value='steady';
 const text='Hola, después de caminar toda la mañana por el centro quiero ir a desayunar con mis amigos antes de volver a casa.';
 h.run(`acceptFinal({id:'breakfast',text:${JSON.stringify(text)},source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()})`);
 assert.equal(h.element('messageList').children.length,1);
 assert.equal(h.requests[0].input.text,text);
 await h.release('/api/translate');
 assert.equal(h.requests.length,1);
 assert.equal(h.run('history[0].translation_status'),'ready');
});

test('peek prepares translation in background but reveals only on a word or bubble action',async()=>{
 const h=await harness();h.element('readingMode').value='steady';h.element('translationLayout').value='words';h.element('translationMode').value='peek';
 await h.run('start()');await h.feed(15);await h.feed(13,0);
 assert.equal(h.requests.length,1);assert.equal(h.run('current.revealed'),undefined);
 await h.release('/api/translate');assert.equal(h.requests.at(-1).path,'/api/gloss');await h.release('/api/gloss');
 const row=h.element('messageList').children[0];
 const source=row.children.find(n=>n.className==='message-original');
 assert.ok(source.children.every(n=>n.children[1].hidden));
 source.children[0].children[0].onclick();assert.equal(h.element('wordMeaning').textContent,'текст');
 assert.equal(h.run('current.revealed'),undefined,'peeking at one word does not expose every meaning');
 row.onclick({target:{}});assert.equal(h.run('current.revealed'),true);
 const n=h.requests.length;row.onclick({target:{}});assert.equal(h.run('current.revealed'),false);assert.equal(h.requests.length,n,'collapse never restarts inference');
 h.run('stop()');
});

test('steady word work waits for recognition and disabling translation aborts current work',async()=>{
 const h=await harness();h.element('readingMode').value='steady';h.element('translationLayout').value='words';
 h.run("processing=true;const pendingWord={id:'waiting',text:'Texto',translated_text:'Texto',translation:'Текст',source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()};show(pendingWord);requestGloss(pendingWord)");
 assert.equal(h.requests.length,0);assert.equal(h.run('glossQueue.length'),1);
 h.run('processing=false;drainGlosses()');assert.equal(h.requests.length,1);await h.release('/api/gloss');
 await h.run('start()');await h.feed(15);await h.feed(13,0);assert.ok(h.run('activeTranslation'));
 h.element('translationMode').value='off';h.element('translationMode').onchange();assert.equal(h.run('activeTranslation.controller.signal.aborted'),true);
 await h.release('/api/translate');h.run('stop()');
});

test('calm word layout waits for a complete gloss batch instead of expanding on every streamed word',async()=>{
  const h=await harness({glossStreaming:true});
  h.element('readingMode').value='steady';h.element('translationLayout').value='words';
  h.run(`const e={id:'settled',text:'Una mesa.',source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()};show(e);requestTranslation(e);`);
  await h.release('/api/translate');
  assert.equal(h.run("messages.get('settled').gloss_status"),'pending');
  assert.doesNotMatch(h.element('messageList').textContent,/текст/);
  await h.release('/api/gloss-stream');
  assert.equal(h.run("messages.get('settled').gloss_status"),'ready');
  assert.match(h.element('messageList').textContent,/текст/);
});
