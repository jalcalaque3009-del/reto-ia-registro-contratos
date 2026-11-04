import { rm } from 'node:fs/promises';
import path from 'node:path';
import { leer_buzon, extraer, validar, registrar, rechazar, alertas } from './src/tools/contratos.js';
const ctx={directory:process.cwd(),sessionId:'demo',registrationDate:'2026-09-03'};
type Result={ok:boolean;data?:Record<string,unknown>;error?:string};
const run=async (tool:{execute:(a:unknown,c:typeof ctx)=>Promise<string>},a:unknown):Promise<Result>=>JSON.parse(await tool.execute(a,ctx)) as Result;
// Keep the deterministic demo isolated from any custom server output directory.
const demoOutput=path.join(ctx.directory,'out');
process.env.CONTRATOS_OUTPUT_DIR=demoOutput;
await rm(demoOutput,{recursive:true,force:true});
const inbox=await run(leer_buzon,{});
if(!inbox.ok || !Array.isArray(inbox.data?.mensajes)) throw new Error(inbox.error || 'No se pudo leer el buzón');
for(const m of inbox.data.mensajes as {id:string;tiene_contrato:boolean;clasificacion?:string;motivo?:string}[]) {
 if(!m.tiene_contrato || m.clasificacion==='rechazado'){const result=await run(rechazar,{mensaje_id:m.id});console.log(m.id,result.ok?'rechazado:':'error:',result.ok?(m.motivo||'sin contrato'):result.error);continue;}
 const ext=await run(extraer,{mensaje_id:m.id}); if(!ext.ok){console.log(m.id,'error:',ext.error);continue;}
 const contract=ext.data; const valid=await run(validar,{mensaje_id:m.id,contrato:contract});
 if(!valid.ok){console.log(m.id,'error:',valid.error);continue;}
 const review=valid.data?.requiere_revision as string[]; let action='pendiente de revisión';
 if(!review.length) {const result=await run(registrar,{mensaje_id:m.id,contrato:contract});action=result.ok?String(result.data?.accion):String(result.error);}
 console.log(m.id,valid.data?.clasificacion,'revisión:',review.join(', ')||'ninguna','acción:',action);
 if(m.id==='msg-006' && review.length){const result=await run(registrar,{mensaje_id:m.id,contrato:contract,confirmado:true});console.log('  confirmación sin fechas:',result.ok?result.data:result.error); const start=contract?.fecha_inicio as {confianza:number};const end=contract?.fecha_fin as {confianza:number};const currency=contract?.moneda as {confianza:number};const example={...contract,fecha_inicio:{valor:'2026-08-31',confianza:start.confianza},fecha_fin:{valor:'2027-08-31',confianza:end.confianza},moneda:{valor:'COP',confianza:currency.confianza}}; const corrected=await run(registrar,{mensaje_id:m.id,contrato:example,confirmado:true});console.log('  con fechas y moneda del valor COP de ejemplo, proporcionadas por revisor simulado (no están determinadas en el contrato):',corrected.ok?corrected.data:corrected.error);}
}
const report=await run(alertas,{hoy:'2026-09-03'}); console.log('Alertas:',report.ok?report.data?.ruta:report.error);
