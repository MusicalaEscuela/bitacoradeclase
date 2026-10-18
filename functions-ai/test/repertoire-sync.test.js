'use strict';
const assert=require('node:assert/strict');
const {extractWorks,mergeRepertoire,teacherVisible,syncFromBitacoras}=require('../repertoire-sync');
const original={nombre:'Canción A',estado:'lograda',prioridad:'alta',notas:'Conservar',fechaInicio:'2026-01-01',fechaLogro:'2026-02-01'};
assert.deepEqual(extractWorks({content:'COMPONENTE DE OBRAS:\n\nCOMPONENTE TEORICO: Lectura'}),[]);
assert.deepEqual(extractWorks({content:'TAREAS / OBSERVACIONES: no es una canción\n\nCOMPONENTE DE OBRAS: Canción A, Cancion a; Obra B\n\nCOMPONENTE TEORICO: lectura'}),['Cancion a','Obra B']);
const group={content:'COMPONENTE DE OBRAS: Común',studentOverrides:{a:{enabled:true,componenteObras:['Solo A']},b:{enabled:true,componenteObras:['Solo B']}}};
assert.deepEqual(extractWorks(group,['a']),['Común','Solo A']);
assert.deepEqual(extractWorks(group,['b']),['Común','Solo B']);
const first=mergeRepertoire([{repertorioProceso:[original]}],[' CANCION A ','Obra B'],[],'2026-10-18');
assert.equal(first.items.length,2);assert.deepEqual(first.items[0],original);
assert.equal(first.items[1].estado,'proceso');assert.equal(first.items[1].fechaInicio,'2026-10-18');
const retry=mergeRepertoire([{repertorioProceso:first.items}],['Canción A','Obra B'],first.seen);
assert.equal(retry.items.length,2);
const renamed=mergeRepertoire([{repertorioProceso:[{...original,nombre:'Nombre corregido'},first.items[1]]}],['Canción A','Obra B'],first.seen);
assert.equal(renamed.items.length,2,'no resucitar títulos renombrados');
const removed=mergeRepertoire([{repertorioProceso:[]}],['Canción A','Obra B'],first.seen);
assert.equal(removed.items.length,0,'no resucitar canciones eliminadas');
const capped=mergeRepertoire([{repertorioProceso:Array.from({length:20},(_,i)=>({...original,nombre:'Obra '+i}))}],['Nueva']);
assert.equal(capped.items.length,20);assert.deepEqual(capped.pending,['Nueva']);
assert.equal(teacherVisible({rip:{showInTeacherLists:false},estado:'Activo'}),false);
assert.equal(teacherVisible({rip:{showInTeacherLists:true},estado:'Inactivo'}),true);
const records={
 'students/canonical':{nombre:'Ana',rip:{showInTeacherLists:true},repertorioProceso:[original]},
 'students/stu_ana':{canonicalStudentId:'canonical',identityLinkStatus:'confirmed',repertorioProceso:[original]},
 'students/b':{rip:{showInTeacherLists:true}},
 'student_identity_links/canonical':{canonicalStudentId:'canonical',status:'confirmed',academicRecordId:'stu_ana'},
 'bitacoras/log':{...group,studentIds:['stu_ana','b'],fechaClase:'2026-10-18',studentOverrides:{stu_ana:{enabled:true,componenteObras:['Solo A']},b:{enabled:true,componenteObras:['Solo B']}}},
};
let writes=0;
const snapshot=ref=>({exists:!!records[ref.path],data:()=>structuredClone(records[ref.path])});
const db={collection:name=>({doc:id=>({path:name+'/'+id,get:async()=>snapshot({path:name+'/'+id})})}),runTransaction:async fn=>{
 let wrote=false;const pending=[];
 const tx={get:async ref=>{assert.equal(wrote,false,'all reads before writes');return snapshot(ref)},update:(ref,data)=>{wrote=true;pending.push([ref,data])},set:(ref,data)=>{wrote=true;pending.push([ref,data])}};
 const result=await fn(tx);for(const [ref,data] of pending){records[ref.path]={...records[ref.path],...data};writes++;}return result;
}};
(async()=>{
 const options={bitacoraIds:['log'],isAdmin:true};
 let result=await syncFromBitacoras(db,{serverTimestamp:()=> 'server'},options);
 assert.ok(result.students.length>=2);
 assert.deepEqual(records['students/stu_ana'].repertorioProceso,records['students/canonical'].repertorioProceso);
 assert.ok(records['students/canonical'].repertoire.includes('Solo A'));
 assert.ok(!records['students/canonical'].repertoire.includes('Solo B'));
 assert.ok(records['students/b'].repertoire.includes('Solo B'));
 assert.ok(!records['students/b'].repertoire.includes('Solo A'));
 assert.equal(records['students/canonical'].repertorioProceso[0].estado,'lograda');
 assert.equal(records['students/canonical'].nombre,'Ana');
 const count=writes;await syncFromBitacoras(db,{serverTimestamp:()=> 'server'},options);
 assert.equal(writes,count,'repeated save/history load is idempotent');
 records['students/canonical'].repertorioProceso[1].nombre='Renombrada';
 records['students/canonical'].repertoire[1]='Renombrada';
 records['students/stu_ana']={...structuredClone(records['students/canonical']),canonicalStudentId:'canonical',identityLinkStatus:'confirmed'};
 await syncFromBitacoras(db,{serverTimestamp:()=> 'server'},{...options,studentId:'canonical'});
 assert.ok(!records['students/canonical'].repertoire.includes('Común'),'renamed source must not be re-added');
 records['students/canonical'].rip.showInTeacherLists=false;
 result=await syncFromBitacoras(db,{serverTimestamp:()=> 'server'},{...options,isAdmin:false,studentId:'canonical'});
 assert.ok(result.warnings.length);
 console.log('PASS repertoire synchronization: common/individual works, duplicates, mirrors, retries, renames, permissions and capacity');
})();
