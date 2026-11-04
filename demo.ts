import { rm } from 'node:fs/promises';
import { leer_buzon, extraer, validar, registrar, alertas } from './src/tools/contratos.js';
const ctx={directory:process.cwd(),sessionId:'demo'};
type Result={ok:boolean;data?:Record<string,unknown>;error?:string};
const run=async (tool:{execute:(a:unknown,c:typeof ctx)=>Promise<string>},a:unknown):Promise<Result>=>JSON.parse(await tool.execute(a,ctx)) as Result;
await rm('out',{recursive:true,force:true});
const inbox=await run(leer_buzon,{});
for(const m of inbox.data?.mensajes as {id:string;tiene_contrato:boolean}[]) {
 if(!m.tiene_contrato){console.log(m.id,'rechazado: sin contrato');continue;}
 const ext=await run(extraer,{mensaje_id:m.id}); if(!ext.ok){console.log(m.id,'error:',ext.error);continue;}
 const contract=ext.data; const valid=await run(validar,{mensaje_id:m.id,contrato:contract});
 if(!valid.ok){console.log(m.id,'error:',valid.error);continue;}
 const review=valid.data?.requiere_revision as string[]; let action='pendiente de revisión';
 if(!review.length || valid.data?.clasificacion==='duplicado') {const result=await run(registrar,{mensaje_id:m.id,contrato:contract});action=result.ok?String(result.data?.accion):String(result.error);}
 console.log(m.id,valid.data?.clasificacion,'revisión:',review.join(', ')||'ninguna','acción:',action);
 if(m.id==='msg-006' && review.length){const result=await run(registrar,{mensaje_id:m.id,contrato:contract,confirmado:true});console.log('  confirmación sin fechas:',result.ok?result.data:result.error); const start=contract?.fecha_inicio as {confianza:number};const end=contract?.fecha_fin as {confianza:number};const example={...contract,fecha_inicio:{valor:'2026-08-31',confianza:start.confianza},fecha_fin:{valor:'2027-08-31',confianza:end.confianza}}; const corrected=await run(registrar,{mensaje_id:m.id,contrato:example,confirmado:true});console.log('  con fechas de ejemplo proporcionadas por revisor simulado:',corrected.ok?corrected.data:corrected.error);}
}
const report=await run(alertas,{hoy:'2026-09-03'}); console.log('Alertas:',report.ok?report.data?.ruta:report.error);
