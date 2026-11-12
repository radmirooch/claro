import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {sourceUnits} from '../public/annotations.js';

async function harness({live=false,streaming=false,glossStreaming=false,sessions=false,activeSession=null,preferences={},sessionResponder,confirmDelete=true,configOverride={},clipboard,getDisplayMedia,getUserMedia,pip=false,matchMedia} = {}) {
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
    if (!elements.has(id)) elements.set(id,{value:'',_text:'',get textContent(){return this.children.length ? this.children.map(n=>n.textContent).join('') : this._text;},set textContent(v){this._text=v;this.children=[];},hidden:false,disabled:false,options:[],children:[],attributes:{},scrollTop:0,scrollHeight:1000,clientHeight:400,classList:createClassList(),add(option){this.options.push(option);},append(...items){for(const item of items){item.parent=this;this.children.push(item);}},remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);},replaceChildren(...items){this.children=[];this.append(...items);},setAttribute(k,v){this.attributes[k]=v;},showModal(){},close(){}});
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
  const transcriptions = [];
  const pipListeners = new Map();
  const pipRequests = [];
  const root = element('documentRoot');
  root.getAttribute = name => root.attributes[name];
  root.setAttribute('data-theme', preferences.theme || 'light');
  root.setAttribute('data-palette', preferences.palette || 'graphite');
  const pipWindow = {
    closed: false,
    document: {
      documentElement: element('pipRoot'),
      head: element('pipHead'),
      body: element('pipBody'),
      createElement: () => element('pipNode' + Math.random()),
      addEventListener(type, listener) { pipListeners.set(type, listener); }
    },
    addEventListener(type, listener) { pipListeners.set(type, listener); },
    scrollTo() {},
    focus() {}
  };
  const context = vm.createContext({console,structuredClone,TextDecoder,URL,URLSearchParams,Blob,AbortSignal,AbortController,performance,crypto:webcrypto,
    Option:class {constructor(label,value){this.label=label;this.value=value;}},
    document:{documentElement:root,querySelectorAll:()=>[{href:'http://127.0.0.1:4317/style.css'}],getElementById:element,createElement:()=>element('node'+Math.random()),createTextNode:text=>({textContent:text}),body:{classList:{toggle(){}},setAttribute(){}}},
    localStorage:{getItem:key=>key==='claro.preferences.v1'?JSON.stringify(preferences):null,setItem(){}},confirm:()=>confirmDelete,window:{matchMedia,documentPictureInPicture:pip ? {async requestWindow(options){pipRequests.push(options);return pipWindow;}} : undefined,addEventListener(type, listener){windowListeners.set(type, listener);}},setInterval(){},setTimeout,
    navigator:{clipboard,mediaDevices:{getDisplayMedia,getUserMedia:getUserMedia || (async()=>({getTracks:()=>[{stop(){}}],getAudioTracks:()=>[{}]}))}},
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
        transcriptions.push({path, audio:options.body});
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
  return {element,run,feed,release,settle,requests,pending,sessionRequests,windowListeners,transcriptions,pipWindow,pipListeners,pipRequests};
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

function displayFixture({ audio = true } = {}) {
  const audioTrack = {
    label: 'Учебное видео',
    readyState: 'live',
    stops: 0,
    constraints: [],
    async applyConstraints(value) {
      this.constraints.push(value);
    },
    stop() {
      this.stops++;
      this.readyState = 'ended';
    }
  };
  const videoTrack = {
    stops: 0,
    stop() {
      this.stops++;
    }
  };
  const stream = {
    getAudioTracks: () => audio ? [audioTrack] : [],
    getVideoTracks: () => [videoTrack],
    getTracks: () => audio ? [audioTrack, videoTrack] : [videoTrack]
  };
  const choices = [];
  return {
    stream, audioTrack, videoTrack, choices,
    async getDisplayMedia(options) {
      choices.push(options);
      return stream;
    }
  };
}

test('display capture uses the shared WAV and ASR pipeline, a quiet fixed threshold and watch storage', async () => {
  const fixture = displayFixture();
  const h = await harness({getDisplayMedia:fixture.getDisplayMedia,sessions:true});
  h.element('threshold').value = '0.025';
  h.element('watchTab').onclick();
  assert.equal(h.element('emptyTitle').textContent, 'Выберите, что смотреть');
  assert.equal(h.element('listen').hidden, true);
  await h.run("start({source:'display'})");
  assert.equal(h.run('running'), true);
  assert.equal(fixture.videoTrack.stops, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.choices[0])), {
    video:true,
    audio:{suppressLocalAudioPlayback:false,echoCancellation:false,noiseSuppression:false},
    systemAudio:'include',selfBrowserSurface:'exclude',surfaceSwitching:'include'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.audioTrack.constraints)), [{echoCancellation:false,noiseSuppression:false}]);
  await h.feed(15, 0.009);
  await h.feed(13, 0);
  assert.ok(h.transcriptions.length >= 2);
  assert.equal(new TextDecoder().decode(h.transcriptions[0].audio.slice(0, 4)), 'RIFF');
  assert.equal(h.run('current.input'), 'display');
  assert.equal(h.run('current.final'), true);
  assert.match(h.element('messageList').textContent, /Texto/);
  const created = h.sessionRequests.find(request => request.method === 'POST');
  assert.equal(created.input.kind, 'watch');
  assert.equal(h.element('watchSource').textContent, 'Учебное видео');
  h.run('updateRecordingIndicator(1000); updateRecordingIndicator(66000)');
  assert.equal(h.element('watchTime').textContent, '01:05');
  h.element('watchStop').onclick();
  assert.equal(h.run('running'), false);
});

