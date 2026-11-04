import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';

type Contract=Record<string,{valor:unknown;confianza:number}>;
const listen=async(server:Server)=>{server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('No port');return address.port;};

test('un dato extraído con alta confianza se puede corregir con confirmación explícita posterior', {timeout:30000},async()=>{
 const output=await mkdtemp(path.join(tmpdir(),'contratos-correccion-'));let child:ChildProcess|undefined;let calls=0;let original:Contract|undefined;
 const mock=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const payload=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {messages:Array<{content?:string}>};calls++;
  const call=(name:string,args:unknown)=>({role:'assistant',content:null,tool_calls:[{id:`c-${calls}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});let message:Record<string,unknown>;
  if(calls===1)message=call('contratos_extraer',{mensaje_id:'msg-002'});
  else if(calls===2){original=(JSON.parse(payload.messages.at(-1)?.content??'{}') as {data:Contract}).data;message=call('contratos_validar',{mensaje_id:'msg-002',contrato:original});}
  else if(calls===4){if(!original)throw Error('Missing extracted contract');const candidate=structuredClone(original);candidate.valor.valor=999;message=call('contratos_registrar',{mensaje_id:'msg-002',contrato:candidate,confirmado:true});}
  else message={role:'assistant',content:'Respuesta de prueba'};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'test',object:'chat.completion',created:1,model:'gpt-5.4',choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
 });
 try{
  const apiPort=await listen(mock);const reservation=createServer();const port=await listen(reservation);await new Promise<void>((resolve,reject)=>reservation.close(e=>e?reject(e):resolve()));
  const password='test-only-password-at-least-20-chars';const auth='Basic '+Buffer.from('test:'+password).toString('base64');
  child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',ACCESS_PASSWORD:password,OPENAI_API_KEY:'sk-test-not-real',OPENAI_BASE_URL:`http://127.0.0.1:${apiPort}/v1`,CONTRATOS_OUTPUT_DIR:output,VERCEL:''},stdio:'ignore'});
  const url=`http://127.0.0.1:${port}`;let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(url+'/api/health',{headers:{Authorization:auth}});if(r.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(ready);
  const post=async(message:string)=>{const r=await fetch(url+'/api/chat',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({sessionId:'correction-test',message})});assert.equal(r.status,200);return await r.json() as {toolCalls:Array<{result:{ok:boolean;error?:string}}>};};
  const first=await post('Extrae y valida msg-002 sin registrarlo');assert.equal(first.toolCalls.length,2);assert.ok(first.toolCalls.every(c=>c.result.ok));
  const corrected=await post('Confirmo valor: 999');assert.equal(corrected.toolCalls[0].result.ok,true,corrected.toolCalls[0].result.error??'Falló la corrección');
  const csv=await readFile(path.join(output,'sharepoint/maestro-contratos.csv'),'utf8');assert.match(csv,/CT-2026-016.*999/);
 }finally{if(child){child.kill();await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,2000))]);}await new Promise<void>((resolve,reject)=>mock.close(e=>e?reject(e):resolve()));await rm(output,{recursive:true,force:true});}
});
