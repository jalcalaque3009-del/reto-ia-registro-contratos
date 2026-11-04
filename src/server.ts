import 'dotenv/config';
import express from 'express';
import { readFile, appendFile, mkdir, access } from 'node:fs/promises';
import { z } from 'zod';
import * as contractTools from './tools/contratos.js';
import * as masterTools from './tools/consulta.js';
import { OpenAiAdapter } from './llm/openai.js';
import type { LlmAdapter } from './llm/adapter.js';
import { loadApiKey } from './secret.js';
import { outputDirectory } from './paths.js';
import { isExplicitConfirmation, confirmedChangesError, confirmedReviewError } from './confirmation.js';
import { timingSafeEqual,hkdfSync,createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import path from 'node:path';

const app=express();
const host=process.env.HOST || '127.0.0.1';
const password=process.env.ACCESS_PASSWORD?.trim();
if((process.env.VERCEL || !['127.0.0.1','localhost','::1'].includes(host)) && (!password || password.length<20)) throw new Error('Para acceso por red configura ACCESS_PASSWORD con al menos 20 caracteres y usa HTTPS en el proxy.');
const attempts=new Map<string,{count:number;until:number}>();
app.use((req,res,next)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
 // The app has no external scripts, styles, images or frames. Restrict resource
 // loading and cross-origin embedding while permitting its bundled inline UI.
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
 res.setHeader('Cross-Origin-Resource-Policy','same-origin');
 res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 const ip=req.socket.remoteAddress??'unknown';const now=Date.now();let limit=attempts.get(ip);if(!limit||limit.until<now){limit={count:0,until:now+15*60*1000};attempts.set(ip,limit);}limit.count++;if(limit.count>120){res.status(429).send('Demasiadas solicitudes');return;}
 if(password){const auth=req.headers.authorization??'';let supplied='';if(auth.startsWith('Basic ')){try{supplied=Buffer.from(auth.slice(6),'base64').toString('utf8').split(':').slice(1).join(':');}catch{/* reject */}}const actual=Buffer.from(supplied);const expected=Buffer.from(password);if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){res.setHeader('WWW-Authenticate','Basic realm="Contratos", charset="UTF-8"');res.status(401).send('Acceso restringido');return;}}
 if(req.method==='POST' && req.headers.origin){let origin:URL;try{origin=new URL(req.headers.origin);}catch{res.status(403).send('Origen inválido');return;}if(origin.host!==req.headers.host){res.status(403).send('Origen no autorizado');return;}}
 next();
});
app.use(express.json({limit:'256kb'})); app.get('/',(_req,res)=>res.sendFile(path.resolve('web/index.html')));
const model='gpt-5.4';
const maxIterations=Math.min(Number(process.env.MAX_TURNS)||12,25);
const maxSessionTokens=Math.min(Number(process.env.MAX_SESSION_TOKENS)||50000,100000);
const globalBudget=Math.min(Number(process.env.MAX_TOTAL_TOKENS)||100000,500000);
type Message=Record<string,unknown>;
type Session={messages:Message[]; tokens:number; originals:Record<string,Record<string,{valor:unknown;confianza:number}>>; pending:Set<string>; reviews?:Record<string,string[]>; history:unknown[]};
const sessions=new Map<string,Session>(); let totalTokens=0; let requestCount=0;
function sessionKey(apiKey:string):Buffer {return Buffer.from(hkdfSync('sha256',apiKey,'reto-contratos-v1','session-encryption',32));}
function seal(s:Session,apiKey:string):string {const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',sessionKey(apiKey),iv);const plaintext=JSON.stringify({...s,pending:[...s.pending],history:[],expires:Date.now()+72*3600_000});const body=Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url'); }
function unseal(token:string,apiKey:string):Session {if(token.length>200000)throw new Error('Sesión inválida');const raw=Buffer.from(token,'base64url');const decipher=createDecipheriv('aes-256-gcm',sessionKey(apiKey),raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));const decoded=JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8')) as Session&{pending:string[];expires:number};if(decoded.expires<Date.now())throw new Error('Sesión vencida');return {...decoded,pending:new Set(decoded.pending),history:[]};}
const tools={...contractTools,...masterTools} as Record<string,{description:string;args:z.ZodRawShape;execute:(a:unknown,c:{directory:string;sessionId:string})=>Promise<string>}>;
const definitions=Object.entries(tools).map(([name,t])=>({type:'function',function:{name:'contratos_'+name,description:t.description,parameters:z.toJSONSchema(z.object(t.args))}}));
const context={directory:process.cwd(),sessionId:''};
const agentPrompt=await readFile('agent/prompt.md','utf8'); const knowledge=await readFile('src/knowledge/registro-contratos.md','utf8');
app.get('/api/health',(_req,res)=>res.json({ok:true,provider:'openai',model}));
app.get('/api/sessions/:id',(req,res)=>res.json({history:sessions.get(req.params.id)?.history??[]}));
app.get('/api/artifacts/:name',async(req,res)=>{
 const files=new Map([['maestro-contratos.csv','sharepoint/maestro-contratos.csv'],['alertas.md','alertas.md']]);
 const relative=files.get(req.params.name); if(!relative){res.status(404).send('Archivo no disponible.');return;}
 const directory=outputDirectory(process.cwd()); const filename=path.join(directory,relative);
 try{await access(filename);res.download(filename,req.params.name,err=>{if(err&&!res.headersSent)res.status(404).send('Archivo no disponible. Vuelve a procesar el buzón.');});}catch{res.status(404).send('Archivo no disponible en esta instancia. Vuelve a procesar el buzón o generar las alertas.');}
});
app.post('/api/chat',async(req,res)=>{
 const schema=z.object({sessionId:z.string().regex(/^[\w-]{1,80}$/),message:z.string().min(1).max(4000),sessionToken:z.string().max(200000).optional()}); const parsed=schema.safeParse(req.body); if(!parsed.success){res.status(400).json({error:'Solicitud inválida'});return;}
 let apiKey:string|undefined; try { apiKey=loadApiKey(); } catch {res.status(503).json({error:'No se pudo abrir la clave cifrada con este usuario de Windows.'});return;} if(!apiKey){res.status(503).json({error:'Configura una clave de OpenAI en el servidor.'});return;}
 if(requestCount>=100 || totalTokens>=globalBudget){res.status(429).json({error:'Se alcanzó el límite global de uso.'});return;}
 const {sessionId,message,sessionToken}=parsed.data; let restored:Session|undefined; if(process.env.VERCEL && sessionToken){try {restored=unseal(sessionToken,apiKey);}catch{res.status(400).json({error:'La sesión no es válida o ha vencido; inicia otra.'});return;}} const session=restored??sessions.get(sessionId)??{messages:[{role:'system',content:agentPrompt+'\n\n'+knowledge}],tokens:0,originals:{},pending:new Set<string>(),history:[]};
 session.reviews ??= {};
 // Existing encrypted conversations retain their turns but receive the current instructions after deployment.
 session.messages[0]={role:'system',content:agentPrompt+'\n\n'+knowledge};
 sessions.set(sessionId,session); const pendingBeforeTurn=new Set(session.pending); const originalsBeforeTurn=new Set(Object.keys(session.originals));
 if(session.tokens>=maxSessionTokens){res.status(429).json({error:'Se alcanzó el límite de tokens de esta sesión.'});return;}
 requestCount++; session.messages.push({role:'user',content:message}); session.history.push({role:'user',content:message}); const toolCalls:unknown[]=[]; let reply='Se alcanzó el límite de iteraciones. Continúa en un nuevo turno.'; let needsConfirmation=false; let alertDate:string|undefined; let alertsStale=false;
 const llm:LlmAdapter=new OpenAiAdapter(model,apiKey); const confirms=isExplicitConfirmation(message);
 try { for(let i=0;i<maxIterations;i++) {
   const remaining=Math.min(1800,maxSessionTokens-session.tokens,globalBudget-totalTokens); if(remaining<=0){const events=toolCalls as Array<{name:string;args:Record<string,unknown>;result:{ok:boolean;data?:Record<string,unknown>;error?:string}}>;const lines=events.filter(e=>/contratos_(validar|registrar)/.test(e.name)).map(e=>`- ${String(e.args.mensaje_id??'Caso')}: ${e.result.ok?String(e.result.data?.accion??e.result.data?.clasificacion??'consultado'):String(e.result.error??'error')}${Array.isArray(e.result.data?.requiere_revision)&&(e.result.data.requiere_revision as unknown[]).length?` · revisión: ${(e.result.data.requiere_revision as unknown[]).join(', ')}`:''}`);reply='Se alcanzó el límite de uso de la sesión. Estos son los resultados que alcanzaron a verificarse:\n\n'+(lines.join('\n')||'No hay resultados de clasificación todavía.');needsConfirmation=session.pending.size>0;break;}
   const response=await llm.send(session.messages,definitions,remaining); session.tokens+=response.usage; totalTokens+=response.usage; const answer=response.message; session.messages.push(answer as unknown as Message);
   if(!answer.tool_calls?.length){reply=answer.content || 'No hay respuesta disponible.';needsConfirmation=session.pending.size>0;break;}
   for(const call of answer.tool_calls) {
    const name=call.function.name.replace(/^contratos_/,''); const tool=tools[name]; let args:Record<string,unknown>={}; let result:string;
    try {args=JSON.parse(call.function.arguments) as Record<string,unknown>; if(!tool)throw new Error('Herramienta desconocida'); const id=String(args.mensaje_id??'');
      if(name==='validar' || name==='registrar') {
        const proposed=args.contrato as Record<string,{valor:unknown;confianza:number}>; const original=session.originals[id]; if(!original || !proposed)throw new Error('Primero extrae el contrato en esta sesión.');
        const confirmationError=confirmedChangesError(message,original,proposed);if(confirmationError)throw new Error(confirmationError);
        const hasChanges=Object.keys(original).some(k=>JSON.stringify(original[k].valor)!==JSON.stringify(proposed[k].valor));
        // An explicit correction may also apply to a previously extracted clean
        // contract; it must refer to an extraction from an earlier turn.
        const manualCorrection=hasChanges && originalsBeforeTurn.has(id) && !pendingBeforeTurn.has(id);
        if(hasChanges && (!confirms || (!pendingBeforeTurn.has(id) && !manualCorrection) || (name==='registrar' && args.confirmado!==true)))throw new Error('Los cambios requieren confirmación humana explícita en un turno posterior.');
        if(name==='registrar' && args.confirmado===true && (!confirms || (!pendingBeforeTurn.has(id) && !manualCorrection)))throw new Error('Se requiere confirmación humana explícita en un turno posterior.');
        if(name==='registrar' && args.confirmado===true) {
          const review=session.reviews?.[id];
          if(pendingBeforeTurn.has(id)){if(!review)throw new Error('Vuelve a validar el contrato antes de confirmar sus campos.');const reviewError=confirmedReviewError(message,review,proposed);if(reviewError)throw new Error(reviewError);}
          else if(manualCorrection){
            if(session.pending.has(id))throw new Error('El contrato requiere una nueva revisión; confirma sus campos en el siguiente turno.');
            const checked=JSON.parse(await contractTools.validar.execute({mensaje_id:id,contrato:proposed},{...context,sessionId})) as {ok:boolean;error?:string;data?:{requiere_revision?:string[]}};
            if(!checked.ok)throw new Error(checked.error||'No se pudo validar la corrección.');
            const fields=checked.data?.requiere_revision??[];if(fields.length){session.reviews[id]=fields;session.pending.add(id);needsConfirmation=true;throw new Error('La corrección requiere una nueva revisión: '+fields.join(', ')+'. Confirma los campos en el siguiente turno.');}
          }
        }
        if(name==='registrar' && proposed.otrosi?.valor!==true && ['fecha_inicio','fecha_fin'].some(k=>!proposed[k]?.valor))throw new Error('Faltan fechas: pide a la persona los valores antes de registrar.');
      }
      result=await tool.execute(args,{...context,sessionId}); const data=JSON.parse(result) as {ok:boolean;data?:Record<string,unknown>};
      if(name==='extraer'&&data.ok&&data.data)session.originals[id]=data.data as Record<string,{valor:unknown;confianza:number}>;
      if(name==='validar'&&data.ok&&Array.isArray(data.data?.requiere_revision)&&(data.data.requiere_revision as unknown[]).length){session.reviews[id]=(data.data.requiere_revision as unknown[]).filter((k): k is string=>typeof k==='string');session.pending.add(id);needsConfirmation=true;}
      if(name==='alertas'&&data.ok){alertDate=String(args.hoy);alertsStale=false;}
      if(name==='registrar'&&data.ok){session.pending.delete(id);delete session.reviews[id];if(alertDate && data.data?.accion!=='duplicado')alertsStale=true;}
    } catch(e){result=JSON.stringify({ok:false,error:e instanceof Error?e.message:'Error de herramienta'});try{const dir=outputDirectory(process.cwd());await mkdir(dir,{recursive:true});await appendFile(path.join(dir,'log.jsonl'),JSON.stringify({ts:new Date().toISOString(),herramienta:tool?'contratos_'+name:'herramienta_desconocida',mensaje_id:/^msg-\d{3}$/.test(String(args.mensaje_id??''))?args.mensaje_id:'',ok:false,resumen:'precondición o argumentos inválidos'})+'\n');}catch{/* no ocultar el error principal */}}
    toolCalls.push({name:call.function.name,args,result:JSON.parse(result)}); session.messages.push({role:'tool',tool_call_id:call.id,content:result});
   }
   if(alertsStale && alertDate){session.messages.push({role:'system',content:`El maestro cambió después del reporte de alertas. El reporte anterior está desactualizado. Llama de nuevo a contratos_alertas con hoy=${alertDate} antes de resumir alertas.`});alertsStale=false;}
  }
  if(reply==='Se alcanzó el límite de iteraciones. Continúa en un nuevo turno.'){
   const events=toolCalls as Array<{name:string;args:Record<string,unknown>;result:{ok:boolean;data?:Record<string,unknown>;error?:string}}>;
   const lines=events.filter(e=>/contratos_(validar|registrar)/.test(e.name)).map(e=>`- ${String(e.args.mensaje_id??'Caso')}: ${e.result.ok?String(e.result.data?.accion??e.result.data?.clasificacion??'consultado'):String(e.result.error??'error')}${Array.isArray(e.result.data?.requiere_revision)&&(e.result.data.requiere_revision as unknown[]).length?` · revisión: ${(e.result.data.requiere_revision as unknown[]).join(', ')}`:''}`);
   reply='Se alcanzó el límite de pasos de este turno; el proceso puede estar incompleto.\n\n'+(lines.length?'Resultados verificados hasta ahora:\n'+lines.join('\n'):'No se verificaron clasificaciones o registros en este turno.')+'\n\nPide continuar para comprobar los casos y alertas que falten.';needsConfirmation=session.pending.size>0;
  }
  session.history.push({role:'assistant',content:reply,toolCalls,needsConfirmation}); const newSessionToken=process.env.VERCEL?seal(session,apiKey):undefined;res.json({reply,toolCalls,needsConfirmation,usage:session.tokens,sessionToken:newSessionToken});
 }catch(e){ const err=e instanceof Error?e.message:'Error del proveedor'; const logdir=outputDirectory(process.cwd());await mkdir(logdir,{recursive:true}); await appendFile(path.join(logdir,'errors.log'),new Date().toISOString()+' error de proveedor\n'); res.status(502).json({error:'No se pudo consultar el modelo. Comprueba la clave, conexión y disponibilidad. '+(err.includes('timed out')?'Tiempo de espera agotado.':'')}); }
});
if(!process.env.VERCEL)app.listen(Number(process.env.PORT)||3000,host,()=>console.log(`Servidor iniciado en ${host}:${process.env.PORT||3000}`));
export default app;
