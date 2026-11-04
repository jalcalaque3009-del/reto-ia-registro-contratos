import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { consultar_maestro } from './consulta.js';

test('consulta el maestro completo, periodos y cliente sin confundirlo con alertas',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'contratos-consulta-'));const ctx={directory,sessionId:'test'};
 try{
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  const fixture=path.join(directory,'fixtures/reto-02/maestro-contratos.csv');const original=await readFile(fixture,'utf8');
  type Data={fuente:string;total_maestro:number;total_coincidencias:number;fechas_no_evaluables:number;resultados_incompletos:boolean;contratos:Array<{id_contrato:string;cliente:string}>};
  const run=async(args:unknown)=>JSON.parse(await consultar_maestro.execute(args,ctx)) as {ok:boolean;data:Data;error?:string};
  const active=await run({vigente_al:'2026-09-03'});assert.equal(active.ok,true);assert.equal(active.data.fuente,'fixture_original');assert.equal(active.data.total_maestro,8);assert.equal(active.data.total_coincidencias,6);
  assert.deepEqual(active.data.contratos.map(x=>x.id_contrato),['CT-2026-004','CT-2026-006','CT-2026-007','CT-2026-009','CT-2026-011','CT-2026-012']);
  const quarter=await run({vence_desde:'2026-07-01',vence_hasta:'2026-09-30'});assert.equal(quarter.data.total_coincidencias,2);assert.deepEqual(quarter.data.contratos.map(x=>x.id_contrato),['CT-2026-002','CT-2026-009']);
  const client=await run({cliente:'clinica'});assert.equal(client.data.contratos[0].id_contrato,'CT-2026-012');
  const exact=await run({id_contrato:'ct-2026-011'});assert.equal(exact.data.total_coincidencias,1);assert.equal(exact.data.contratos[0].id_contrato,'CT-2026-011');
  assert.equal((await run({vigente_al:'2026-02-31'})).ok,false);assert.equal((await run({vence_desde:'2027-01-01',vence_hasta:'2026-01-01'})).ok,false);
  assert.equal(await readFile(fixture,'utf8'),original);
  const output=path.join(directory,'out/sharepoint/maestro-contratos.csv');await mkdir(path.dirname(output),{recursive:true});await writeFile(output,original.replace('2027-02-19','fecha-desconocida'));
  const uncertain=await run({vigente_al:'2026-09-03'});assert.equal(uncertain.data.fuente,'maestro_de_salida');assert.equal(uncertain.data.resultados_incompletos,true);assert.equal(uncertain.data.fechas_no_evaluables,1);assert.equal(uncertain.data.total_coincidencias,5);
 }finally{await rm(directory,{recursive:true,force:true});}
});