test('a display source without audio stops its video and offers another choice without starting capture', async () => {
  const fixture = displayFixture({audio:false});
  const h = await harness({getDisplayMedia:fixture.getDisplayMedia,sessions:true});
  h.element('watchTab').onclick();
  await h.element('watchChoose').onclick();
  assert.equal(h.run('running'), false);
  assert.equal(h.run('starting'), false);
  assert.ok(fixture.videoTrack.stops > 0);
  assert.equal(h.element('watchError').textContent, 'В выбранном источнике нет звука. Отметьте „Поделиться звуком“');
  assert.equal(h.element('watchChoose').textContent, 'Выбрать заново');
  assert.equal(h.element('watchChoose').disabled, false);
  assert.equal(h.transcriptions.length, 0);
  assert.equal(h.sessionRequests.some(request => request.method === 'POST'), false);
});

test('ending display audio flushes the final phrase and disposes capture like stop', async () => {
  const fixture = displayFixture();
  const h = await harness({getDisplayMedia:fixture.getDisplayMedia});
  await h.run("start({source:'display'})");
  await h.feed(15);
  const id = h.run('current.id');
  const ended = fixture.audioTrack.onended;
  fixture.audioTrack.readyState = 'ended';
  ended();
  await h.settle();
  assert.equal(h.run('running'), false);
  assert.equal(h.run('capture'), null);
  assert.equal(h.run('stream'), null);
  assert.equal(h.run('history[0].id'), id);
  assert.equal(h.run('history[0].final'), true);
  await h.run('start()');
  ended();
  assert.equal(h.run('running'), true, 'a stale ended callback cannot stop another source');
  h.run('stop()');
});

test('switching between microphone and display ends the old session after its final ASR write', async () => {
  const fixture = displayFixture();
  const h = await harness({getDisplayMedia:fixture.getDisplayMedia,sessions:true});
  await h.run('start()');
  await h.feed(15);
  const oldId = h.run('current.id');
  await h.run("start({source:'display'})");
  assert.equal(h.run('running'), true);
  assert.equal(h.run('captureSource'), 'display');
  assert.equal(h.run('messages.has("' + oldId + '")'), false);
  const ending = h.sessionRequests.findIndex(request => request.method === 'PATCH');
  const oldWrite = h.sessionRequests.findIndex(request => request.method === 'PUT' && request.path.endsWith(oldId));
  assert.ok(oldWrite >= 0 && oldWrite < ending);
  await h.feed(15);
  await h.feed(13, 0);
  assert.deepEqual(h.sessionRequests.filter(request => request.method === 'POST').map(request => request.input.kind), ['conversation','watch']);
  await h.run('start()');
  assert.equal(fixture.audioTrack.readyState, 'ended');
  assert.equal(h.run('captureSource'), 'mic');
  assert.equal(h.run('sessionKind'), 'conversation');
  await h.feed(15);
  await h.feed(13, 0);
  assert.deepEqual(h.sessionRequests.filter(request => request.method === 'POST').map(request => request.input.kind), ['conversation','watch','conversation']);
  h.run('stop()');
});

