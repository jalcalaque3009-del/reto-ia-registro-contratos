import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { leer_buzon, extraer, validar, registrar, alertas } from './contratos.js';

test('procesa los seis casos, conserva el maestro original y exige revisión', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-contratos-')); const ctx={directory,sessionId:'test'};
 const execute=async(t:{execute:(a:unknown,c:typeof ctx)=>Promise<string>},a:unknown)=>JSON.parse(await t.execute(a,ctx)) as {ok:boolean;data?:Record<string,unknown>;error?:string};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  const original=await readFile(path.join(directory,'fixtures/reto-02/maestro-contratos.csv'),'utf8');
  const inbox=await execute(leer_buzon,{}); assert.equal(inbox.ok,true); assert.equal((inbox.data?.mensajes as unknown[]).length,6);
  const expected:Record<string,string>={'msg-001':'nuevo','msg-002':'nuevo','msg-003':'actualizacion','msg-004':'duplicado','msg-006':'nuevo'};
  for(const [id,classification] of Object.entries(expected)) {
   const e=await execute(extraer,{mensaje_id:id});assert.equal(e.ok,true,id); const v=await execute(validar,{mensaje_id:id,contrato:e.data}); assert.equal(v.data?.clasificacion,classification,id);
   const write=await execute(registrar,{mensaje_id:id,contrato:e.data});
   if(id==='msg-006'){assert.equal(write.ok,false);assert.match(write.error??'',/revisión/);const bypass=await execute(registrar,{mensaje_id:id,contrato:e.data,confirmado:true});assert.equal(bypass.ok,false);assert.match(bypass.error??'',/fechas/);} else assert.equal(write.ok,true,id);
  }
  const report=await execute(alertas,{hoy:'2026-09-03'});assert.equal(report.ok,true);assert.ok((report.data?.vencen as unknown[]).length>0);assert.equal((await execute(alertas,{hoy:'2026-02-31'})).ok,false);
  assert.equal(await readFile(path.join(directory,'fixtures/reto-02/maestro-contratos.csv'),'utf8'),original);
  const csv=await readFile(path.join(directory,'out/sharepoint/maestro-contratos.csv'),'utf8');assert.match(csv,/CT-2026-011.*520000.*2027-11-01/);assert.equal(csv.split('\n').filter(line=>line.startsWith('CT-2026-012,')).length,1);assert.doesNotMatch(csv,/CM-2026-03/);
 } finally {await rm(directory,{recursive:true,force:true});}
});
