import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {sourceUnits} from '../public/annotations.js';

async function harness({live=false,streaming=false,glossStreaming=false,sessions=false,activeSession=null,preferences={},sessionResponder,confirmDelete=true,configOverride={},clipboard} = {}) {
  const elements = new Map();
  const windowListeners = new Map();
  function createClassList() {
    return {
      toggle(name, force) {
        const names = new Set((this.owner.className || '').split(' ').filter(Boolean));
        const on = force ?? !names.has(name);
        if (on)
          names.add(name);
        else
          names.delete(name);
        this.owner.className = [...names].join(' ');
        return on;
      },
      add(name) { this.toggle(name, true); },
      remove(name) { this.toggle(name, false); },
      contains(name) { return (this.owner.className || '').split(' ').includes(name); }
    };
  }

  const element = id => {
    if (!elements.has(id)) elements.set(id,{value:'',_text:'',get textContent(){return this.children.length ? this.children.map(n=>n.textContent).join('') : this._text;},set textContent(v){this._text=v;this.children=[];},hidden:false,disabled:false,options:[],children:[],attributes:{},scrollTop:0,scrollHeight:1000,clientHeight:400,classList:createClassList(),add(option){this.options.push(option);},append(...items){for(const item of items){item.parent=this;this.children.push(item);}},remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);},replaceChildren(){this.children=[];},setAttribute(k,v){this.attributes[k]=v;},showModal(){},close(){}});
    elements.get(id).classList.owner = elements.get(id);
    return elements.get(id);
  };
  for (const [id,value] of Object.entries({engine:'qwen',interval:'1.5',threshold:'.012',translationMode:'always',translationLayout:'line',showOriginal:'show',showParticipants:'hide',textSize:'normal',theme:'auto',palette:'graphite',readingMode:'live',saveConversations:'on'})) {element(id).value=value; element(id).options=[{value}];}
  element('theme').options = ['auto','light','dark'].map(value => ({value}));
  element('palette').options = ['graphite','sand','sage','ocean','lilac'].map(value => ({value}));
  element('saveConversations').options = [{value:'on'}, {value:'off'}];
  element('historyPanel').hidden=true;
  const requests=[], pending=[];
  const sessionRequests = [];
  const context = vm.createContext({console,structuredClone,TextDecoder,URL,URLSearchParams,Blob,AbortSignal,AbortController,performance,crypto:webcrypto,
    Option:class {constructor(label,value){this.label=label;this.value=value;}},
    document:{getElementById:element,createElement:()=>element('node'+Math.random()),createTextNode:text=>({textContent:text}),body:{classList:{toggle(){}},setAttribute(){}}},
    localStorage:{getItem:key=>key==='claro.preferences.v1'?JSON.stringify(preferences):null,setItem(){}},confirm:()=>confirmDelete,window:{addEventListener(type, listener){windowListeners.set(type, listener);}},setInterval(){},setTimeout,
    navigator:{clipboard,mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}],getAudioTracks:()=>[{}]})}},
    AudioContext:class {constructor(){this.sampleRate=16000;this.audioWorklet={addModule:async()=>{}};} async resume(){} close(){return Promise.resolve();} createMediaStreamSource(){return {connect(node){return node;},disconnect(){}};} createGain(){return {gain:{},connect(){},disconnect(){}};}},
    AudioWorkletNode:class {constructor(){this.port={};}connect(node){return node;}disconnect(){}},
    fetch:async(path,options)=>{
      if(path==='/api/config')return {ok:true,json:async()=>({token:'test',translator:true,default_engine:'qwen',engines:{qwen:{ready:true}},translation:{},gloss:{ready:true},features:{sessions,live_translation:live,translation_streaming:streaming,gloss_streaming:glossStreaming},...configOverride})};
      if (path.startsWith('/api/sessions')) {
        const request = {path, method:options.method, headers:options.headers, input:options.body ? JSON.parse(options.body) : undefined};
        sessionRequests.push(request);
        if (sessionResponder) {
          const response = await sessionResponder(request);
          if (response)
            return response;
        }
        const result = path === '/api/sessions/active' ? activeSession || {session:null}
          : options.method === 'POST' ? {id:'11111111-1111-4111-8111-111111111111'}
          : {ok:true,seq:1};
        return {ok:true,json:async()=>result};
      }
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
  const publicRoot = new URL('../public/', import.meta.url);
  const modules = new Map();
  function loadModule(url) {
    if (!modules.has(url.href)) {
      const loading = readFile(url, 'utf8').then(source => new vm.SourceTextModule(source, {
        context,
        identifier: url.href
      }));
      modules.set(url.href, loading);
    }
    return modules.get(url.href);
  }
  const entry = await loadModule(new URL('app.js', publicRoot));
  await entry.link((specifier, referencingModule) => {
    assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), 'relative module import');
    const url = new URL(specifier, referencingModule.identifier);
    assert.ok(url.href.startsWith(publicRoot.href), 'module belongs to public/');
    return loadModule(url);
  });
  await entry.evaluate();
  const {state} = (await loadModule(new URL('state.js', publicRoot))).namespace;
  const exports = Object.create(null);
  for (const loading of modules.values()) {
    Object.assign(exports, (await loading).namespace);
  }
  context.__scope = new Proxy(state, {
    has(target, key) {
      return Object.hasOwn(target, key) || Object.hasOwn(exports, key);
    },
    get(target, key) {
      if (key === Symbol.unscopables)
        return undefined;
      return Object.hasOwn(target, key) ? target[key] : exports[key];
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    }
  });
  const run = source => vm.runInContext(`with (__scope) { ${source}\n}`, context);
  const settle=()=>new Promise(resolve=>setImmediate(resolve)); await settle();
  async function feed(frames,volume=.05){for(let i=0;i<frames;i++)run(`capture.port.onmessage({data:new Float32Array(1600).fill(${volume})})`);await settle();}
  async function release(path){const index=path ? pending.findIndex(item=>item.path===path) : 0;assert.ok(index>=0 && pending.length,'model request pending');pending.splice(index,1)[0]();await settle();}
  return {element,run,feed,release,settle,requests,pending,sessionRequests,windowListeners};
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


