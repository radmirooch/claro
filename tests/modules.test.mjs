import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultParticipants,readParticipants,assignSpeaker} from '../public/participants.js';
import {MODULES,createModuleBus} from '../public/modules.js';
import {sourceUnits,validateInterlinear,parseMeaningPrefix} from '../public/annotations.js';
test('full interlinear output covers repeated words and punctuation by position; missing units fail',()=>{
 const text='La mesa y la silla. 😃';const units=sourceUnits(text);
 const result=validateInterlinear(text,units.map(u=>({index:u.index,meaning:'перевод'})),true);
 assert.equal(result.length,6);assert.ok(result.every(u=>text.slice(u.start,u.end)===u.source));
 assert.throws(()=>validateInterlinear(text,result.slice(1),true),/не все/);
 assert.throws(()=>validateInterlinear(text,[...result.slice(1),result[1]],true),/не все/);
 assert.deepEqual(parseMeaningPrefix('{"meanings":["стол", "кафе \\"в центре\\"", "не законч'),['стол','кафе "в центре"']);
});
test('speaker identity stays unknown until assigned; voice suggestions cannot replace a manual correction',()=>{
 const profiles=defaultParticipants(),event={speaker_id:null};
 assignSpeaker(event,'guest',profiles,'voice',.8);assert.equal(event.speaker_assignment.confirmed,false);
 assignSpeaker(event,'self',profiles);assert.equal(event.speaker_assignment.confirmed,true);
 assert.equal(assignSpeaker(event,'guest',profiles,'voice',.99),false);assert.equal(event.speaker_id,'self');
 assignSpeaker(event,null,profiles);assert.equal(assignSpeaker(event,'guest',profiles,'voice',.99),false);
 assert.throws(()=>assignSpeaker(event,'imaginary',profiles));
 const loaded=readParticipants([{id:'self',name:'Ирина',color:'pink'},{id:'self',name:'duplicate'}, {id:'other',name:'Второй',is_self:true,color:'injected'}]);
 assert.equal(loaded.length,2);assert.equal(loaded[1].is_self,false);assert.equal(loaded[1].color,'blue');
});
test('module handlers receive isolated snapshots and cannot block or mutate captions',async()=>{
 const errors=[],bus=createModuleBus(e=>errors.push(e.message)),event={text:'Original'},seen=[];
 const off=bus.subscribe('caption',copy=>{seen.push(copy.text);copy.text='changed';throw new Error('module failed');});
 bus.publish('caption',event);await new Promise(r=>setImmediate(r));
 assert.equal(event.text,'Original');assert.deepEqual(seen,['Original']);assert.deepEqual(errors,['module failed']);
 off();bus.publish('caption',event);await new Promise(r=>setImmediate(r));assert.equal(seen.length,1);
 assert.equal(MODULES.find(m=>m.id==='voice_identity').available,false);
});
