import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { leer_buzon, leer_fuente, extraer, validar, registrar, alertas } from './contratos.js';
import { parse } from 'csv-parse/sync';

test('consulta los textos originales sin cambiar el buzón ni permitir rutas arbitrarias', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-fuente-')); const ctx={directory,sessionId:'test'};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  for(const [id,name] of [['msg-001','contrato.txt'],['msg-003','otrosi.txt'],['msg-005','cotizacion.txt'],['msg-006','contrato.txt']] as const){
   const result=JSON.parse(await leer_fuente.execute({mensaje_id:id},ctx)) as {ok:boolean;data:{mensaje_id:string;adjuntos:Array<{archivo:string;texto:string}>}};
   assert.equal(result.ok,true);assert.equal(result.data.mensaje_id,id);assert.equal(result.data.adjuntos[0].archivo,name);
   assert.equal(result.data.adjuntos[0].texto,await readFile(path.join(directory,'fixtures/reto-02/buzon',id,name),'utf8'));
   if(id==='msg-006')assert.match(result.data.adjuntos[0].texto,/prorrogables automáticamente por periodos iguales salvo aviso en contrario con treinta \(30\) días de antelación/);
  }
  const invalid=JSON.parse(await leer_fuente.execute({mensaje_id:'../../.env'},ctx)) as {ok:boolean};assert.equal(invalid.ok,false);
  const emailPath=path.join(directory,'fixtures/reto-02/buzon/msg-001/correo.json');const mail=JSON.parse(await readFile(emailPath,'utf8')) as {adjuntos:string[]};mail.adjuntos.push('../../.env');await writeFile(emailPath,JSON.stringify(mail));
  const safe=JSON.parse(await leer_fuente.execute({mensaje_id:'msg-001'},ctx)) as {data:{adjuntos:Array<{archivo:string}>}};assert.deepEqual(safe.data.adjuntos.map(a=>a.archivo),['contrato.txt']);
  await writeFile(path.join(directory,'fixtures/reto-02/buzon/msg-002/contrato.txt'),'');const empty=JSON.parse(await leer_fuente.execute({mensaje_id:'msg-002'},ctx)) as {ok:boolean;error:string};assert.equal(empty.ok,false);assert.match(empty.error,/vacío/);
  const missing=JSON.parse(await leer_fuente.execute({mensaje_id:'msg-999'},ctx)) as {ok:boolean};assert.equal(missing.ok,false);
  const inbox=JSON.parse(await leer_buzon.execute({},ctx)) as {data:{mensajes:Array<{id:string}>}};assert.ok(inbox.data.mensajes.some(m=>m.id==='msg-001'));
 } finally {await rm(directory,{recursive:true,force:true});}
});
import { stringify } from 'csv-stringify/sync';