test('session persistence saves only finalized captions and includes their completed translation', async () => {
  const h = await harness({sessions:true, live:true});
  await h.run('start()');
  await h.feed(15);
  assert.equal(h.sessionRequests.filter(request => request.method === 'POST').length, 0);
  await h.release('/api/translate');
  assert.equal(h.sessionRequests.filter(request => request.method === 'PUT').length, 0);
  await h.feed(13, 0);
  await h.release('/api/translate');
  const saved = h.sessionRequests.filter(request => request.method === 'PUT').at(-1);
  assert.equal(saved.input.text, h.run('current.text'));
  assert.equal(saved.input.translation, h.run('current.translation'));
  assert.equal(saved.input.translation_status, 'ready');
  assert.equal(saved.headers['X-Session-Token'], 'test');
  assert.equal(h.sessionRequests.filter(request => request.method === 'POST').length, 1);
  h.run('stop()');
});

test('session persistence restores active turns in sequence with ready translations and word meanings', async () => {
  const turn = {
    id:'restored', seq:1, text:'Una mesa.', translation:'Стол.',
    source_language:'es', target_language:'ru', created_at:'2026-01-01T00:00:00.000Z',
    speaker_id:'self', glosses:sourceUnits('Una mesa.').map(unit => ({...unit, meaning:'слово'})),
    extra:{translation_status:'ready', gloss_status:'ready', revision:3}
  };
  const h = await harness({sessions:true, activeSession:{session:{id:'restored-session'}, turns:[{...turn,id:'second',seq:2},turn]}});
  assert.equal(h.run('sessionId'), 'restored-session');
  assert.equal(h.run('history.map(turn => turn.id).join(",")'), 'restored,second');
  assert.equal(h.run('messages.get("restored").translation_status'), 'ready');
  assert.equal(h.run('messages.get("restored").gloss_status'), 'ready');
  assert.equal(h.run('messages.get("restored").revision'), 3);
  assert.equal(h.run('messages.get("restored").speaker_id'), 'self');
  assert.equal(h.run('demoActive'), false);
  assert.equal(h.element('messageList').children.length, 2);
  h.element('translationLayout').value = 'words';
  h.element('translationLayout').onchange();
  await h.settle();
  assert.equal(h.requests.length, 0);
  assert.equal(h.sessionRequests.length, 1);
});

test('new conversation ends the current session and creates its successor lazily', async () => {
  const h = await harness({sessions:true});
  h.run("show({id:'first',text:'Una mesa.',source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()})");
  await h.settle();
  const sessionId = h.run('sessionId');
  await h.element('clear').onclick();
  assert.equal(h.sessionRequests.at(-1).path, `/api/sessions/${sessionId}`);
  assert.equal(h.sessionRequests.at(-1).method, 'PATCH');
  assert.equal(h.sessionRequests.at(-1).input.ended, true);
  assert.equal(h.run('sessionId'), null);
  assert.equal(h.run('history.length'), 0);
  assert.equal(h.run('messages.size'), 0);
  assert.equal(h.sessionRequests.filter(request => request.method === 'POST').length, 1);
});

test('disabled conversation saving performs no storage requests', async () => {
  const h = await harness({sessions:true, preferences:{saveConversations:'off'}});
  await h.run('start()');
  await h.feed(15);
  await h.feed(13, 0);
  await h.release('/api/translate');
  h.element('clear').onclick();
  await h.settle();
  assert.equal(h.sessionRequests.length, 0);
});