test('unsupported display and PiP show their reasons and coarse phones hide the watch section', async () => {
  const h = await harness();
  assert.equal(h.element('watchTab').disabled, true);
  assert.equal(h.element('watchUnavailable').hidden, false);
  assert.equal(h.element('watchUnavailable').textContent, 'Звук вкладки работает в Chrome и Edge на компьютере');
  h.element('watchTab').onclick();
  assert.equal(h.run('panel'), 'reader');
  assert.equal(h.element('watchPip').hidden, true);
  assert.equal(h.element('pipUnavailable').textContent, 'Окно поверх видео работает в Chrome и Edge');
  const phone = await harness({getDisplayMedia:displayFixture().getDisplayMedia,
    matchMedia:() => ({matches:true,addEventListener(){}})});
  assert.equal(phone.element('watchTab').hidden, true);
});

test('cancelled and stale display choices release tracks and leave capture available for retry', async () => {
  const h = await harness({getDisplayMedia:async () => { throw Object.assign(new Error(), {name:'NotAllowedError'}); }});
  h.element('watchTab').onclick();
  await h.element('watchChoose').onclick();
  assert.equal(h.run('running'), false);
  assert.match(h.element('watchError').textContent, /Выбор источника отменён/);
  assert.equal(h.element('watchChoose').disabled, false);
  const fixture = displayFixture();
  let resolveChoice;
  const late = await harness({getDisplayMedia:() => new Promise(resolve => { resolveChoice = resolve; })});
  const starting = late.run("start({source:'display'})");
  late.run('stop()');
  resolveChoice(fixture.stream);
  await starting;
  assert.equal(late.run('running'), false);
  assert.equal(fixture.audioTrack.readyState, 'ended');
});

test('every live word click publishes a lookup record in phrase and word layouts, including repeated clicks', async () => {
  const h = await harness();
  await h.run('start()');
  h.run(`
    window.lookups = [];
    moduleBus.subscribe('lookup', record => window.lookups.push(record));
    show({id:'lookup-turn',text:'Una mesa.',source_language:'es',target_language:'ru',final:true,
      translation:'Стол.',gloss_status:'ready',glosses:[{index:0,source:'Una',meaning:'одна'}]});
  `);
  const original = h.element('messageList').children[0].children[0];
  original.children[0].children[0].onclick();
  original.children[0].children[0].onclick();
  await h.settle();
  const record = JSON.parse(h.run('JSON.stringify(window.lookups[0])'));
  assert.deepEqual({...record,at:undefined}, {
    caption_id:'lookup-turn',index:0,source:'Una',meaning:'одна',source_language:'es',target_language:'ru',at:undefined
  });
  assert.ok(Number.isFinite(Date.parse(record.at)));
  assert.equal(h.run('window.lookups.length'), 2);
  h.element('translationLayout').value = 'words';
  h.run('renderConversation()');
  h.element('messageList').children[0].children[0].children[0].children[1].onclick();
  await h.settle();
  assert.equal(h.run('window.lookups.length'), 3);
  assert.equal(h.run("MODULES.find(module => module.id === 'lookups').available"), true);
  h.run('stop()');
  h.element('messageList').children[0].children[0].children[0].children[0].onclick();
  await h.settle();
  assert.equal(h.run('window.lookups.length'), 3);
});

