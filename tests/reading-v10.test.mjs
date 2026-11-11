import test from 'node:test';
import assert from 'node:assert/strict';
import {splitFinalCaption,draftTail} from '../public/reading.js';
import {LiveBuffer} from '../public/live.js';
test('settled turns split at sentence boundaries and preserve exact spans, provenance and speaker',()=>{
 const text='Quiero reservar una mesa para dos personas. Después iremos a caminar por el centro de la ciudad y compraremos pan fresco para mañana por la mañana.';
 const event={id:'caption',text,revision:5,final:true,speaker_id:'self',translation:'stale',glosses:[{index:0,meaning:'old'}]};
 const chunks=splitFinalCaption(event);
 assert.equal(chunks.length,2);
 assert.equal(chunks[1].text,'Después iremos a caminar por el centro de la ciudad y compraremos pan fresco para mañana por la mañana.');
 assert.equal(chunks.map(c=>c.text).join(' '),text);assert.equal(new Set(chunks.map(c=>c.id)).size,chunks.length);
 assert.ok(chunks.every(c=>c.speaker_id==='self' && c.translation===null && c.glosses.length===0 && text.slice(c.source_record.start,c.source_record.end)===c.text));
 assert.equal(event.translation,'stale','source record was not mutated');
 assert.equal(splitFinalCaption({...event,final:false}).length,1);
});
test('unusually long unpunctuated text is still bounded without losing words',()=>{
 const text='mañana iremos al centro '.repeat(30).trim();
 const chunks=splitFinalCaption({id:'long',text,final:true});
 assert.ok(chunks.length>1);
 assert.ok(chunks.every(chunk=>chunk.text.length<=300));
 assert.equal(chunks.map(chunk=>chunk.text).join(' '),text);
});
test('live preview is bounded while final audio snapshots preserve the full segment',()=>{
 assert.equal(draftTail('one two three four five',3),'… three four five');
 const b=new LiveBuffer(16000,1.5,.012,8,1.2);let final;
 for(let i=0;i<80;i++){const result=b.push(new Float32Array(1600).fill(.1));if(result.update?.final)final=result.update;}
 assert.equal(final.end_reason,'limit');assert.equal(final.audio.length,8*16000);
});