test('session writes coalesce updates and finish before ending or deleting a conversation', async () => {
  let releaseWrite;
  const h = await harness({sessions:true, sessionResponder:request => {
    if (request.method === 'PUT' && !releaseWrite)
      return new Promise(resolve => {
        releaseWrite = () => resolve({ok:true,json:async()=>({ok:true,seq:1})});
      });
  }});
  h.run("show({id:'coalesced',text:'Una mesa.',source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()})");
  await h.settle();
  const finishing = h.element('deleteConversation').onclick();
  await h.settle();
  h.run("messages.get('coalesced').translation='Стол.';moduleBus.publish('translation',{caption_id:'coalesced'});moduleBus.publish('interlinear',{caption_id:'coalesced'});");
  await h.settle();
  assert.equal(h.sessionRequests.filter(request => request.method === 'PUT').length, 1);
  assert.equal(h.sessionRequests.some(request => request.method === 'DELETE'), false);
  releaseWrite();
  await finishing;
  assert.equal(h.sessionRequests.filter(request => request.method === 'PUT').length, 2);
  assert.equal(h.sessionRequests.filter(request => request.method === 'PUT')[1].input.translation, 'Стол.');
  assert.equal(h.sessionRequests.at(-1).method, 'DELETE');
  assert.equal(h.run('history.length'), 0);
});

test('storage errors leave captions available and show the saving status once', async () => {
  const h = await harness({sessions:true, sessionResponder:request => {
    if (request.method === 'POST')
      return {ok:false};
  }});
  h.run("show({id:'failure',text:'Una mesa.',source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()})");
  await h.settle();
  assert.equal(h.element('status').textContent, 'Не удалось сохранить разговор');
  h.element('status').textContent = 'Слушаю';
  h.run("moduleBus.publish('translation',{caption_id:'failure'})");
  await h.settle();
  assert.equal(h.element('status').textContent, 'Слушаю');
  assert.equal(h.run('history.length'), 1);
  assert.equal(h.run('messages.size'), 1);
});

test('demos and captions without the storage feature never issue storage requests', async () => {
  const h = await harness({sessions:true});
  h.element('demo').onclick();
  await h.settle();
  assert.equal(h.sessionRequests.length, 1);
  const legacy = await harness();
  legacy.run("show({id:'local',text:'Una mesa.',source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()})");
  await legacy.settle();
  assert.equal(legacy.sessionRequests.length, 0);
  assert.equal(legacy.element('deleteConversation').hidden, true);
});

