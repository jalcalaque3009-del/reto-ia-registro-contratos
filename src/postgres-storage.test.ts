import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { outputDirectory } from './paths.js';
import { configuredPostgresUrl, withPostgresSnapshot, type SnapshotClient } from './postgres-storage.js';

class FakeDatabase {
 files: Record<string,string> = {};
 tail: Promise<void> = Promise.resolve();
 client(): SnapshotClient {
  let unlock: (() => void) | undefined; let staged: Record<string,string> | undefined;
  return {
   query: async (sql, parameters) => {
    if (sql.includes('pg_advisory_xact_lock')) {
     const previous = this.tail; let release!: () => void;
     const gate = new Promise<void>(resolve => { release = resolve; });
     this.tail = previous.then(() => gate); await previous; unlock = release;
    } else if (sql.startsWith('SELECT files')) return {rows:[{files:structuredClone(this.files)}]};
    else if (sql.startsWith('INSERT INTO contratos_snapshot')) staged=JSON.parse(String(parameters?.[0])) as Record<string,string>;
    else if (sql==='COMMIT') { if (staged) this.files=staged; unlock?.(); unlock=undefined; }
    else if (sql==='ROLLBACK') { unlock?.(); unlock=undefined; }
    return {rows:[]};
   },
   release: () => { unlock?.(); unlock=undefined; },
  };
 }
}

test('Postgres connection accepts either documented environment variable name', () => {
 assert.equal(configuredPostgresUrl({POSTGRES_URL:'postgres-test'}),'postgres-test');
 assert.equal(configuredPostgresUrl({DATABASE_URL:'database-test'}),'database-test');
 assert.equal(configuredPostgresUrl({POSTGRES_URL:'postgres-test',DATABASE_URL:'database-test'}),'postgres-test');
 assert.throws(()=>configuredPostgresUrl({}),/POSTGRES_URL o DATABASE_URL/);
});

test('the snapshot persists complete files and rolls back a failed tool result', async () => {
 const db=new FakeDatabase();
 await withPostgresSnapshot(async()=>{
  const root=outputDirectory('unused'); await fs.mkdir(path.join(root,'sharepoint'),{recursive:true});
  await fs.writeFile(path.join(root,'sharepoint','maestro.csv'),'original');
  return JSON.stringify({ok:true});
 },db.client());
 const failure=await withPostgresSnapshot(async()=>{
  const file=path.join(outputDirectory('unused'),'sharepoint','maestro.csv');
  assert.equal(await fs.readFile(file,'utf8'),'original');await fs.writeFile(file,'partial');
  await fs.writeFile(path.join(outputDirectory('unused'),'log.jsonl'),JSON.stringify({herramienta:'contratos_registrar',mensaje_id:'msg-006',resumen:'private-error-text'})+'\n');
  return JSON.stringify({ok:false,error:'simulated failure'});
 },db.client());
 assert.match(failure,/simulated failure/);
 await withPostgresSnapshot(async()=>JSON.stringify({ok:false,error:'another failure'}),db.client());
 await withPostgresSnapshot(async()=>{
  assert.equal(await fs.readFile(path.join(outputDirectory('unused'),'sharepoint','maestro.csv'),'utf8'),'original');
  const audit=await fs.readFile(path.join(outputDirectory('unused'),'log.jsonl'),'utf8');
  assert.match(audit,/contratos_registrar/);assert.match(audit,/msg-006/);assert.doesNotMatch(audit,/private-error-text|simulated failure/);
  const lines=audit.trim().split('\n').map(line=>JSON.parse(line) as {herramienta:string;mensaje_id:string});
  assert.equal(lines.at(-1)?.herramienta,'operacion');assert.equal(lines.at(-1)?.mensaje_id,'');
  return JSON.stringify({ok:true});
 },db.client());
});

test('failed-operation audit respects the total snapshot size limit', async () => {
 const db=new FakeDatabase();db.files={'large.bin':Buffer.alloc(16*1024*1024).toString('base64')};
 const result=await withPostgresSnapshot(async()=>JSON.stringify({ok:false}),db.client());
 assert.equal(result,JSON.stringify({ok:false}));assert.deepEqual(Object.keys(db.files),['large.bin']);
});

test('concurrent snapshot transactions retain both updates in isolated directories', async () => {
 const db=new FakeDatabase(); const directories:string[]=[];
 await Promise.all(['uno','dos'].map(name=>withPostgresSnapshot(async()=>{
  const root=outputDirectory('unused');directories.push(root);
  await new Promise(resolve=>setTimeout(resolve,10));
  await fs.writeFile(path.join(root,`${name}.txt`),name);
  return JSON.stringify({ok:true});
 },db.client())));
 assert.notEqual(directories[0],directories[1]);
 assert.deepEqual(Object.keys(db.files).sort(),['dos.txt','uno.txt']);
});

test('untrusted snapshot paths cannot escape the temporary directory', async () => {
 const db=new FakeDatabase();db.files={'../escape.txt':Buffer.from('x').toString('base64')};
 await assert.rejects(withPostgresSnapshot(async()=>{throw new Error('must not run');},db.client()),/Datos persistidos inválidos/);
 assert.ok(Object.hasOwn(db.files,'../escape.txt'));
});