test('PiP copies linked styles and appearance, renders the latest records and handles word lookup locally', async () => {
  const fixture = displayFixture();
  const h = await harness({getDisplayMedia:fixture.getDisplayMedia,pip:true,preferences:{theme:'dark',palette:'sage'}});
  h.element('watchTab').onclick();
  await h.element('watchChoose').onclick();
  h.run(`
    window.lookups = [];
    moduleBus.subscribe('lookup', record => window.lookups.push(record));
    for (let index = 0; index < 5; index++)
      show({id:'pip-'+index,text:'Una mesa.',source_language:'es',target_language:'ru',final:true,
        translation:'Стол.',gloss_status:'ready',glosses:[{index:0,source:'Una',meaning:'одна'}]});
    show({id:'pip-draft',text:'Otra frase',source_language:'es',target_language:'ru',final:false},false);
  `);
  await h.element('watchPip').onclick();
  const doc = h.pipWindow.document;
  assert.deepEqual(JSON.parse(JSON.stringify(h.pipRequests)), [{width:480,height:220}]);
  assert.equal(doc.head.children.length, 1);
  assert.equal(doc.head.children[0].rel, 'stylesheet');
  assert.equal(doc.head.children[0].href, 'http://127.0.0.1:4317/style.css');
  assert.equal(doc.documentElement.attributes['data-theme'], 'dark');
  assert.equal(doc.documentElement.attributes['data-palette'], 'sage');
  const list = doc.body.children[0];
  assert.deepEqual(list.children.map(row => row.attributes['data-caption-id']), ['pip-2','pip-3','pip-4','pip-draft']);
  const first = list.children[0];
  const word = first.children[0].children[0].children[0];
  word.onclick();
  assert.equal(first.children.at(-1).className, 'pip-word');
  assert.equal(first.children.at(-1).textContent, 'одна');
  await h.settle();
  assert.equal(h.run('window.lookups[0].caption_id'), 'pip-2');
  assert.equal(h.run('wordPeek'), null);
  word.onclick();
  assert.equal(first.children.some(node => node.className === 'pip-word'), false);
  word.onclick();
  h.pipListeners.get('keydown')({key:'Escape'});
  assert.equal(first.children.some(node => node.className === 'pip-word'), false);
  h.run(`messages.get('pip-4').translation = 'Новый перевод'; renderConversation()`);
  assert.match(list.textContent, /Новый перевод/);
  h.element('translationLayout').value = 'words';
  h.run('renderConversation()');
  assert.equal(list.children[0].children[0].children[0].children[1].hidden, false);
  h.pipListeners.get('pagehide')();
  assert.equal(h.run('running'), true);
  await h.feed(15);
  assert.ok(h.transcriptions.length > 0);
  h.run('stop()');
});

test('microphone and display encode identical PCM through the same worklet path', async () => {
  const fixture = displayFixture();
  let microphoneOptions;
  const microphone = await harness({getUserMedia:async options => {
    microphoneOptions = options;
    return {getTracks:() => [{stop(){}}],getAudioTracks:() => [{}]};
  }});
  const display = await harness({getDisplayMedia:fixture.getDisplayMedia});
  await microphone.run('start()');
  await display.run("start({source:'display'})");
  await microphone.feed(15);
  await display.feed(15);
  assert.deepEqual(Buffer.from(display.transcriptions[0].audio), Buffer.from(microphone.transcriptions[0].audio));
  assert.deepEqual(JSON.parse(JSON.stringify(microphoneOptions)), {
    audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false
  });
  microphone.run('stop()');
  display.run('stop()');
});

test('display capture starts when the browser rejects audio constraints', async () => {
  const fixture = displayFixture();
  fixture.audioTrack.applyConstraints = async () => {
    throw Object.assign(new Error('Invalid state'), { name: 'InvalidStateError' });
  };
  const h = await harness({getDisplayMedia:fixture.getDisplayMedia});
  await h.run("start({source:'display'})");
  assert.equal(h.run('running'), true);
  assert.equal(h.run('state.watchError'), '');
  h.run('stop()');
});

test('ending a selected display track during initialization cannot restart capture', async () => {
  const fixture = displayFixture();
  let releaseConstraints;
  fixture.audioTrack.applyConstraints = () => new Promise(resolve => { releaseConstraints = resolve; });
  const h = await harness({getDisplayMedia:fixture.getDisplayMedia});
  const starting = h.run("start({source:'display'})");
  await h.settle();
  fixture.audioTrack.readyState = 'ended';
  fixture.audioTrack.onended();
  releaseConstraints();
  await starting;
  assert.equal(h.run('running'), false);
  assert.equal(h.run('starting'), false);
  assert.equal(h.run('stream'), null);
  assert.equal(h.transcriptions.length, 0);
  assert.ok(fixture.audioTrack.stops > 0);
});

