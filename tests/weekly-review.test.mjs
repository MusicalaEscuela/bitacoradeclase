import assert from 'node:assert/strict';
import { getWeeklyReview } from '../js/utils/weekly-review.js';
const goals = Array.from({length:8},(_,i)=>({id:`g${i}`,title:`Logro ${i}`,component:'tecnica'}));
const input = {studentId:'estudiante-1',routeKey:'violin',goals,completedGoalIds:goals.slice(0,6).map(g=>g.id)};
const snapshot=structuredClone(input);
const records=new Map();
const storage={getItem:key=>records.get(key),setItem:(key,value)=>records.set(key,value)};
const now=new Date('2026-10-18T18:00:00Z');
const pick=(data=input,options={})=>getWeeklyReview(data,{now,storage,...options});
assert.equal(pick().week,'2026-10-12');
assert.ok(input.completedGoalIds.includes(pick().goal.id));
assert.equal(pick().goal.id,pick().goal.id);
assert.equal(pick({...input,goals:[...goals].reverse()}).goal.id,pick().goal.id);
const saved=pick().goal.id;
assert.equal(pick({...input,completedGoalIds:goals.map(g=>g.id)}).goal.id,saved,'new achievements do not replace the weekly selection');
assert.notEqual(pick({...input,completedGoalIds:input.completedGoalIds.filter(id=>id!==saved)}).goal.id,saved,'undone goals are excluded');
assert.equal(pick({...input,completedGoalIds:[]}),null);
assert.equal(pick({...input,studentId:''}),null);
assert.equal(pick({...input,routeKey:''}),null);
assert.equal(pick({...input,completedGoalIds:['missing']}),null);
const students=new Set(Array.from({length:30},(_,i)=>pick({...input,studentId:`estudiante-${i}`},{storage:null}).goal.id));
assert.ok(students.size>1,'student identities vary the selection');
for(let i=0;i<25;i++) {
 const current=pick(input,{storage:null,now:new Date(now.getTime()+i*604800000)});
 const next=pick(input,{storage:null,now:new Date(now.getTime()+(i+1)*604800000)});
 assert.notEqual(current.goal.id,next.goal.id,'consecutive weeks do not repeat with a stable pool');
}
assert.equal(pick(input,{now:new Date('2026-10-19T04:59:59Z')}).week,'2026-10-12');
assert.equal(pick(input,{now:new Date('2026-10-19T05:00:00Z')}).week,'2026-10-19');
assert.equal(pick({...input,completedGoalIds:['g1']}).goal.id,'g1');
assert.ok(pick(input,{storage:{getItem(){throw Error('disabled');},setItem(){throw Error('full');}}}));
assert.deepEqual(input,snapshot,'review does not mutate goals or progress');
const mixed = {studentId:'mixed',routeKey:'violin',goals:[
  {id:'rep',title:'Melodías',component:'repertorio'},
  {id:'obra',title:'Canción',component:'obras'},
  {id:'tech',title:'Postura',component:'Técnico'},
  {id:'theory',title:'Lectura',component:'Teórico'},
],completedGoalIds:['rep','obra','tech','theory']};
const cachedRepertoire={getItem:()=> 'rep',setItem:()=>{}};
assert.ok(['tech','theory'].includes(pick(mixed,{storage:cachedRepertoire}).goal.id),'replace cached repertoire review immediately');
assert.equal(pick({...mixed,completedGoalIds:['rep','obra']},{storage:null}),null);
assert.equal(pick({...mixed,completedGoalIds:['theory']},{storage:null}).goal.id,'theory');
console.log('weekly-review: all assertions passed');