test('procesa los seis casos, conserva el maestro original y exige revisión', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-contratos-')); const ctx={directory,sessionId:'test'};
 const execute=async(t:{execute:(a:unknown,c:typeof ctx)=>Promise<string>},a:unknown)=>JSON.parse(await t.execute(a,ctx)) as {ok:boolean;data?:Record<string,unknown>;error?:string};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  const original=await readFile(path.join(directory,'fixtures/reto-02/maestro-contratos.csv'),'utf8');
  const inbox=await execute(leer_buzon,{}); assert.equal(inbox.ok,true); const messages=inbox.data?.mensajes as Array<{id:string;tiene_contrato:boolean;clasificacion?:string;motivo?:string}>; assert.equal(messages.length,6);
  const quote=messages.find(message=>message.id==='msg-005'); assert.equal(quote?.tiene_contrato,false); assert.equal(quote?.clasificacion,'rechazado'); assert.match(quote?.motivo??'',/sin adjunto/i);
  const expected:Record<string,string>={'msg-001':'nuevo','msg-002':'nuevo','msg-003':'actualizacion','msg-004':'duplicado','msg-006':'nuevo'};
  for(const [id,classification] of Object.entries(expected)) {
   const e=await execute(extraer,{mensaje_id:id});assert.equal(e.ok,true,id); const v=await execute(validar,{mensaje_id:id,contrato:e.data}); assert.equal(v.data?.clasificacion,classification,id);
   if(id==='msg-006'){const policy=e.data?.condicion_poliza as {valor:string};assert.match(policy.valor,/COP \$100\.000\.000/);assert.match(policy.valor,/supere/);const currency=e.data?.moneda as {valor:unknown;confianza:number};assert.equal(currency.valor,null,'La moneda de la garantía no prueba la moneda del contrato');assert.equal(currency.confianza,0);assert.ok((v.data?.requiere_revision as string[]).includes('moneda'));}
   const before=id==='msg-004'?await readFile(path.join(directory,'out/sharepoint/maestro-contratos.csv'),'utf8'):undefined;
   const write=await execute(registrar,{mensaje_id:id,contrato:e.data});
   if(before!==undefined)assert.equal(await readFile(path.join(directory,'out/sharepoint/maestro-contratos.csv'),'utf8'),before,'Un duplicado no debe cambiar el maestro');
   if(id==='msg-006'){assert.equal(write.ok,false);assert.match(write.error??'',/revisión/);const bypass=await execute(registrar,{mensaje_id:id,contrato:e.data,confirmado:true});assert.equal(bypass.ok,false);assert.match(bypass.error??'',/fechas/);} else assert.equal(write.ok,true,id);
  }
  const report=await execute(alertas,{hoy:'2026-09-03'});assert.equal(report.ok,true);assert.ok((report.data?.vencen as unknown[]).length>0);assert.equal((await execute(alertas,{hoy:'2026-02-31'})).ok,false);
  const afterCut=report.data?.registrados_desde_corte as {id_contrato:string}[];assert.ok(afterCut.some(row=>row.id_contrato==='CT-2026-015'));assert.ok(!afterCut.some(row=>row.id_contrato==='CT-2026-011'));
  assert.equal(await readFile(path.join(directory,'fixtures/reto-02/maestro-contratos.csv'),'utf8'),original);
  const csv=await readFile(path.join(directory,'out/sharepoint/maestro-contratos.csv'),'utf8');assert.match(csv,/CT-2026-011.*520000.*2027-11-01/);assert.equal(csv.split('\n').filter(line=>line.startsWith('CT-2026-012,')).length,1);assert.doesNotMatch(csv,/CM-2026-03/);
  const rows=parse(csv,{columns:true,skip_empty_lines:true}) as {id_contrato:string;fecha_registro:string;fuente:string;requiere_poliza:string;estado_poliza:string}[];const amended=rows.find(row=>row.id_contrato==='CT-2026-011');assert.equal(amended?.fecha_registro,'2026-05-05');assert.equal(amended?.fuente,'buzon');
  assert.equal(rows.find(row=>row.id_contrato==='CT-2026-015')?.estado_poliza,'pendiente');
  const withoutPolicy=rows.find(row=>row.id_contrato==='CT-2026-016');assert.equal(withoutPolicy?.requiere_poliza,'false');assert.equal(withoutPolicy?.estado_poliza,'no_aplica');
  const remaining=await execute(leer_buzon,{});assert.deepEqual((remaining.data?.mensajes as Array<{id:string}>).map(m=>m.id),['msg-006']);
  const entries=(await readFile(path.join(directory,'out/log.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {herramienta:string;ok:boolean});assert.ok(entries.some(entry=>entry.herramienta==='contratos_registrar'&&!entry.ok));assert.ok(entries.some(entry=>entry.herramienta==='contratos_alertas'&&entry.ok));
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

test('los campos ausentes se conservan desconocidos y exigen revisión, sin rechazar todo el contrato', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-parcial-'));const ctx={directory,sessionId:'test'};
 const run=async(t:{execute:(a:unknown,c:typeof ctx)=>Promise<string>},a:unknown)=>JSON.parse(await t.execute(a,ctx)) as {ok:boolean;data?:Record<string,unknown>;error?:string};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  const file=path.join(directory,'fixtures/reto-02/buzon/msg-002/contrato.txt');const original=await readFile(file,'utf8');
  for(const [changed,missing] of [
   [original.replace('PRIMERA. OBJETO.','PRIMERA. ALCANCE.'),['objeto']],
   [original.replace('identificada con RUC 1790012345001','identificada con REGISTRO 1790012345001'),['cliente','nit_cliente','pais']],
   [original.replace('SEGUNDA. VALOR.','SEGUNDA. PRECIO.'),['valor','moneda']],
  ] as Array<[string,string[]]>) {
   assert.notEqual(changed,original);await writeFile(file,changed);
   const e=await run(extraer,{mensaje_id:'msg-002'});assert.equal(e.ok,true,e.error??'extracción fallida');
   for(const key of missing){const field=e.data?.[key] as {valor:unknown;confianza:number};assert.equal(field.valor,null,key);assert.equal(field.confianza,0,key);}
   const v=await run(validar,{mensaje_id:'msg-002',contrato:e.data});assert.equal(v.ok,true);assert.equal(v.data?.clasificacion,'nuevo');
   for(const key of missing)assert.ok((v.data?.requiere_revision as string[]).includes(key),key);
   const write=await run(registrar,{mensaje_id:'msg-002',contrato:e.data});assert.equal(write.ok,false);assert.match(write.error??'',/revisión/);
   const inbox=await run(leer_buzon,{});const mail=(inbox.data?.mensajes as Array<{id:string;clasificacion?:string}>).find(m=>m.id==='msg-002');assert.ok(mail);assert.notEqual(mail.clasificacion,'rechazado');
  }
  await writeFile(file,original.replace('USD 120,000.00','XYZ 120,000.00'));const invalid=await run(extraer,{mensaje_id:'msg-002'});assert.equal(invalid.ok,false);assert.match(invalid.error??'',/Moneda desconocida/);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('una sola fecha se interpreta por su etiqueta y no se inventa la otra', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-fecha-parcial-'));const ctx={directory,sessionId:'test'};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  const p=path.join(directory,'fixtures/reto-02/buzon/msg-002/contrato.txt');const original=await readFile(p,'utf8');
  const range='desde el quince (15) de agosto de 2026 hasta el catorce (14) de agosto de 2027';assert.ok(original.includes(range));
  for(const [replacement,start,end] of [['hasta el catorce (14) de agosto de 2027',null,'2027-08-14'],['desde el quince (15) de agosto de 2026','2026-08-15',null],['con fecha el quince (15) de agosto de 2026',null,null]] as const){
   await writeFile(p,original.replace(range,replacement));const e=JSON.parse(await extraer.execute({mensaje_id:'msg-002'},ctx)) as {ok:boolean;data:{fecha_inicio:{valor:unknown};fecha_fin:{valor:unknown}}};assert.equal(e.ok,true);assert.equal(e.data.fecha_inicio.valor,start);assert.equal(e.data.fecha_fin.valor,end);
  }
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('genera un identificador permitido por el PRD cuando el documento carece de número', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-sin-numero-'));const ctx={directory,sessionId:'test'};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  const p=path.join(directory,'fixtures/reto-02/buzon/msg-002/contrato.txt');const original=await readFile(p,'utf8');const changed=original.replace('No. CT-2026-016','SIN NÚMERO');assert.notEqual(changed,original);await writeFile(p,changed);
  const extracted=JSON.parse(await extraer.execute({mensaje_id:'msg-002'},ctx)) as {data:Record<string,{valor:unknown;confianza:number}>};assert.equal(extracted.data.id_contrato.valor,null);assert.equal(extracted.data.id_contrato.confianza,0);
  const validation=JSON.parse(await validar.execute({mensaje_id:'msg-002',contrato:extracted.data},ctx)) as {data:{requiere_revision:string[]}};assert.ok(!validation.data.requiere_revision.includes('id_contrato'));
  const saved=JSON.parse(await registrar.execute({mensaje_id:'msg-002',contrato:extracted.data},ctx)) as {ok:boolean;data:{id_contrato:string;ruta_archivo:string}};assert.equal(saved.ok,true);assert.equal(saved.data.id_contrato,'AUTO-2026-001');assert.match(saved.data.ruta_archivo,/AUTO-2026-001\.txt$/);
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

test('no marca como procesado un duplicado con identidad contradictoria sin revisión', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-contratos-'));const ctx={directory,sessionId:'test'};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  const extracted=JSON.parse(await extraer.execute({mensaje_id:'msg-004'},ctx)) as {data:Record<string,{valor:unknown;confianza:number}>};
  const conflicting=structuredClone(extracted.data);conflicting.nit_cliente.valor='123456789';
  const validation=JSON.parse(await validar.execute({mensaje_id:'msg-004',contrato:conflicting},ctx)) as {data:{clasificacion:string;requiere_revision:string[]}};
  assert.equal(validation.data.clasificacion,'duplicado');assert.ok(validation.data.requiere_revision.includes('nit_cliente'));
  const blocked=JSON.parse(await registrar.execute({mensaje_id:'msg-004',contrato:conflicting},ctx)) as {ok:boolean;error:string};assert.equal(blocked.ok,false);assert.match(blocked.error,/revisión/);
  const inbox=JSON.parse(await leer_buzon.execute({},ctx)) as {data:{mensajes:Array<{id:string}>}};assert.ok(inbox.data.mensajes.some(m=>m.id==='msg-004'));
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('rechaza texto sin partes ni objeto y continúa con los demás mensajes', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-contratos-'));const ctx={directory,sessionId:'test'};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  await writeFile(path.join(directory,'fixtures/reto-02/buzon/msg-001/contrato.txt'),'Texto sin partes ni objeto identificables.');
  await writeFile(path.join(directory,'fixtures/reto-02/buzon/msg-002/contrato.txt'),'  \n');
  const inbox=JSON.parse(await leer_buzon.execute({},ctx)) as {ok:boolean;data:{mensajes:Array<{id:string;clasificacion?:string;motivo?:string}>}};
  assert.equal(inbox.ok,true);const invalid=inbox.data.mensajes.find(m=>m.id==='msg-001');assert.equal(invalid?.clasificacion,'rechazado');assert.match(invalid?.motivo??'',/partes y objeto/i);
  const empty=inbox.data.mensajes.find(m=>m.id==='msg-002');assert.equal(empty?.clasificacion,undefined);
  const extractedEmpty=JSON.parse(await extraer.execute({mensaje_id:'msg-002'},ctx)) as {ok:boolean;error:string};assert.equal(extractedEmpty.ok,false);assert.match(extractedEmpty.error,/vacío/i);
  const next=JSON.parse(await extraer.execute({mensaje_id:'msg-003'},ctx)) as {ok:boolean};assert.equal(next.ok,true);
  const after=JSON.parse(await leer_buzon.execute({},ctx)) as {data:{mensajes:Array<{id:string}>}};assert.ok(!after.data.mensajes.some(m=>m.id==='msg-001'));assert.ok(after.data.mensajes.some(m=>m.id==='msg-002'));
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('alertas incluyen los días 0 y 60, excluyen el 61 y separan pólizas vigentes', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'reto-alertas-'));const ctx={directory,sessionId:'test'};
 try {
  await cp(path.join(process.cwd(),'fixtures'),path.join(directory,'fixtures'),{recursive:true});
  const master=path.join(directory,'fixtures/reto-02/maestro-contratos.csv');
  const rows=parse(await readFile(master,'utf8'),{columns:true,skip_empty_lines:true,bom:true}) as Array<Record<string,string>>;
  const add=(id:string,date:string,requires:string,state:string)=>rows.push({...rows[0],id_contrato:id,fecha_fin:date,requiere_poliza:requires,estado_poliza:state});
  add('TEST-0','2026-09-03','true','pendiente');add('TEST-60','2026-11-02','true','vigente');add('TEST-61','2026-11-03','true','vencida');add('TEST-EXPIRED','2026-09-02','false','no_aplica');
  await writeFile(master,stringify(rows,{header:true}));
  const report=JSON.parse(await alertas.execute({hoy:'2026-09-03'},ctx)) as {ok:boolean;data:{vencen:Array<{id_contrato:string}>;polizas_pendientes:Array<{id_contrato:string}>}};
  assert.equal(report.ok,true);const expiring=report.data.vencen.map(r=>r.id_contrato);assert.ok(expiring.includes('TEST-0'));assert.ok(expiring.includes('TEST-60'));assert.ok(!expiring.includes('TEST-61'));assert.ok(!expiring.includes('TEST-EXPIRED'));
  const policy=report.data.polizas_pendientes.map(r=>r.id_contrato);assert.ok(policy.includes('TEST-0'));assert.ok(policy.includes('TEST-61'));assert.ok(!policy.includes('TEST-60'));assert.ok(!policy.includes('TEST-EXPIRED'));
 } finally {await rm(directory,{recursive:true,force:true});}
});