test('stopping while the previous session is being closed cancels the next source', async () => {
  const fixture = displayFixture();
  let releaseEnding;
  const h = await harness({getDisplayMedia:fixture.getDisplayMedia,sessions:true,sessionResponder:request => {
    if (request.method === 'PATCH')
      return new Promise(resolve => { releaseEnding = () => resolve({ok:true,json:async () => ({ok:true})}); });
  }});
  await h.run('start()');
  await h.feed(15);
  await h.feed(13, 0);
  const starting = h.run("start({source:'display'})");
  await h.settle();
  assert.equal(typeof releaseEnding, 'function');
  h.run('stop()');
  releaseEnding();
  await starting;
  assert.equal(h.run('running'), false);
  assert.equal(h.run('starting'), false);
  assert.equal(fixture.audioTrack.readyState, 'ended');
});

test('a restored active watch session continues in its own section and keeps its storage kind', async () => {
  const fixture = libraryFixture();
  fixture.session.kind = 'watch';
  fixture.session.ended_at = null;
  const display = displayFixture();
  const h = await harness({sessions:true,getDisplayMedia:display.getDisplayMedia,sessionResponder:fixture.respond,
    activeSession:{session:fixture.session,turns:fixture.turns}});
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  h.element('libraryContinue').onclick();
  assert.equal(h.run('panel'), 'watch');
  assert.match(h.element('messageList').textContent, /Una.*mesa/);
  await h.element('watchChoose').onclick();
  assert.equal(h.run('sessionKind'), 'watch');
  assert.equal(h.run('sessionId'), fixture.session.id);
  assert.equal(h.sessionRequests.some(request => request.method === 'PATCH' || request.method === 'POST'), false);
  h.run('stop()');
});

test('word lookup events exclude saved library turns even while live capture runs', async () => {
  const fixture = libraryFixture();
  const h = await harness({sessions:true,sessionResponder:fixture.respond});
  await h.run('start()');
  h.run("window.lookups = []; moduleBus.subscribe('lookup', record => window.lookups.push(record))");
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  h.element('libraryMessages').children[0].children[0].children[0].children[0].onclick();
  await h.settle();
  assert.equal(h.run('window.lookups.length'), 0);
  h.run('stop()');
});

