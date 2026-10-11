import assert from 'node:assert/strict';
import {createDraftBackupStore, writeBackup, readBackup, clearBackup, readLegacyBackup, readOlderBackups, rememberLastDesign, readLastDesign, forgetLastDesign} from '../src/designer/draftBackup.ts';

const data=new Map(), last=new Map();
const storage=m=>({get length(){return m.size;},key:i=>[...m.keys()][i]??null,getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)});
globalThis.localStorage=storage(data);globalThis.sessionStorage=storage(last);
const a='models-v1:'+'a'.repeat(64),b='models-v1:'+'b'.repeat(64);
const design=name=>({schema:'fairbeam.design/1',model:{id:'same',name},params:[],materials:[],parts:[]});
writeBackup('same','same-hash',design('A'),a);writeBackup('same','same-hash',design('B'),b);
assert.equal(readBackup('same','same-hash',a).design.model.name,'A');
assert.equal(readBackup('same','same-hash',b).design.model.name,'B');
assert.equal(readBackup('same','different',a),null);assert.equal(data.size,2,'a stale read deletes no record');
clearBackup('same',a);assert.equal(readBackup('same','same-hash',a),null);
assert.equal(readBackup('same','same-hash',b).design.model.name,'B');
const legacy={at:Date.now(),base:'same-hash',design:design('Legacy')};
data.set('fairbeam:draft:same',JSON.stringify(legacy));last.set('fairbeam:lastDesign','legacy-id');
assert.deepEqual(readLegacyBackup('same'),legacy);
assert.equal(readBackup('same','same-hash',a),null,'matching legacy content does not prove workspace');
const before=[...data];
writeBackup('same','same-hash',design('unknown'));clearBackup('same');clearBackup('same','invalid');
assert.equal(readBackup('same','same-hash'),null);assert.deepEqual([...data],before);
rememberLastDesign('project-a',a);rememberLastDesign('project-b',b);forgetLastDesign(a);
assert.equal(readLastDesign(a),null);assert.equal(readLastDesign(b),'project-b');
assert.equal(readLastDesign(),null);forgetLastDesign();assert.equal(last.get('fairbeam:lastDesign'),'legacy-id');
writeBackup('same','new-base',design('B newer'),b);
assert.equal(readOlderBackups('same','new-base',b)[0].design.model.name,'B');
clearBackup('same',b,'new-base');
assert.equal(readBackup('same','same-hash',b).design.model.name,'B','clearing new base preserves stale recovery');
const kb=[...data.keys()].find(k=>k.startsWith(`fairbeam:draft:v3:${b}:same:same-hash:`)),valid=data.get(kb);
for(const mutation of [{scope:a},{id:'other'},{version:1},{at:NaN},{design:{}},{base:null}]) {
 data.set(kb,JSON.stringify({...JSON.parse(valid),...mutation}));assert.equal(readBackup('same','same-hash',b),null);
}
data.set(kb,'malformed');assert.equal(readBackup('same','same-hash',b),null);assert.equal(data.get(kb),'malformed');
data.set('fairbeam:draft:same','malformed');assert.equal(readLegacyBackup('same'),null);assert.equal(data.get('fairbeam:draft:same'),'malformed');
// Same-origin windows share storage but must never share recovery ownership.
data.clear();
const tabA=createDraftBackupStore('page-A'),tabB=createDraftBackupStore('page-B'),reloaded=createDraftBackupStore('page-C');
tabA.writeBackup('same','base',design('Window A'),a);
tabB.writeBackup('same','base',design('Window B'),a);
assert.equal(data.size,2);
assert.equal(tabA.readBackup('same','base',a).design.model.name,'Window A');
assert.equal(tabB.readBackup('same','base',a).design.model.name,'Window B');
assert.equal(tabA.readOlderBackups('same','base',a)[0].design.model.name,'Window B');
tabA.clearBackup('same',a,'base');
assert.equal(tabB.readBackup('same','base',a).design.model.name,'Window B','save/clean/discard A preserves B');
assert.equal(reloaded.readBackup('same','base',a),null,'reload/duplicate never auto-restores another page');
assert.equal(reloaded.readOlderBackups('same','base',a)[0].design.model.name,'Window B','reload still offers the prior draft');
reloaded.clearBackup('same',a);assert.equal(data.size,1,'a fresh clean window deletes no recovery');
tabA.writeBackup('same','new-base',design('New A'),a);
assert.equal(tabA.readOlderBackups('same','new-base',a)[0].design.model.name,'Window B','older-base foreign draft stays available');
const v2key=`fairbeam:draft:v2:${a}:same:base`;
data.set(v2key,JSON.stringify({version:2,scope:a,id:'same',at:1,base:'base',design:design('Previous release')}));
assert.equal(reloaded.readOlderBackups('same','base',a).find(x=>x.version===2).design.model.name,'Previous release');
assert.equal(reloaded.readBackup('same','base',a),null,'v2 is explicit recovery, not silently assigned');
tabA.clearBackup('same',a);tabB.clearBackup('same',a);
assert.equal(data.size,1);assert.ok(data.has(v2key),'old records are never purged by a new owner');
data.set(v2key+'%bad','malformed');
assert.equal(reloaded.readOlderBackups('same','base',a).length,1,'bad neighbors do not hide recovery');
// Ordinary HTTP may expose no Web Crypto at all. Importing the editor must still
// generate distinct page ownership; a development hot reload alone keeps it.
const ownerSlot=Symbol.for('fairbeam.draftBackup.pageOwner'),originalOwner=globalThis[ownerSlot];
const originalCrypto=Object.getOwnPropertyDescriptor(globalThis,'crypto');
try {
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:undefined});
 delete globalThis[ownerSlot];
 const httpA=await import('../src/designer/draftBackup.ts?http-page-a');
 httpA.writeBackup('http','base',design('HTTP A'),a);
 const ownerA=globalThis[ownerSlot];assert.ok(ownerA);
 const hmr=await import('../src/designer/draftBackup.ts?http-hmr');
 assert.equal(globalThis[ownerSlot],ownerA);assert.equal(hmr.readBackup('http','base',a).design.model.name,'HTTP A');
 delete globalThis[ownerSlot];
 const httpB=await import('../src/designer/draftBackup.ts?http-page-b');
 httpB.writeBackup('http','base',design('HTTP B'),a);
 assert.notEqual(globalThis[ownerSlot],ownerA);
 httpB.clearBackup('http',a);assert.equal(httpA.readBackup('http','base',a).design.model.name,'HTTP A');
} finally {
 if(originalCrypto)Object.defineProperty(globalThis,'crypto',originalCrypto);else delete globalThis.crypto;
 globalThis[ownerSlot]=originalOwner;
}
Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('blocked');}});
assert.doesNotThrow(()=>writeBackup('same','base',design('A'),a));assert.doesNotThrow(()=>clearBackup('same',a));
assert.equal(readBackup('same','base',a),null);assert.equal(readLegacyBackup('same'),null);
assert.deepEqual(reloaded.readOlderBackups('same','base',a),[]);
console.log('Page/workspace-scoped backup isolation, multiwindow save/clear, explicit reload recovery, legacy preservation, corruption and unavailable storage passed');