test('a late session creation cannot attach a new conversation to the discarded session', async () => {
  let releaseCreation;
  let creations = 0;
  const h = await harness({sessions:true, sessionResponder:request => {
    if (request.method !== 'POST')
      return;
    creations++;
    if (creations === 1)
      return new Promise(resolve => {
        releaseCreation = () => resolve({ok:true,json:async()=>({id:'old-session'})});
      });
    return {ok:true,json:async()=>({id:'new-session'})};
  }});
  const caption = "show({id:'same-id',text:'Una mesa.',source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()})";
  h.run(caption);
  await h.settle();
  h.element('saveConversations').value = 'off';
  h.element('saveConversations').onchange();
  h.element('clear').onclick();
  h.element('saveConversations').value = 'on';
  h.element('saveConversations').onchange();
  h.run(caption);
  await h.settle();
  releaseCreation();
  await h.settle();
  const writes = h.sessionRequests.filter(request => request.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/sessions/new-session/turns/same-id');
  assert.equal(h.run('sessionId'), 'new-session');
  assert.equal(creations, 2);
});

test('switching saving off discards queued storage updates after an in-flight write', async () => {
  let releaseWrite;
  const h = await harness({sessions:true, sessionResponder:request => {
    if (request.method === 'PUT')
      return new Promise(resolve => {
        releaseWrite = () => resolve({ok:true,json:async()=>({ok:true,seq:1})});
      });
  }});
  h.run("show({id:'disabled',text:'Una mesa.',source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()})");
  await h.settle();
  h.run("messages.get('disabled').translation='Стол.';moduleBus.publish('translation',{caption_id:'disabled'})");
  await h.settle();
  h.element('saveConversations').value = 'off';
  h.element('saveConversations').onchange();
  releaseWrite();
  await h.settle();
  assert.equal(h.sessionRequests.filter(request => request.method === 'PUT').length, 1);
  assert.equal(h.run('messages.get("disabled").translation'), 'Стол.');
});

test('restoration makes interrupted results retryable and preserves the finished source caption', async () => {
  const h = await harness({sessions:true, activeSession:{session:{id:'interrupted'}, turns:[{
    id:'unfinished', seq:1, text:'Una mesa.', translation:'Черновой перевод',
    source_language:'es', target_language:'ru', created_at:'2026-01-01T00:00:00.000Z',
    extra:{translation_status:'streaming',gloss_status:'pending'},
    glosses:[{index:0,source:'Una',meaning:'один',start:0,end:3}]
  }]}});
  assert.equal(h.run('history[0].text'), 'Una mesa.');
  assert.equal(h.run('history[0].final'), true);
  assert.equal(h.run('history[0].translation_status'), 'cancelled');
  assert.equal(h.run('history[0].gloss_status'), 'cancelled');
  assert.equal(h.requests.length, 0);
});

test('declining deletion preserves the conversation without a DELETE request', async () => {
  const h = await harness({sessions:true, confirmDelete:false});
  h.run("show({id:'keep',text:'Una mesa.',source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()})");
  await h.settle();
  h.element('deleteConversation').onclick();
  await h.settle();
  assert.equal(h.sessionRequests.some(request => request.method === 'DELETE'), false);
  assert.equal(h.run('history.length'), 1);
});

test('word meanings and speaker corrections update the complete persisted turn', async () => {
  const h = await harness({sessions:true});
  h.element('translationLayout').value = 'words';
  h.run("show({id:'annotated',text:'Una mesa.',source_language:'es',target_language:'ru',final:true,revision:4,created_at:new Date().toISOString()});requestTranslation(current)");
  await h.release('/api/translate');
  await h.release('/api/gloss');
  h.run(`
    assignSpeaker(current, 'self', participants);
    moduleBus.publish('speaker_assignment', {caption_id:current.id});
  `);
  await h.settle();
  const saved = h.sessionRequests.filter(request => request.method === 'PUT').at(-1).input;
  assert.equal(saved.speaker_id, 'self');
  assert.equal(saved.speaker_assignment.origin, 'manual');
  assert.equal(saved.gloss_status, 'ready');
  assert.equal(saved.glosses.length, 2);
  assert.equal(saved.translation_status, 'ready');
  assert.equal(saved.revision, 4);
});

test('feed keeps self alignment with hidden participants and groups consecutive speakers', async () => {
  const h = await harness();
  h.element('translationMode').value = 'off';
  h.run(`
    for (const [id, speaker_id] of [['first','self'], ['second','self'], ['third','guest']])
      show({id, speaker_id, text:'Una frase.', source_language:'es', target_language:'ru', final:true}, false);
  `);
  const rows = h.element('messageList').children;
  assert.ok(rows[0].classList.contains('self-message'));
  assert.ok(rows[1].classList.contains('self-message'));
  assert.ok(rows[1].classList.contains('same-speaker'));
  assert.equal(rows[2].classList.contains('self-message'), false);
  assert.equal(rows[2].classList.contains('same-speaker'), false);
  assert.ok(rows.every(row => !row.children.some(node => node.className === 'message-meta')));
  h.element('showParticipants').value = 'show';
  h.element('showParticipants').onchange();
  assert.ok(rows.every(row => row.children[0].className === 'message-meta'));
  assert.ok(rows[1].classList.contains('same-speaker'));
});

test('word window includes phrase context and one meaning for a whole expression', async () => {
  const h = await harness();
  h.element('translationLayout').value = 'words';
  h.run(`show({id:'expression',demo:true,text:'¿Nos vemos mañana?',translation:'Увидимся завтра?',
    source_language:'es',target_language:'ru',final:true,translation_status:'ready',gloss_status:'ready',
    glosses:[{source:'Nos vemos',meaning:'увидимся'},{source:'mañana?',meaning:'завтра?'}]},false)`);
  const original = h.element('messageList').children[0].children[0];
  assert.equal(original.children.length, 2);
  assert.equal(original.children[0].children[0].textContent, '¿Nos vemos');
  assert.equal(original.children[0].children[1].textContent, 'увидимся');
  original.children[0].children[0].onclick();
  assert.equal(h.element('wordMeaning').textContent, 'увидимся');
  assert.equal(h.element('wordPhrase').textContent, '¿Nos vemos mañana?');
  assert.equal(h.element('wordTranslation').textContent, 'Увидимся завтра?');
});

test('recording capsule reads the meter and resets its tabular timer after stop', async () => {
  const h = await harness();
  assert.equal(h.element('listenLabel').textContent, 'Слушать');
  await h.run('start()');
  assert.equal(h.element('listenLabel').textContent, 'Стоп');
  h.element('meter').value = 0.08;
  h.run('updateRecordingIndicator(1000); updateRecordingIndicator(66000);');
  assert.equal(h.element('recordingTime').textContent, '01:05');
  assert.equal(h.element('soundLevel').attributes['data-level'], '4');
  h.run('stop(); updateRecordingIndicator(67000);');
  assert.equal(h.element('listenLabel').textContent, 'Слушать');
  assert.equal(h.element('recordingTime').textContent, '00:00');
  assert.equal(h.element('soundLevel').attributes['data-level'], '0');
});

test('appearance settings preserve saved values alongside conversation storage preferences', async () => {
  const h = await harness({preferences:{theme:'dark',palette:'sage',saveConversations:'off'}});
  assert.equal(h.element('theme').value, 'dark');
  assert.equal(h.element('palette').value, 'sage');
  assert.equal(h.element('saveConversations').value, 'off');
  h.run(`window.claroAppearance = {apply(theme,palette){window.appliedAppearance = [theme,palette];}};`);
  h.run(`localStorage.setItem = (key,value) => {window.savedPreferences = JSON.parse(value);};`);
  h.element('palette').value = 'ocean';
  h.element('palette').onchange();
  assert.deepEqual(Array.from(h.run('window.appliedAppearance')), ['dark','ocean']);
  assert.equal(h.run('window.savedPreferences.theme'), 'dark');
  assert.equal(h.run('window.savedPreferences.palette'), 'ocean');
  assert.equal(h.run('window.savedPreferences.saveConversations'), 'off');
});

test('language selectors in settings mirror the feed and capture availability', async () => {
  const h = await harness();
  assert.equal(h.element('settingsLanguage').value, 'es');
  assert.equal(h.element('settingsTargetLanguage').value, 'ru');
  h.element('settingsLanguage').value = 'en';
  h.element('settingsLanguage').onchange();
  assert.equal(h.element('language').value, 'en');
  h.element('swap').onclick();
  assert.equal(h.element('settingsLanguage').value, 'ru');
  assert.equal(h.element('settingsTargetLanguage').value, 'en');
  await h.run('start()');
  assert.equal(h.element('settingsLanguage').disabled, true);
  assert.equal(h.element('settingsTargetLanguage').disabled, true);
  h.run('stop()');
  assert.equal(h.element('settingsLanguage').disabled, false);
});

test('translation errors retain the source and expose a retry in the last action row', async () => {
  const h = await harness();
  h.run(`show({id:'failed',text:'Una frase.',source_language:'es',target_language:'ru',
    final:true,translation_status:'error'},false)`);
  const row = h.element('messageList').children[0];
  assert.equal(row.children[0].textContent, 'Una frase.');
  assert.equal(row.children.at(-1).className, 'message-actions');
  assert.match(row.children.at(-1).textContent, /Перевод не получился ·Повторить/);
  row.children.at(-1).children.at(-1).onclick();
  assert.equal(h.requests[0].path, '/api/translate');
  await h.release('/api/translate');
  assert.match(row.textContent, /Перевод failed/);
});

test('recognition preparation keeps the capsule disabled with technical detail in settings', async () => {
  const h = await harness();
  h.run(`config.engines.qwen = {ready:false,message:'Распознавание загружается…'}; liveReady = false; controls();`);
  assert.equal(h.element('listen').disabled, true);
  assert.equal(h.run('recognitionStatus()'), 'Загружаем распознавание…');
  assert.equal(h.element('engineStatus').textContent, 'Распознавание загружается…');
});

function libraryFixture() {
  const session = {
    id:'22222222-2222-4222-8222-222222222222', title:'Пример разговора',
    source_language:'es', target_language:'ru', started_at:new Date().toISOString(),
    ended_at:new Date().toISOString(), turn_count:1, preview:'Una mesa.'
  };
  const turn = {
    id:'saved-turn', session_id:session.id, seq:1, text:'Una mesa.', translation:'Стол.',
    source_language:'es', target_language:'ru', created_at:session.started_at, speaker_id:'self',
    glosses:sourceUnits('Una mesa.').map(unit => ({...unit,meaning:'слово'})),
    extra:{translation_status:'ready',gloss_status:'ready',revision:3}
  };
  const fixture = {sessions:[session], turns:[turn], session};
  fixture.respond = request => {
    const path = new URL(request.path, 'http://localhost').pathname;
    let result;
    if (path === '/api/sessions' && request.method === 'GET')
      result = {sessions:fixture.sessions};
    else if (path === `/api/sessions/${session.id}`) {
      if (request.method === 'DELETE') {
        fixture.sessions = [];
        result = {ok:true};
      } else if (request.method === 'PATCH') {
        Object.assign(session, request.input);
        result = session;
      } else
        result = {session,turns:fixture.turns};
    } else
      return;
    return {ok:true,json:async()=>structuredClone(result)};
  };
  return fixture;
}

test('library loads saved conversations with day groups, languages, counts and client search', async () => {
  const fixture = libraryFixture();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  fixture.sessions.push({...fixture.session,id:'yesterday',title:null,preview:'Otra frase de ejemplo.',started_at:yesterday.toISOString()});
  fixture.sessions.push({...fixture.session,id:'older',title:'Старый пример',started_at:'2020-01-02T10:30:00.000Z'});
  const h = await harness({sessions:true,sessionResponder:fixture.respond});
  await h.element('historyTab').onclick();
  assert.equal(h.element('legacyHistory').hidden, true);
  assert.equal(h.element('library').hidden, false);
  assert.match(h.element('libraryList').textContent, /Сегодня.*Пример разговора.*Испанский → Русский · 1 реплика/);
  assert.match(h.element('libraryList').textContent, /Вчера.*Otra frase de ejemplo\./);
  assert.match(h.element('libraryList').textContent, /2 января 2020/);
  const request = h.sessionRequests.find(request => request.path.startsWith('/api/sessions?'));
  assert.equal(request.method, 'GET');
  assert.equal(request.headers['X-Session-Token'], 'test');
  const requests = h.sessionRequests.length;
  h.element('librarySearch').value = 'MESA';
  h.element('librarySearch').oninput();
  assert.match(h.element('libraryList').textContent, /Пример разговора/);
  assert.doesNotMatch(h.element('libraryList').textContent, /Otra frase/);
  h.element('librarySearch').value = 'ничего похожего';
  h.element('librarySearch').oninput();
  assert.match(h.element('libraryList').textContent, /Ничего не нашлось/);
  h.element('libraryList').children.at(-1).onclick();
  assert.equal(h.element('librarySearch').value, '');
  assert.equal(h.sessionRequests.length, requests);
});

test('library opens saved bubbles and word meanings without mutating or writing the current conversation', async () => {
  const fixture = libraryFixture();
  const h = await harness({sessions:true,sessionResponder:fixture.respond});
  h.run("show({id:'local-turn',demo:true,text:'Otra frase.',source_language:'es',target_language:'ru',final:true},false)");
  await h.element('historyTab').onclick();
  const row = h.element('libraryList').children[0].children[1];
  await row.onclick();
  assert.equal(h.element('libraryListView').hidden, true);
  assert.equal(h.element('libraryDetail').hidden, false);
  assert.equal(h.element('captureBar').hidden, true);
  assert.match(h.element('libraryMessages').textContent, /Una.*mesa\..*Стол\./);
  assert.equal(h.element('libraryMessages').children[0].attributes['data-caption-id'], 'saved-turn');
  const savedRow = h.element('libraryMessages').children[0];
  savedRow.children[0].children[0].children[0].onclick();
  assert.equal(h.element('wordMeaning').textContent, 'слово');
  assert.equal(h.element('wordTranslation').textContent, 'Стол.');
  h.run('refreshWordPeek()');
  assert.equal(h.element('wordPhrase').textContent, 'Una mesa.');
  assert.equal(h.run('messages.size'), 1);
  assert.equal(h.run('messages.has("local-turn")'), true);
  assert.equal(h.run('history.length'), 0);
  assert.equal(h.requests.length, 0);
  assert.ok(h.sessionRequests.every(request => request.method === 'GET'));
  h.element('showParticipants').value = 'show';
  h.element('showParticipants').onchange();
  assert.equal(savedRow.children[0].className, 'message-meta');
  assert.equal(savedRow.children[0].children.length, 0);
  h.element('translationLayout').value = 'words';
  h.element('translationLayout').onchange();
  assert.match(h.element('libraryMessages').textContent, /слово/);
  await h.element('libraryBack').onclick();
  assert.equal(h.element('libraryDetail').hidden, true);
  assert.equal(h.run('wordPeek'), null);
});

test('library rename sends a token-protected PATCH and enforces the title limit', async () => {
  const fixture = libraryFixture();
  const h = await harness({sessions:true,sessionResponder:fixture.respond});
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  h.element('libraryRename').onclick();
  assert.equal(h.element('libraryName').value, 'Пример разговора');
  assert.equal(h.element('libraryRenameForm').hidden, false);
  h.element('libraryName').value = 'x'.repeat(121);
  await h.element('libraryRenameForm').onsubmit({preventDefault(){}});
  assert.equal(h.sessionRequests.some(request => request.method === 'PATCH'), false);
  h.element('libraryName').value = 'Новое название';
  await h.element('libraryRenameForm').onsubmit({preventDefault(){}});
  const request = h.sessionRequests.at(-1);
  assert.equal(request.path, `/api/sessions/${fixture.session.id}`);
  assert.equal(request.method, 'PATCH');
  assert.deepEqual(request.input, {title:'Новое название'});
  assert.equal(request.headers['X-Session-Token'], 'test');
  assert.equal(h.element('libraryTitle').textContent, 'Новое название');
  assert.equal(h.element('libraryRenameForm').hidden, true);
  await h.element('libraryBack').onclick();
  assert.match(h.element('libraryList').textContent, /Новое название/);
});

test('library deletion sends DELETE after confirmation and returns to the refreshed list', async () => {
  const fixture = libraryFixture();
  const h = await harness({sessions:true,sessionResponder:fixture.respond});
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  await h.element('libraryDelete').onclick();
  const request = h.sessionRequests.find(request => request.method === 'DELETE');
  assert.equal(request.path, `/api/sessions/${fixture.session.id}`);
  assert.equal(request.headers['X-Session-Token'], 'test');
  assert.equal(h.element('libraryDetail').hidden, true);
  assert.match(h.element('libraryList').textContent, /Пока нет разговоров/);
});

test('declining library deletion keeps the saved conversation open', async () => {
  const fixture = libraryFixture();
  const h = await harness({sessions:true,sessionResponder:fixture.respond,confirmDelete:false});
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  await h.element('libraryDelete').onclick();
  assert.equal(h.sessionRequests.some(request => request.method === 'DELETE'), false);
  assert.equal(h.element('libraryDetail').hidden, false);
});

test('library continues only the current active conversation and preserves capture through navigation', async () => {
  const fixture = libraryFixture();
  fixture.session.ended_at = null;
  const h = await harness({sessions:true,sessionResponder:fixture.respond,
    activeSession:{session:fixture.session,turns:fixture.turns}});
  await h.run('start()');
  await h.element('historyTab').onclick();
  assert.match(h.element('libraryList').textContent, /Сейчас/);
  assert.equal(h.run('running'), true);
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  assert.equal(h.element('libraryContinue').hidden, false);
  h.element('libraryContinue').onclick();
  assert.equal(h.element('readerPanel').hidden, false);
  assert.equal(h.element('historyPanel').hidden, true);
  assert.equal(h.element('captureBar').hidden, false);
  assert.equal(h.run('sessionId'), fixture.session.id);
  h.run('stop()');
  fixture.session.ended_at = new Date().toISOString();
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  assert.equal(h.element('libraryContinue').hidden, true);
});

test('deleting the active conversation from the library clears its persistence identity', async () => {
  const fixture = libraryFixture();
  fixture.session.ended_at = null;
  const h = await harness({sessions:true,sessionResponder:fixture.respond,
    activeSession:{session:fixture.session,turns:fixture.turns}});
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  await h.element('libraryDelete').onclick();
  assert.equal(h.run('sessionId'), null);
  assert.equal(h.run('messages.size'), 0);
  assert.equal(h.run('history.length'), 0);
  assert.equal(h.element('libraryDetail').hidden, true);
  assert.equal(h.sessionRequests.filter(request => request.method === 'DELETE').length, 1);
});

test('library offers retry for loading failures, empty navigation and disabled-storage settings', async () => {
  const fixture = libraryFixture();
  let fail = true;
  const h = await harness({sessions:true,sessionResponder:request => {
    if (request.path.startsWith('/api/sessions?') && fail)
      return {ok:false};
    return fixture.respond(request);
  }});
  await h.element('historyTab').onclick();
  assert.match(h.element('libraryList').textContent, /Не удалось открыть библиотеку/);
  fail = false;
  fixture.sessions = [];
  await h.element('libraryList').children.at(-1).onclick();
  assert.match(h.element('libraryList').textContent, /Пока нет разговоров/);
  h.element('libraryList').children.at(-1).onclick();
  assert.equal(h.element('readerPanel').hidden, false);
  h.element('saveConversations').value = 'off';
  h.element('saveConversations').onchange();
  const count = h.sessionRequests.length;
  await h.element('historyTab').onclick();
  assert.match(h.element('libraryList').textContent, /Сохранение разговоров выключено/);
  let settingsOpened = false;
  h.element('settingsDialog').showModal = () => { settingsOpened = true; };
  h.element('libraryList').children.at(-1).onclick();
  assert.equal(settingsOpened, true);
  assert.equal(h.sessionRequests.length, count);
});

test('without session support the library tab retains the browser history and its export controls', async () => {
  const h = await harness();
  h.run("show({id:'legacy-turn',text:'Una mesa.',source_language:'es',target_language:'ru',final:true,created_at:new Date().toISOString()})");
  await h.element('historyTab').onclick();
  assert.equal(h.element('legacyHistory').hidden, false);
  assert.equal(h.element('library').hidden, true);
  assert.match(h.element('history').textContent, /Una mesa\./);
  assert.equal(h.element('save').disabled, false);
  assert.equal(h.sessionRequests.length, 0);
});

test('library exports saved turns as TXT and schema v2 JSON with stable IDs and revisions', async () => {
  const fixture = libraryFixture();
  const h = await harness({sessions:true,sessionResponder:fixture.respond});
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  h.run(`
    URL = class extends URL {
      static createObjectURL(blob) { window.exportedBlob = blob; return 'blob:export'; }
      static revokeObjectURL() {}
    };
    const originalCreateElement = document.createElement;
    document.createElement = type => {
      const element = originalCreateElement(type);
      element.click = () => {};
      return element;
    };
  `);
  h.element('libraryExport').onclick();
  assert.equal(h.element('libraryExports').hidden, false);
  h.element('libraryExportJson').onclick();
  const exported = JSON.parse(await h.run('window.exportedBlob.text()'));
  assert.equal(exported.schema_version, 2);
  assert.equal(exported.captions.length, 1);
  assert.equal(exported.captions[0].id, 'saved-turn');
  assert.equal(exported.captions[0].revision, 3);
  assert.equal(exported.captions[0].glosses[0].meaning, 'слово');
  assert.ok(exported.participants.some(participant => participant.id === 'self'));
  h.element('libraryExportText').onclick();
  assert.match(await h.run('window.exportedBlob.text()'), /\[es → ru\] Una mesa\.\nСтол\./);
  assert.equal(h.run('history.length'), 0);
});

test('library mutation errors preserve the open saved conversation and support another attempt', async () => {
  const fixture = libraryFixture();
  let fail = true;
  const h = await harness({sessions:true,sessionResponder:request => {
    if (fail && ['PATCH','DELETE'].includes(request.method))
      return {ok:false};
    return fixture.respond(request);
  }});
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  h.element('libraryRename').onclick();
  h.element('libraryName').value = 'Новое название';
  await h.element('libraryRenameForm').onsubmit({preventDefault(){}});
  assert.match(h.element('libraryActionError').textContent, /Не удалось переименовать/);
  assert.equal(h.element('libraryRenameSave').disabled, false);
  await h.element('libraryDelete').onclick();
  assert.match(h.element('libraryActionError').textContent, /Не удалось удалить/);
  assert.equal(h.element('libraryDelete').disabled, false);
  assert.equal(h.element('libraryDetail').hidden, false);
  fail = false;
  await h.element('libraryDelete').onclick();
  assert.equal(h.element('libraryDetail').hidden, true);
});

test('disabling storage while a saved conversation loads ignores the late response', async () => {
  const fixture = libraryFixture();
  let finish;
  const h = await harness({sessions:true,sessionResponder:request => {
    if (request.path === `/api/sessions/${fixture.session.id}`)
      return new Promise(resolve => { finish = () => resolve(fixture.respond(request)); });
    return fixture.respond(request);
  }});
  await h.element('historyTab').onclick();
  const opening = h.run(`openSavedConversation('${fixture.session.id}')`);
  h.element('saveConversations').value = 'off';
  h.element('saveConversations').onchange();
  finish();
  await opening;
  assert.equal(h.element('libraryDetail').hidden, true);
  assert.match(h.element('libraryList').textContent, /Сохранение разговоров выключено/);
});

test('library displays complete saved meanings up to the storage limit without starting word work', async () => {
  const fixture = libraryFixture();
  const meaning = 'Длинное сохранённое значение '.repeat(20).slice(0, 299) + 'я';
  fixture.turns[0].glosses[0].meaning = meaning;
  const h = await harness({sessions:true,sessionResponder:fixture.respond});
  h.element('translationLayout').value = 'words';
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  const source = h.element('libraryMessages').children[0].children[0];
  assert.equal(source.children[0].children[1].textContent, meaning);
  source.children[0].children[0].onclick();
  assert.equal(h.element('wordMeaning').textContent, meaning);
  fixture.turns[0].glosses = null;
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  assert.match(h.element('libraryMessages').textContent, /Стол\./);
  h.element('libraryMessages').children[0].children[0].children[0].children[0].onclick();
  assert.equal(h.element('wordMeaning').textContent, 'Значение слова не сохранено.');
  assert.equal(h.requests.length, 0);
});

test('starting a new conversation from the library ends the active session and opens the reader', async () => {
  const fixture = libraryFixture();
  fixture.session.ended_at = null;
  const h = await harness({sessions:true,sessionResponder:fixture.respond,
    activeSession:{session:fixture.session,turns:fixture.turns}});
  await h.element('historyTab').onclick();
  await h.element('clear').onclick();
  const request = h.sessionRequests.find(request => request.method === 'PATCH');
  assert.deepEqual(request.input, {ended:true});
  assert.equal(h.element('readerPanel').hidden, false);
  assert.equal(h.run('history.length'), 0);
  assert.equal(h.run('sessionId'), null);
});

test('library groups consecutive saved speakers without repeating participant labels', async () => {
  const fixture = libraryFixture();
  fixture.turns.push({...fixture.turns[0],id:'saved-second',seq:2});
  const h = await harness({sessions:true,sessionResponder:fixture.respond});
  h.element('showParticipants').value = 'show';
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  const rows = h.element('libraryMessages').children;
  assert.equal(rows[0].children[0].className, 'message-meta');
  assert.equal(rows[1].classList.contains('same-speaker'), true);
  assert.equal(rows[1].children.some(node => node.className === 'message-meta'), false);
});


test('missing recognition shows an actionable status and a copyable setup command', async () => {
  let copied;
  const h = await harness({
    configOverride: { ready:false, translator:false, default_engine:'whisper', engines:{whisper:{ready:false,installed:false}} },
    clipboard: { async writeText(text) { copied = text; } }
  });
  assert.match(h.element('status').textContent, /Распознавание не установлено.*npm run setup/u);
  assert.doesNotMatch(h.element('status').textContent, /Подключаем модели/u);
  assert.equal(h.element('emptyTitle').textContent, 'Модели не установлены');
  assert.equal(h.element('setupHelp').hidden, false);
  assert.equal(h.element('listen').disabled, true);
  await h.element('copySetup').onclick();
  assert.equal(copied, 'npm run setup');
  assert.equal(h.element('copySetup').textContent, 'Команда скопирована');
});

test('loading and failed recognition have distinct statuses with a recovery action', async () => {
  const h = await harness({ configOverride:{ready:false,engines:{qwen:{ready:false,message:'Qwen загружается и прогревается…'}}} });
  assert.equal(h.element('status').textContent, 'Загружаем распознавание…');
  assert.equal(h.element('setupHelp').hidden, true);
  h.run("config.engines.qwen = {ready:false,message:'Qwen остановлен.'}");
  await h.run('controls()');
  assert.match(h.run('recognitionStatus()'), /перезапустите Claro/u);
});

test('unavailable translation shows one notice while original captions keep working', async () => {
  const h = await harness({configOverride:{translator:false}});
  assert.equal(h.element('translationNotice').textContent, 'Перевод недоступен');
  assert.equal(h.element('translationNotice').hidden, false);
  await h.run('start()');
  await h.feed(15);
  assert.ok(h.run('current.text'));
  assert.equal(h.run('liveReady'), true);
  h.run('stop()');
});

test('application installation uses the browser prompt and reports the supported fallback', async () => {
  const h = await harness();
  await h.element('installApp').onclick();
  assert.equal(h.element('appInstallHint').textContent, 'В Chrome: меню ⋮ → Установить Claro');
  let prevented = false;
  let prompted = false;
  h.windowListeners.get('beforeinstallprompt')({
    preventDefault() { prevented = true; },
    async prompt() { prompted = true; },
    userChoice: Promise.resolve({outcome:'accepted'})
  });
  assert.equal(prevented, true);
  await h.element('installApp').onclick();
  assert.equal(prompted, true);
  assert.equal(h.element('appInstallHint').textContent, 'Установка Claro запрошена');
  h.windowListeners.get('appinstalled')();
  assert.equal(h.element('appInstallHint').textContent, 'Claro установлено как приложение');
});