test('watch module is served explicitly and PiP uses linked application styles', async () => {
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const watch = await readFile(new URL('../public/watch.js', import.meta.url), 'utf8');
  assert.match(server, /'\/watch\.js': \['watch\.js', 'text\/javascript'\]/);
  assert.doesNotMatch(watch, /createElement\(['"]style['"]\)|\.style\b|setAttribute\(['"]style['"]/);
  assert.match(watch, /querySelectorAll\('link\[rel="stylesheet"\]'\)/);
});

test('word clicks in phrase layout explain how to obtain missing meanings in both windows', async () => {
  const fixture = displayFixture();
  const h = await harness({getDisplayMedia:fixture.getDisplayMedia,pip:true});
  h.element('watchTab').onclick();
  await h.element('watchChoose').onclick();
  h.run(`show({id:'missing-meaning',text:'Una mesa.',translation:'Стол.',translated_text:'Una mesa.',
    source_language:'es',target_language:'ru',final:true,translation_status:'ready'})`);
  h.element('messageList').children[0].children[0].children[0].children[0].onclick();
  assert.equal(h.element('wordMeaning').textContent, 'Чтобы получить значение, выберите «Под словами».');
  await h.element('watchPip').onclick();
  const row = h.pipWindow.document.body.children[0].children[0];
  row.children[0].children[0].children[0].onclick();
  assert.equal(row.children.at(-1).textContent, 'Чтобы получить значение, выберите «Под словами».');
  h.run('stop()');
});

test('unsupported browsers explain why an active watch cannot be continued from the library', async () => {
  const fixture = libraryFixture();
  fixture.session.kind = 'watch';
  fixture.session.ended_at = null;
  const h = await harness({sessions:true,sessionResponder:fixture.respond,
    activeSession:{session:fixture.session,turns:fixture.turns}});
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  assert.equal(h.element('libraryContinue').disabled, true);
  assert.equal(h.element('libraryContinue').title, 'Звук вкладки работает в Chrome и Edge на компьютере');
  assert.match(h.element('libraryMessages').textContent, /Una.*mesa/);
});

async function cardClientHarness({ initialCards = [], ...options } = {}) {
  const h = await harness({ ...options, configOverride: { features: { sessions: true, cards: true } } });
  h.run(`
    window.cardRequests = [];
    window.testCards = ${JSON.stringify(initialCards)};
    window.cardFailure = false;
    window.baseFetch = fetch;
    fetch = async (path, options = {}) => {
      if (!path.startsWith('/api/cards'))
        return window.baseFetch(path, options);
      const input = options.body ? JSON.parse(options.body) : undefined;
      window.cardRequests.push({path, method:options.method, headers:options.headers, input});
      if (window.cardFailure)
        return {ok:false};
      const labels = {again:'10 мин',hard:'1 д',good:'1 д',easy:'1 д'};
      let result;
      if (options.method === 'GET') {
        const due = window.testCards.filter(card => Date.parse(card.due_at) <= Date.now());
        const next = window.testCards.filter(card => Date.parse(card.due_at) > Date.now()).map(card => card.due_at).sort()[0];
        result = {cards:path.includes('due=1') ? due : window.testCards,
          stats:{total:window.testCards.length,due:due.length,next_due_at:next || null}};
      } else if (path.endsWith('/review')) {
        const card = window.testCards.find(card => path.includes(card.id));
        card.due_at = new Date(Date.now() + 86400000).toISOString();
        result = card;
      } else if (options.method === 'POST') {
        result = window.testCards.find(card => card.source.toLowerCase() === input.source.toLowerCase());
        if (!result) {
          result = {...input,id:'card-'+window.testCards.length,due_at:'2020-01-01T00:00:00.000Z',review_labels:labels};
          window.testCards.push(result);
        }
      } else if (options.method === 'PATCH') {
        result = window.testCards.find(card => path.endsWith(card.id));
        Object.assign(result, input);
      } else if (options.method === 'DELETE') {
        window.testCards = window.testCards.filter(card => !path.endsWith(card.id));
        result = {ok:true};
      }
      return {ok:true,json:async () => structuredClone(result)};
    };
  `);
  return h;
}

const clientCard = (id = 'card-1') => ({
  id, source: 'mesa', meaning: 'стол', source_language: 'es', target_language: 'ru',
  example: 'Una mesa.', example_translation: 'Стол.', due_at: '2020-01-01T00:00:00.000Z',
  review_labels: { again: '10 мин', hard: '1 д', good: '1 д', easy: '1 д' }
});

test('В карточки sends the selected expression, full example, translation and source IDs with a token', async () => {
  const h = await cardClientHarness();
  h.run(`
    sessionId = 'current-session';
    show({id:'card-turn',text:'Una mesa.',translation:'Стол.',source_language:'es',target_language:'ru',
      final:true,gloss_status:'ready',glosses:[{index:1,source:'mesa.',meaning:'стол'}]});
    peekWord(messages.get('card-turn'),1);
  `);
  assert.equal(h.element('wordAddCard').hidden, false);
  await h.element('wordAddCard').onclick();
  const request = JSON.parse(h.run('JSON.stringify(window.cardRequests[0])'));
  assert.equal(request.path, '/api/cards');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['X-Session-Token'], 'test');
  assert.deepEqual(request.input, {
    source: 'mesa', meaning: 'стол', source_language: 'es', target_language: 'ru',
    example: 'Una mesa.', example_translation: 'Стол.', session_id: 'current-session', turn_id: 'card-turn'
  });
  assert.equal(h.element('wordAddCard').textContent, 'В карточках');
  assert.equal(h.element('wordAddCard').disabled, true);
  await h.element('wordAddCard').onclick();
  assert.equal(h.run('window.cardRequests.length'), 1);
});

test('saved library cards keep the saved session identity instead of the active conversation identity', async () => {
  const fixture = libraryFixture();
  const h = await cardClientHarness({ sessionResponder: fixture.respond });
  h.run("sessionId = 'another-active-session'");
  await h.element('historyTab').onclick();
  await h.run(`openSavedConversation('${fixture.session.id}')`);
  h.element('libraryMessages').children[0].children[0].children[0].children[0].onclick();
  await h.element('wordAddCard').onclick();
  assert.equal(h.run('window.cardRequests[0].input.session_id'), fixture.session.id);
  assert.equal(h.run('window.cardRequests[0].input.turn_id'), fixture.turns[0].id);
  assert.equal(h.run('window.cardRequests[0].input.example'), fixture.turns[0].text);
});

test('card creation errors allow retry and unsupported storage hides both card entry points', async () => {
  const h = await cardClientHarness();
  h.run(`
    const record = {id:'word-error',text:'Una mesa.',source_language:'es',target_language:'ru',translation:'Стол.',
      glosses:[{index:0,source:'Una',meaning:'одна'}],gloss_status:'ready'};
    peekWord(record,0,null,true);
    window.cardFailure = true;
  `);
  await h.element('wordAddCard').onclick();
  assert.match(h.element('wordCardError').textContent, /Не удалось/);
  assert.equal(h.element('wordAddCard').disabled, false);
  h.run('window.cardFailure = false');
  await h.element('wordAddCard').onclick();
  assert.equal(h.element('wordAddCard').textContent, 'В карточках');
  const unsupported = await harness();
  assert.equal(unsupported.element('wordAddCard').hidden, true);
  assert.equal(unsupported.element('cardsTab').hidden, true);
  await unsupported.element('cardsTab').onclick();
  assert.equal(unsupported.run('panel'), 'reader');
});

test('review reveals the complete answer and posts each grade, then shows the next due date', async () => {
  const h = await cardClientHarness({ initialCards: ['one', 'two', 'three', 'four'].map(clientCard) });
  await h.element('cardsTab').onclick();
  assert.equal(h.element('cardsDue').textContent, 'На сегодня: 4');
  assert.equal(h.element('captureBar').hidden, true);
  assert.equal(h.element('cardsTab').attributes['aria-pressed'], 'true');
  await h.element('cardsStart').onclick();
  assert.equal(h.element('cardAnswer').hidden, true);
  assert.equal(h.element('cardGrades').hidden, true);
  assert.equal(h.element('cardSource').textContent, 'mesa');
  assert.equal(h.element('cardExample').children[1].textContent, 'mesa');
  await h.element('cardGrade3').onclick();
  assert.equal(h.run("window.cardRequests.filter(request => request.path.endsWith('/review')).length"), 0);
  for (const index of [1, 2, 3, 4]) {
    h.element('cardFace').onclick();
    assert.equal(h.element('cardMeaning').textContent, 'стол');
    assert.equal(h.element('cardExampleTranslation').textContent, 'Стол.');
    assert.equal(h.element('cardAnswer').hidden, false);
    assert.match(h.element('cardGrade1').textContent, /10 мин/);
    await h.element(`cardGrade${index}`).onclick();
  }
  const reviews = JSON.parse(h.run("JSON.stringify(window.cardRequests.filter(request => request.path.endsWith('/review')))"));
  assert.deepEqual(reviews.map(request => request.input.grade), ['again', 'hard', 'good', 'easy']);
  assert.ok(reviews.every(request => request.method === 'POST' && request.headers['X-Session-Token'] === 'test'));
  assert.equal(h.element('cardsFinished').hidden, false);
  assert.match(h.element('cardsNext').textContent, /Следующее повторение/);
  assert.equal(h.element('cardsStart').hidden, true);
});

test('review keyboard shortcuts reveal with space and save grades with 1–4 only inside review', async () => {
  const h = await cardClientHarness({ initialCards: [clientCard()] });
  await h.element('cardsTab').onclick();
  await h.element('cardsStart').onclick();
  const keydown = h.windowListeners.get('keydown');
  keydown({ key: '3', preventDefault() {} });
  assert.equal(h.run("window.cardRequests.filter(request => request.path.endsWith('/review')).length"), 0);
  keydown({ key: ' ', preventDefault() {} });
  assert.equal(h.element('cardAnswer').hidden, false);
  keydown({ key: '4', preventDefault() {} });
  await h.settle();
  assert.equal(h.run('window.cardRequests.find(request => request.path.endsWith("/review")).input.grade'), 'easy');
  h.element('conversationTab').onclick();
  keydown({ key: '1', preventDefault() {} });
  assert.equal(h.run("window.cardRequests.filter(request => request.path.endsWith('/review')).length"), 1);
});

test('card list edits and deletes records, keeps full text and handles empty and failed states', async () => {
  const h = await cardClientHarness({ initialCards: [clientCard()] });
  await h.element('cardsTab').onclick();
  let row = h.element('cardsList').children[0];
  row.children[3].children[0].onclick();
  const form = row.children[0];
  form.children[0].children[0].value = 'mesa nueva';
  form.children[1].children[0].value = 'новый стол';
  await form.onsubmit({ preventDefault() {} });
  assert.equal(h.run("window.cardRequests.find(request => request.method === 'PATCH').input.source"), 'mesa nueva');
  row = h.element('cardsList').children[0];
  assert.match(row.textContent, /mesa nuevaновый стол/);
  await row.children[3].children[1].onclick();
  assert.equal(h.element('cardsEmpty').hidden, false);
  h.run('window.cardFailure = true');
  await h.run('openCards()');
  assert.match(h.element('cardsError').textContent, /Не удалось/);
  h.run('window.cardFailure = false');
  await h.element('cardsRetry').onclick();
  assert.equal(h.element('cardsError').textContent, '');
});

test('a failed review preserves its answer for retry and concurrent grade clicks send only one request', async () => {
  const h = await cardClientHarness({ initialCards: [clientCard()] });
  await h.element('cardsTab').onclick();
  await h.element('cardsStart').onclick();
  h.element('cardReveal').onclick();
  h.run('window.cardFailure = true');
  await h.element('cardGrade3').onclick();
  assert.equal(h.element('cardAnswer').hidden, false);
  assert.equal(h.element('cardGrade3').disabled, false);
  assert.match(h.element('cardsError').textContent, /Не удалось сохранить оценку/);
  h.run(`
    window.cardFailure = false;
    window.reviewFetch = fetch;
    fetch = async (path, options) => {
      if (path.endsWith('/review'))
        await new Promise(resolve => { window.finishReview = resolve; });
      return window.reviewFetch(path, options);
    };
  `);
  const first = h.element('cardGrade3').onclick();
  const second = h.element('cardGrade4').onclick();
  assert.equal(h.element('cardGrade3').disabled, true);
  h.run('window.finishReview()');
  await Promise.all([first, second]);
  const reviews = JSON.parse(h.run("JSON.stringify(window.cardRequests.filter(request => request.path.endsWith('/review')))"));
  assert.deepEqual(reviews.map(request => request.input.grade), ['good', 'good']);
  assert.equal(h.element('cardsFinished').hidden, false);
});

test('leaving cards during a review request ignores its late response without reopening the section', async () => {
  const h = await cardClientHarness({ initialCards: [clientCard()] });
  await h.element('cardsTab').onclick();
  await h.element('cardsStart').onclick();
  h.element('cardReveal').onclick();
  h.run(`
    window.reviewFetch = fetch;
    fetch = async (path, options) => {
      if (path.endsWith('/review'))
        await new Promise(resolve => { window.finishReview = resolve; });
      return window.reviewFetch(path, options);
    };
  `);
  const pending = h.element('cardGrade2').onclick();
  h.element('conversationTab').onclick();
  h.run('window.finishReview()');
  await pending;
  assert.equal(h.run('panel'), 'reader');
  assert.equal(h.element('cardsPanel').hidden, true);
  assert.equal(h.element('readerPanel').hidden, false);
  await h.element('cardsTab').onclick();
  assert.equal(h.element('cardsFinished').hidden, false);
});
