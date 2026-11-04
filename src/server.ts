import 'dotenv/config';
import express from 'express';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import * as contractTools from './tools/contratos.js';
import { OpenAiAdapter } from './llm/openai.js';
import type { LlmAdapter } from './llm/adapter.js';

const app=express(); app.use(express.json({limit:'64kb'})); app.use(express.static('web'));
const model=process.env.OPENAI_MODEL || 'gpt-4o-mini';
const maxIterations=Math.min(Number(process.env.MAX_TURNS)||12,25);
const maxSessionTokens=Math.min(Number(process.env.MAX_SESSION_TOKENS)||20000,100000);
const globalBudget=Math.min(Number(process.env.MAX_TOTAL_TOKENS)||100000,500000);
type Message=Record<string,unknown>;
type Session={messages:Message[]; tokens:number; originals:Record<string,Record<string,{valor:unknown;confianza:number}>>; pending:Set<string>; history:unknown[]};
const sessions=new Map<string,Session>(); let totalTokens=0; let requestCount=0;
const tools=contractTools as Record<string,{description:string;args:z.ZodRawShape;execute:(a:unknown,c:{directory:string;sessionId:string})=>Promise<string>}>;
const definitions=Object.entries(tools).map(([name,t])=>({type:'function',function:{name:'contratos_'+name,description:t.description,parameters:z.toJSONSchema(z.object(t.args))}}));
const context={directory:process.cwd(),sessionId:''};
const agentPrompt=await readFile('agent/prompt.md','utf8'); const knowledge=await readFile('src/knowledge/registro-contratos.md','utf8');
app.get('/api/health',(_req,res)=>res.json({ok:true,provider:'openai',model}));
app.get('/api/sessions/:id',(req,res)=>res.json({history:sessions.get(req.params.id)?.history??[]}));
app.post('/api/chat',async(req,res)=>{
 const schema=z.object({sessionId:z.string().regex(/^[\w-]{1,80}$/),message:z.string().min(1).max(4000)}); const parsed=schema.safeParse(req.body); if(!parsed.success){res.status(400).json({error:'Solicitud inválida'});return;}
 if(!process.env.OPENAI_API_KEY){res.status(503).json({error:'Configura OPENAI_API_KEY en el entorno del servidor.'});return;}
 if(requestCount>=100 || totalTokens>=globalBudget){res.status(429).json({error:'Se alcanzó el límite global de uso.'});return;}
 const {sessionId,message}=parsed.data; const session=sessions.get(sessionId)??{messages:[{role:'system',content:agentPrompt+'\n\n'+knowledge}],tokens:0,originals:{},pending:new Set<string>(),history:[]}; sessions.set(sessionId,session); const pendingBeforeTurn=new Set(session.pending);
 if(session.tokens>=maxSessionTokens){res.status(429).json({error:'Se alcanzó el límite de tokens de esta sesión.'});return;}
 requestCount++; session.messages.push({role:'user',content:message}); session.history.push({role:'user',content:message}); const toolCalls:unknown[]=[]; let reply='Se alcanzó el límite de iteraciones. Continúa en un nuevo turno.'; let needsConfirmation=false;
 const llm:LlmAdapter=new OpenAiAdapter(model); const confirms=/^\s*(?:sí[,\s]+)?(?:confirmo|autorizo|apruebo)\b/i.test(message) && !/\bno\s+(?:confirmo|autorizo|apruebo)\b/i.test(message);
 try { for(let i=0;i<maxIterations;i++) {
   const remaining=Math.min(1000,maxSessionTokens-session.tokens,globalBudget-totalTokens); if(remaining<=0){reply='Se alcanzó el límite de tokens.';break;}
   const response=await llm.send(session.messages,definitions,remaining); session.tokens+=response.usage; totalTokens+=response.usage; const answer=response.message; session.messages.push(answer as unknown as Message);
   if(!answer.tool_calls?.length){reply=answer.content || 'No hay respuesta disponible.';needsConfirmation=session.pending.size>0;break;}
   for(const call of answer.tool_calls) {
    const name=call.function.name.replace(/^contratos_/,''); const tool=tools[name]; let args:Record<string,unknown>={}; let result:string;
    try {args=JSON.parse(call.function.arguments) as Record<string,unknown>; if(!tool)throw new Error('Herramienta desconocida'); const id=String(args.mensaje_id??'');
      if(name==='registrar') {
        const proposed=args.contrato as Record<string,{valor:unknown;confianza:number}>; const original=session.originals[id]; if(!original || !proposed)throw new Error('Primero extrae el contrato en esta sesión.');
        if(Object.keys(proposed).length!==Object.keys(original).length)throw new Error('Se requiere el contrato extraído completo.');
        for(const [k,v] of Object.entries(proposed)) { const source=original[k]; if(!source)throw new Error('Campo desconocido: '+k); if(JSON.stringify(v)!==JSON.stringify(source)) { if(!confirms || !pendingBeforeTurn.has(id) || v.valor===null || !message.includes(String(v.valor)))throw new Error('Solo se admiten cambios expresos y confirmados por la persona: '+k); } }
        if(args.confirmado===true && (!confirms || !pendingBeforeTurn.has(id)))throw new Error('Se requiere confirmación humana explícita en un turno posterior.');
        if(proposed.otrosi?.valor!==true && ['fecha_inicio','fecha_fin'].some(k=>!proposed[k]?.valor))throw new Error('Faltan fechas: pide a la persona los valores antes de registrar.');
      }
      result=await tool.execute(args,{...context,sessionId}); const data=JSON.parse(result) as {ok:boolean;data?:Record<string,unknown>};
      if(name==='extraer'&&data.ok&&data.data)session.originals[id]=data.data as Record<string,{valor:unknown;confianza:number}>;
      if(name==='validar'&&data.ok&&Array.isArray(data.data?.requiere_revision)&&(data.data.requiere_revision as unknown[]).length){session.pending.add(id);needsConfirmation=true;}
      if(name==='registrar'&&data.ok)session.pending.delete(id);
    } catch(e){result=JSON.stringify({ok:false,error:e instanceof Error?e.message:'Error de herramienta'});}
    toolCalls.push({name:call.function.name,args,result:JSON.parse(result)}); session.messages.push({role:'tool',tool_call_id:call.id,content:result});
   }
  }
  session.history.push({role:'assistant',content:reply,toolCalls,needsConfirmation}); res.json({reply,toolCalls,needsConfirmation,usage:session.tokens});
 }catch(e){ const err=e instanceof Error?e.message:'Error del proveedor'; await mkdir('out',{recursive:true}); await appendFile('out/errors.log',new Date().toISOString()+' error de proveedor\n'); res.status(502).json({error:'No se pudo consultar el modelo. Comprueba la clave, conexión y disponibilidad. '+(err.includes('timed out')?'Tiempo de espera agotado.':'')}); }
});
app.listen(Number(process.env.PORT)||3000,()=>console.log(`Servidor iniciado en puerto ${process.env.PORT||3000}`));
