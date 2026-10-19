import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../js/views/profile.view.js',import.meta.url),'utf8');
function extract(name){const match=new RegExp(`(?:export )?async function ${name}\\(`).exec(source);assert.ok(match,name);const end=source.indexOf('\n}',match.index)+2;return source.slice(match.index,end).replace('export ','');}
const student={id:'ana'};let loads=[],loading=[];
const context=vm.createContext({
 clearAppError:()=>{},getState:()=>({auth:{user:{} }}),resolveUserAccess:()=>({}),
 resolveStudentRefFromPayload:()=> 'ana',getRequestedProcessFromPayload:()=>'',getSelectedStudentId:()=> 'ana',
 getStudentFromState:()=>student,canViewStudent:()=>true,getStudentIdentity:()=> 'ana',
 ensureStudentLoadedForProfile:async()=>student,resolveStudentProcess:()=>({processKey:'piano'}),
 currentProfileStudentKey:'ana',currentProfileProcessKey:'',showAllProfileHistoryProcesses:false,currentProfileHistorySearchQuery:'',
 ensureCatalogsLoaded:async()=>{},ensureStudentBitacorasLoaded:()=>{loads.push('history');return new Promise(()=>{})},
 ensureLearningRouteLoaded:()=>{loads.push('route');return new Promise(()=>{})},viewRoot:{querySelector:()=>null},
});
vm.runInContext(extract('beforeEnter')+'\n'+extract('afterEnter'),context);
const deadline=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('profile blocked by secondary load')),100);timer.unref();})]);
await deadline(context.beforeEnter({}));assert.deepEqual(loads,[]);
await deadline(context.afterEnter());assert.deepEqual(loads,['history','route']);
// The history finishes independently of a slow repertoire function.
Object.assign(context,{
 setBitacorasLoading:v=>loading.push(v),getStudentLinkedIds:()=>['ana'],
 getBitacorasByStudentIds:async()=>[{id:'b'}],normalizeBitacorasResponse:v=>v,setBitacorasForStudent:()=>{},
 syncAcademicRecordFromHistory:()=>{},canEditProfileFields:()=>true,getStudentAcademicRecordId:()=> 'ana',
 synchronizeBitacoraRepertoire:()=>new Promise(()=>{}),setAppError:message=>{throw Error(message)},console,
});
vm.runInContext(extract('ensureStudentBitacorasLoaded'),context);
await deadline(context.ensureStudentBitacorasLoaded(student));assert.deepEqual(loading,[true,false]);
console.log('PASS profile loading: router and history never wait for slow repertoire/route loads');
