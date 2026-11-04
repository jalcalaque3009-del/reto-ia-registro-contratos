import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

type Field={valor:unknown;confianza:number};
type Contract=Record<string,Field>;
const listen=async(server:Server)=>{server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('No port');return address.port;};
const close=async(server:Server)=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));

test('el servidor exige confirmación real y limita las descargas', {timeout:30000}, async()=>{
 const output=await mkdtemp(path.join(tmpdir(),'contratos-http-test-'));let child:ChildProcess|undefined;let calls=0;let original:Contract|undefined;
 const mock=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const payload=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {messages:Array<{role:string;content?:string}>};calls++;
  let message:Record<string,unknown>;const tool=(name:string,args:unknown)=>({role:'assistant',content:null,tool_calls:[{id:`call-${calls}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  if(calls===1)message=tool('contratos_extraer',{mensaje_id:'msg-006'});
  else if(calls===2){const result=JSON.parse(payload.messages.at(-1)?.content??'{}') as {data:Contract};original=result.data;message=tool('contratos_validar',{mensaje_id:'msg-006',contrato:original});}
  else if(calls===4||calls===6){if(!original)throw Error('Missing original contract');const candidate=structuredClone(original);candidate.fecha_inicio.valor='2026-08-31';candidate.fecha_fin.valor='2027-08-31';message=tool('contratos_registrar',{mensaje_id:'msg-006',contrato:candidate,confirmado:true});}
  else message={role:'assistant',content:'Respuesta de prueba'};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'chatcmpl-test',object:'chat.completion',created:1,model:'gpt-5.4',choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}));
 });
 const apiPort=await listen(mock);const reserve=createServer();const port=await listen(reserve);await close(reserve);
 const password='test-only-password-at-least-20-chars';const auth='Basic '+Buffer.from('test:'+password).toString('base64');const root=process.cwd();
 try{
  child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',ACCESS_PASSWORD:password,OPENAI_API_KEY:'sk-test-not-real',OPENAI_BASE_URL:`http://127.0.0.1:${apiPort}/v1`,CONTRATOS_OUTPUT_DIR:output,VERCEL:''},stdio:'ignore'});
  const url=`http://127.0.0.1:${port}`;let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(url+'/api/health',{headers:{Authorization:auth}});if(r.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(ready,'El servidor no arrancó');
  const page=await fetch(url+'/',{headers:{Authorization:auth}});assert.match(page.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);assert.equal(page.headers.get('cross-origin-resource-policy'),'same-origin');
  const crossOrigin=await fetch(url+'/api/chat',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json',Origin:'https://untrusted.example'},body:JSON.stringify({sessionId:'qa-session',message:'Hola'})});assert.equal(crossOrigin.status,403);assert.equal(calls,0,'No se debe consultar al proveedor desde otro origen');
  const post=async(message:string)=>{const response=await fetch(url+'/api/chat',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({sessionId:'qa-session',message})});assert.equal(response.status,200);return await response.json() as {toolCalls:Array<{name:string;result:{ok:boolean;error?:string}}>;needsConfirmation:boolean};};
  const first=await post('Revisa el contrato msg-006');assert.equal(first.needsConfirmation,true);assert.equal(first.toolCalls.length,2);
  const denied=await post('Confirmo que no se registre el contrato con fecha inicio 2026-08-31 y fecha fin 2027-08-31');assert.equal(denied.toolCalls[0].result.ok,false);assert.match(denied.toolCalls[0].result.error??'',/confirmación/i);
  const csvBefore=await readFile(path.join(output,'sharepoint','maestro-contratos.csv'),'utf8');assert.doesNotMatch(csvBefore,/CM-2026-03/);
  const accepted=await post('Confirmo fecha inicio: 2026-08-31, fecha fin: 2027-08-31');assert.equal(accepted.toolCalls[0].result.ok,true);assert.equal(accepted.needsConfirmation,false);
  const csvAfter=await readFile(path.join(output,'sharepoint','maestro-contratos.csv'),'utf8');assert.match(csvAfter,/CM-2026-03/);
  assert.equal((await fetch(url+'/api/artifacts/maestro-contratos.csv')).status,401);
  assert.equal((await fetch(url+'/api/artifacts/maestro-contratos.csv',{headers:{Authorization:auth}})).status,200);
  assert.equal((await fetch(url+'/api/artifacts/.env',{headers:{Authorization:auth}})).status,404);
 }finally{if(child){child.kill();await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,2000))]);}await close(mock);await rm(output,{recursive:true,force:true});}
});
