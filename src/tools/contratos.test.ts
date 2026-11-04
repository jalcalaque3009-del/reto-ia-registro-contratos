import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { leer_buzon, extraer, validar, registrar, alertas } from './contratos.js';
import { parse } from 'csv-parse/sync';

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
  const afterCut=report.data?.registrados_desde_corte as {id_contrato:string}[];assert.ok(afterCut.some(row=>row.id_contrato==='CT-2026-015'));assert.ok(!afterCut.some(row=>row.id_contrato==='CT-2026-011'));
  assert.equal(await readFile(path.join(directory,'fixtures/reto-02/maestro-contratos.csv'),'utf8'),original);
  const csv=await readFile(path.join(directory,'out/sharepoint/maestro-contratos.csv'),'utf8');assert.match(csv,/CT-2026-011.*520000.*2027-11-01/);assert.equal(csv.split('\n').filter(line=>line.startsWith('CT-2026-012,')).length,1);assert.doesNotMatch(csv,/CM-2026-03/);
  const rows=parse(csv,{columns:true,skip_empty_lines:true}) as {id_contrato:string;fecha_registro:string;fuente:string}[];const amended=rows.find(row=>row.id_contrato==='CT-2026-011');assert.equal(amended?.fecha_registro,'2026-05-05');assert.equal(amended?.fuente,'buzon');
  const history=(await readFile(path.join(directory,'out/sharepoint/historial.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {mensaje_id:string;fecha_mensaje:string});const amendment=history.find(entry=>entry.mensaje_id==='msg-003');assert.equal(amendment?.fecha_mensaje,'2026-08-22T11:05:00-05:00');
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('rechaza fechas, moneda y país inválidos antes de escribir', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-contratos-')); const ctx={directory,sessionId:'test'};
 const run=async(t:{execute:(a:unknown,c:typeof ctx)=>Promise<string>},a:unknown)=>JSON.parse(await t.execute(a,ctx)) as {ok:boolean;data?:Record<string,{valor:unknown;confianza:number}>;error?:string};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  const extracted=await run(extraer,{mensaje_id:'msg-002'});assert.ok(extracted.data);
  for(const [key,value] of [['fecha_inicio','2026-02-31'],['fecha_fin','no-es-fecha'],['moneda','XYZ'],['pais','XX']] as const){
   const contract=structuredClone(extracted.data);contract[key]={valor:value,confianza:1};
   const validation=await run(validar,{mensaje_id:'msg-002',contrato:contract});assert.equal(validation.ok,false,key);assert.match(validation.error??'',/inválida|desconocid/i);
   const attempted=await run(registrar,{mensaje_id:'msg-002',contrato:contract,confirmado:true});assert.equal(attempted.ok,false,key);
  }
  const pathToText=path.join(directory,'fixtures/reto-02/buzon/msg-002/contrato.txt');const text=await readFile(pathToText,'utf8');
  await writeFile(pathToText,text.replace('catorce (14) de agosto de 2027','treinta y uno (31) de febrero de 2027'));
  const invalidExtract=await run(extraer,{mensaje_id:'msg-002'});assert.equal(invalidExtract.ok,false);assert.match(invalidExtract.error??'',/Fecha inválida/);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('conserva el ID y solicita revisión si la coincidencia por NIT y objeto tiene otro identificador', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-contratos-')); const ctx={directory,sessionId:'test'};
 const run=async(t:{execute:(a:unknown,c:typeof ctx)=>Promise<string>},a:unknown)=>JSON.parse(await t.execute(a,ctx)) as {ok:boolean;data?:Record<string,unknown>;error?:string};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  const extracted=await run(extraer,{mensaje_id:'msg-001'});assert.ok(extracted.data);
  assert.equal((await run(registrar,{mensaje_id:'msg-001',contrato:extracted.data})).ok,true);
  const changed=structuredClone(extracted.data) as Record<string,{valor:unknown;confianza:number}>;changed.id_contrato.valor='CT-2026-999';
  const validation=await run(validar,{mensaje_id:'msg-001',contrato:changed});assert.equal(validation.data?.clasificacion,'actualizacion');assert.equal(validation.data?.id_contrato_existente,'CT-2026-015');assert.ok((validation.data?.requiere_revision as string[]).includes('id_contrato'));
  const blocked=await run(registrar,{mensaje_id:'msg-001',contrato:changed});assert.equal(blocked.ok,false);
  const approved=await run(registrar,{mensaje_id:'msg-001',contrato:changed,confirmado:true});assert.equal(approved.ok,true);assert.equal(approved.data?.id_contrato,'CT-2026-015');
  const csv=await readFile(path.join(directory,'out/sharepoint/maestro-contratos.csv'),'utf8');assert.equal(csv.split('\n').filter(x=>x.startsWith('CT-2026-015,')).length,1);assert.equal(csv.split('\n').filter(x=>x.startsWith('CT-2026-999,')).length,0);
  const log=(await readFile(path.join(directory,'out/sharepoint/historial.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {cambios:Record<string,unknown>});assert.equal(log.at(-1)?.cambios.id_contrato,undefined);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('no inventa el país cuando la identificación y el texto no lo determinan', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-contratos-')); const ctx={directory,sessionId:'test'};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  const p=path.join(directory,'fixtures/reto-02/buzon/msg-002/contrato.txt');const text=await readFile(p,'utf8');await writeFile(p,text.replace('con domicilio en Quito, Ecuador','con domicilio en ciudad no especificada'));
  const result=JSON.parse(await extraer.execute({mensaje_id:'msg-002'},ctx)) as {ok:boolean;data:{pais:{valor:unknown;confianza:number}}};assert.equal(result.ok,true);assert.equal(result.data.pais.valor,null);assert.equal(result.data.pais.confianza,0);
 } finally {await rm(directory,{recursive:true,force:true});}
});
