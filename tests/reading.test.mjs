import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveBuffer,readingBlocks,hasSentenceEnding} from '../public/live.js';
const segment=(id,text,extra={})=>({id,text,source_language:'ru',target_language:'en',capture_session:'s',speaker_id:null,final:true,start_seconds:0,speech_end_seconds:1,end_reason:'pause',translation_status:'ready',translation:'Translation '+id,...extra});
test('a breathing pause retains the same ASR context, while a configurable longer pause closes it',()=>{
 const voice=new Float32Array(1600).fill(.05),silence=new Float32Array(1600),buffer=new LiveBuffer(16000,1,.012,12,1.2);
 let first;for(let i=0;i<10;i++)first=buffer.push(voice).update||first;
 for(let i=0;i<8;i++)assert.equal(buffer.push(silence).update,undefined);
 let continued;for(let i=0;i<5;i++)continued=buffer.push(voice).update||continued;
 assert.equal(continued.sequence,first.sequence);assert.ok(continued.audio.length>first.audio.length);
 let final;for(let i=0;i<12;i++)final=buffer.push(silence).update||final;
 assert.equal(final.final,true);assert.equal(final.end_reason,'pause');
 assert.equal(final.start_seconds,0);assert.ok(Math.abs(final.speech_end_seconds-2.3)<.001);
});
test('unfinished same-session speech joins one reading block without changing source segments',()=>{
 const a=segment('a','Я хотел бы',{translation:'I would like'}),b=segment('b','забронировать столик.',{start_seconds:2.5,speech_end_seconds:4,translation:'to book a table.'});
 const blocks=readingBlocks([a,b]);assert.equal(blocks.length,1);assert.equal(blocks[0].text,'Я хотел бы забронировать столик.');assert.equal(blocks[0].translation,'I would like to book a table.');
 assert.equal(blocks[0].parts[0],a);assert.equal(a.text,'Я хотел бы');assert.equal(b.text,'забронировать столик.');
 assert.equal(hasSentenceEnding('Я хотел бы.'),false);assert.equal(hasSentenceEnding('Это всё.'),true);
});
test('completed thoughts, long pauses, different speakers, languages and capture sessions remain separate',()=>{
 const a=segment('a','Я хотел бы'),b=segment('b','забронировать столик.',{start_seconds:2.5,speech_end_seconds:4});
 for(const change of [{capture_session:'other'},{speaker_id:'speaker_2'},{source_language:'es'},{target_language:'ru'},{start_seconds:6}])assert.equal(readingBlocks([a,{...b,...change}]).length,2);
 assert.equal(readingBlocks([{...a,text:'Я передумал.'},b]).length,2);
 assert.equal(readingBlocks([{...a,end_reason:'stop'},b]).length,2);
});
test('a failed translation in a joined block stays retryable and ambiguous repeated hints can be validated separately',()=>{
 const blocks=readingBlocks([segment('a','Я хотел бы'),segment('b','забронировать столик.',{start_seconds:2.5,speech_end_seconds:4,translation:null,translation_status:'overflow'})]);
 assert.equal(blocks.length,1);assert.equal(blocks[0].translation_status,'overflow');assert.match(blocks[0].translation,/…/);
});
