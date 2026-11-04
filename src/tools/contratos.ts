import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { outputDirectory } from '../paths.js';

type Context = { directory: string; sessionId: string };
type Row = Record<string, string>;
type Field = { valor: string | number | boolean | null; confianza: number };
type Contract = Record<string, Field>;
const campo = z.object({ valor: z.union([z.string(), z.number(), z.boolean(), z.null()]), confianza: z.number().min(0).max(1) });
const contractSchema = z.record(z.string(), campo);
const idSchema = z.string().regex(/^msg-\d{3}$/).describe('Identificador del mensaje, por ejemplo msg-001');
const fixture = (c: Context, ...p: string[]) => path.join(c.directory, 'fixtures', 'reto-02', ...p);
const output = (c: Context, ...p: string[]) => path.join(outputDirectory(c.directory), ...p);
const readJson = async (p: string) => JSON.parse(await fs.readFile(p, 'utf8')) as unknown;
const writeJson = (p: string, value: unknown) => fs.writeFile(p, JSON.stringify(value, null, 2), 'utf8');
const field = (valor: Field['valor'], confianza = valor === null ? 0 : 1): Field => ({ valor, confianza });
const val = (c: Contract, key: string) => c[key]?.valor ?? null;
const slug = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const safe = (s: unknown) => String(s ?? '');
const readRows = async (c: Context): Promise<Row[]> => { await init(c); return parse(await fs.readFile(output(c, 'sharepoint', 'maestro-contratos.csv'), 'utf8'), { columns: true, skip_empty_lines: true, bom: true }) as Row[]; };
const saveRows = async (c: Context, rows: Row[]) => fs.writeFile(output(c, 'sharepoint', 'maestro-contratos.csv'), stringify(rows, { header: true }), 'utf8');
async function init(c: Context) { await fs.mkdir(output(c, 'sharepoint'), { recursive: true }); const p = output(c, 'sharepoint', 'maestro-contratos.csv'); try { await fs.access(p); } catch { await fs.copyFile(fixture(c, 'maestro-contratos.csv'), p); } }
async function processed(c: Context): Promise<Record<string, string>> { try { return await readJson(output(c, 'procesados.json')) as Record<string, string>; } catch { return {}; } }
async function mark(c: Context, id: string, state: string) { const p = await processed(c); p[id] = state; await writeJson(output(c, 'procesados.json'), p); }
async function log(c: Context, name: string, id: string, ok: boolean, summary: string) { await fs.mkdir(output(c), { recursive: true }); await fs.appendFile(output(c, 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), herramienta: name, mensaje_id: id, ok, resumen: summary }) + '\n'); }
function tool<T extends z.ZodRawShape>(name: string, description: string, args: T, fn: (a: z.infer<z.ZodObject<T>>, c: Context) => Promise<unknown>) {
  return { description, args, async execute(raw: unknown, c: Context): Promise<string> { let ok = true; let result: unknown; try { const parsed = z.object(args).parse(raw); result = { ok: true, data: await fn(parsed, c) }; } catch (e) { ok = false; result = { ok: false, error: e instanceof Error ? e.message : 'Error desconocido' }; } try { await log(c, name, safe((raw as Record<string, unknown>)?.mensaje_id), ok, ok ? 'completada' : safe((result as {error?:string}).error)); } catch { /* no ocultar el resultado */ } return JSON.stringify(result); } };
}
const months: Record<string, string> = { enero:'01', febrero:'02', marzo:'03', abril:'04', mayo:'05', junio:'06', julio:'07', agosto:'08', septiembre:'09', octubre:'10', noviembre:'11', diciembre:'12' };
function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ts = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(ts) && new Date(ts).toISOString().slice(0,10) === value;
}
function dates(text: string): string[] { return [...text.matchAll(/\((\d{1,2})\) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) de (\d{4})/gi)].map(m => { const date = `${m[3]}-${months[m[2].toLowerCase()]}-${m[1].padStart(2,'0')}`; if (!isValidDate(date)) throw new Error('Fecha inválida en el contrato'); return date; }); }
async function email(c: Context, id: string) { return await readJson(fixture(c, 'buzon', id, 'correo.json')) as { id:string; de:string; asunto:string; fecha:string; adjuntos:string[] }; }
async function extract(c: Context, id: string): Promise<Contract> {
  const mail = await email(c, id); const file = mail.adjuntos.find(a => /^(contrato|otrosi)\.txt$/i.test(a));
  if (!file) throw new Error('Sin adjunto de contrato identificable');
  const text = await fs.readFile(fixture(c, 'buzon', id, file), 'utf8'); if (!text.trim()) throw new Error('El texto del contrato está vacío');
  const isOther = /^OTROSÍ/i.test(text); const idMatch = text.match(/CONTRATO(?: MARCO)? DE PRESTACIÓN DE SERVICIOS No\.\s*([\w-]+)/i);
  const client = text.match(/Entre (?:los suscritos, )?([^,\n]+),\s*(?:identificada con )?(NIT|RUC|RTN)\s*([\d.]+)(?:-\d)?/i);
  const object = text.match(/PRIMERA\. OBJETO\.\s*([\s\S]*?)(?=\n\s*SEGUNDA\.)/i)?.[1].trim();
  if (!client || (!object && !isOther)) throw new Error('No se identificaron partes y objeto del contrato');
  const clause = text.match(/(?:SEGUNDA\. VALOR\.|cláusula SEGUNDA \(VALOR\))[\s\S]*?(?=\n\s*TERCERA\.)/i)?.[0] ?? '';
  const money = clause.match(/\b(COP|USD|PEN|PAB|HNL)\s*\$?\s*([\d.,]+)/i); const undetermined = /no tiene un valor determinado/i.test(clause);
  const number = money ? Number(money[1] === 'COP' ? money[2].replace(/\./g,'').replace(',', '.') : money[2].replace(/,/g,'')) : null;
  if (money && !Number.isFinite(number)) throw new Error('Valor inválido');
  if (!money && !undetermined && !isOther) throw new Error('Moneda o valor no identificados');
  const term = text.match(/(?:TERCERA\. PLAZO\.|cláusula TERCERA \(PLAZO\))[\s\S]*?(?=\n\s*(?:CUARTA|SEGUNDA)\.)/i)?.[0] ?? '';
  const ds = dates(term); const hasPolicy = /(?:póliza|garantías de cumplimiento)/i.test(text); const conditionalPolicy = /Para cada orden de servicio/i.test(text);
  const conditionalPolicyText = conditionalPolicy ? text.match(/CUARTA\. GARANTÍAS\.\s*([\s\S]*?)(?=\n\s*\n|$)/i)?.[1].trim() ?? null : null;
  const sellers = await readJson(fixture(c,'comerciales.json')) as {email:string;nombre:string}[]; const seller = sellers.find(s => s.email.toLowerCase() === mail.de.toLowerCase());
  // Examine the counterparty portion, not the contractor's Colombian address.
  const counterparty = text.split(/,\s*y\s+PERIFERIA\b/i)[0];
  const country = /Ecuador/i.test(counterparty) ? 'EC' : /Perú/i.test(counterparty) ? 'PE' : /Panamá/i.test(counterparty) ? 'PA' : /Honduras/i.test(counterparty) || /^RTN$/i.test(client[2]) ? 'HN' : /Colombia/i.test(counterparty) || /^NIT$/i.test(client[2]) ? 'CO' : null;
  return { id_contrato:field(idMatch?.[1] ?? null), cliente:field(client[1].trim()), nit_cliente:field(client[3].replace(/\D/g,'')), pais:field(country), objeto:field(object?.slice(0,200) ?? null), valor:field(undetermined ? 0 : number, undetermined ? .5 : number === null ? 0 : 1), valor_indeterminado:field(undetermined), moneda:field(money?.[1].toUpperCase() ?? (undetermined && /COP/i.test(text) ? 'COP' : null)), fecha_inicio:field(isOther ? null : ds[0] ?? null), fecha_fin:field(isOther ? ds[0] ?? null : ds[1] ?? null), requiere_poliza:field(hasPolicy, conditionalPolicy ? .5 : 1), condicion_poliza:field(conditionalPolicyText), tipo_poliza:field(hasPolicy ? 'cumplimiento' : ''), estado_poliza:field(hasPolicy ? 'pendiente' : 'no_aplica', conditionalPolicy ? .5 : 1), comercial:field(seller?.nombre ?? null, seller ? 1 : 0), otrosi:field(isOther), remitente_desconocido:field(!seller) };
}
async function validate(c: Context, id: string, contract: Contract) {
  for (const key of ['fecha_inicio','fecha_fin']) { const value=val(contract,key); if (value !== null && !isValidDate(value)) throw new Error(`Fecha inválida: ${key}`); }
  const start=val(contract,'fecha_inicio'), end=val(contract,'fecha_fin'); if (typeof start==='string' && typeof end==='string' && end<start) throw new Error('La fecha de fin es anterior a la fecha de inicio');
  const currency=val(contract,'moneda'); if (currency!==null && (typeof currency!=='string' || !['COP','USD','PEN','PAB','HNL'].includes(currency))) throw new Error('Moneda desconocida');
  const country=val(contract,'pais'); if (country!==null && (typeof country!=='string' || !['CO','EC','PE','PA','HN'].includes(country))) throw new Error('País desconocido');
  const amount=val(contract,'valor'); if(amount!==null && (typeof amount!=='number' || !Number.isFinite(amount) || amount<0)) throw new Error('Valor inválido');
  const rows = await readRows(c); const exact = rows.find(r => r.id_contrato === val(contract,'id_contrato'));
  const existing = exact ?? rows.find(r => r.nit_cliente === val(contract,'nit_cliente') && similarity(r.objeto, safe(val(contract,'objeto'))) >= .9);
  const isOther = val(contract,'otrosi') === true;
  const classification = existing ? (exact && !isOther && ['valor','fecha_inicio','fecha_fin'].every(k => safe(val(contract,k)) === existing[k]) ? 'duplicado' : 'actualizacion') : 'nuevo';
  if (isOther && !existing) return { clasificacion:'rechazado', requiere_revision:[], motivo:'Otrosí sin contrato previo identificado' };
  const keys = ['id_contrato','cliente','nit_cliente','pais','objeto','valor','moneda','fecha_inicio','fecha_fin','requiere_poliza','estado_poliza'];
  const review = keys.filter(k => (contract[k]?.confianza ?? 0) < .8 && !(isOther && ['objeto','fecha_inicio','requiere_poliza','estado_poliza'].includes(k)));
  // Identity disagreements are not normal amendment changes. Amount and end-date changes
  // in a known amendment remain ordinary, traceable updates.
  const conflicts = existing ? ['id_contrato','nit_cliente','pais','cliente'].filter(k => {
    const value=val(contract,k); if(value===null || value==='') return false;
    return k==='cliente' ? slug(safe(value))!==slug(existing[k]) : safe(value)!==existing[k];
  }) : [];
  for(const key of conflicts) if(!review.includes(key)) review.push(key);
  const differences = existing ? Object.fromEntries(['id_contrato','cliente','nit_cliente','pais','valor','fecha_inicio','fecha_fin'].filter(k => val(contract,k) !== null && (k==='cliente' ? slug(safe(val(contract,k)))!==slug(existing[k]) : safe(val(contract,k)) !== existing[k])).map(k => [k,{ antes:existing[k], despues:val(contract,k) }])) : {};
  return { clasificacion:classification, id_contrato_existente:existing?.id_contrato, requiere_revision:review, diferencias:differences, remitente_desconocido:val(contract,'remitente_desconocido') };
}
function similarity(a:string,b:string) { const x=slug(a), y=slug(b); if (!x||!y) return 0; let prev=Array.from({length:y.length+1},(_,i)=>i); for(let i=1;i<=x.length;i++){const next=[i]; for(let j=1;j<=y.length;j++)next[j]=Math.min(next[j-1]+1,prev[j]+1,prev[j-1]+(x[i-1]===y[j-1]?0:1));prev=next;} return 1-prev[y.length]/Math.max(x.length,y.length); }

export const leer_buzon = tool('contratos_leer_buzon','Lista mensajes pendientes y clasifica los que no tienen contrato.',{},async (_,c) => {
 await init(c); const seen = await processed(c); const ids = (await fs.readdir(fixture(c,'buzon'))).sort(); const mensajes=[];
 for(const id of ids) {
  if(seen[id]) continue;
  const m=await email(c,id); const tiene_contrato=m.adjuntos.some(a=>/^(contrato|otrosi)\.txt$/i.test(a));
  let motivo = tiene_contrato ? '' : 'Sin adjunto de contrato';
  if(tiene_contrato){
   try { await extract(c,id); } catch(error) {
    // Only the explicit missing-parties/object finding is a rejection. Other
    // extraction failures stay pending so they can be reported and retried.
    if(error instanceof Error && error.message==='No se identificaron partes y objeto del contrato') motivo=error.message;
   }
  }
  mensajes.push({...m,tiene_contrato,...(motivo?{clasificacion:'rechazado',motivo}:{})});
  if(motivo) await mark(c,id,'rechazado');
 }
 return {mensajes};
});
export const extraer = tool('contratos_extraer','Extrae campos y confianza del texto de un contrato.',{mensaje_id:idSchema},async (a,c)=>extract(c,a.mensaje_id));
export const leer_fuente = tool('contratos_leer_fuente','Consulta el texto original del mensaje y sus adjuntos ficticios para responder preguntas sobre cláusulas.',{mensaje_id:idSchema},async (a,c)=>{
 const root=fixture(c,'buzon',a.mensaje_id); let mail:{id:string;de:string;asunto:string;fecha:string;cuerpo?:string;adjuntos:string[]};
 try {mail=await readJson(path.join(root,'correo.json')) as typeof mail;}catch{throw new Error('Mensaje no encontrado o ilegible');}
 if(!Array.isArray(mail.adjuntos)) throw new Error('Lista de adjuntos inválida');
 const adjuntos:Array<{archivo:string;texto:string}>=[];
 for(const name of mail.adjuntos){
  // Never resolve arbitrary paths from fixture metadata or from the model.
  if(!/^(contrato|otrosi|cotizacion)\.txt$/i.test(name)) continue;
  const file=path.join(root,name);let stat:Awaited<ReturnType<typeof fs.lstat>>;try{stat=await fs.lstat(file);}catch{throw new Error('Adjunto no disponible');}
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>65536) throw new Error('Adjunto no disponible o demasiado grande');
  const texto=await fs.readFile(file,'utf8');if(!texto.trim()) throw new Error('El texto del adjunto está vacío');
  adjuntos.push({archivo:name,texto});
 }
 if(!adjuntos.length) throw new Error('No hay adjuntos de texto disponibles para consultar');
 return {mensaje_id:a.mensaje_id,correo:{de:mail.de,asunto:mail.asunto,fecha:mail.fecha,cuerpo:mail.cuerpo??null},adjuntos};
});
export const validar = tool('contratos_validar','Clasifica el contrato y señala campos que requieren revisión.',{mensaje_id:idSchema,contrato:contractSchema.describe('Campos extraídos con su nivel de confianza')},async(a,c)=>validate(c,a.mensaje_id,a.contrato));
export const registrar = tool('contratos_registrar','Registra o actualiza el contrato después de la revisión necesaria.',{mensaje_id:idSchema,contrato:contractSchema.describe('Contrato validado'),confirmado:z.boolean().optional().describe('Confirmación humana explícita')},async(a,c)=>{
 const v=await validate(c,a.mensaje_id,a.contrato); if(v.clasificacion==='rechazado') throw new Error(v.motivo); if(v.requiere_revision.length && !a.confirmado) throw new Error('requiere revisión: '+v.requiere_revision.join(', ')); if(v.clasificacion==='duplicado') { await mark(c,a.mensaje_id,'duplicado'); return {accion:'duplicado',id_contrato:v.id_contrato_existente,ruta_archivo:null}; } if(val(a.contrato,'otrosi')!==true && ['fecha_inicio','fecha_fin'].some(k=>!val(a.contrato,k)))throw new Error('Las fechas de inicio y fin deben ser proporcionadas por el revisor');
 const rows=await readRows(c); const existing=rows.find(r=>r.id_contrato===v.id_contrato_existente); const mail=await email(c,a.mensaje_id); const attachment=mail.adjuntos.find(s=>/^(contrato|otrosi)\.txt$/i.test(s)); if(!attachment)throw new Error('Sin adjunto');
 let id=existing?.id_contrato || safe(val(a.contrato,'id_contrato')); if(!id) id=`AUTO-${mail.fecha.slice(0,4)}-${String(rows.length+1).padStart(3,'0')}`; if(!/^[\w-]+$/.test(id))throw new Error('Identificador inválido');
 const date=safe(val(a.contrato,'fecha_inicio')) || existing?.fecha_inicio || mail.fecha.slice(0,10); const client=safe(val(a.contrato,'cliente')) || existing?.cliente || 'sin-cliente'; const relative=`Contratos/${date.slice(0,4)}/${slug(client)}/${id}${val(a.contrato,'otrosi')?'-otrosi':''}.txt`;
 const target=output(c,'sharepoint',...relative.split('/')); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.copyFile(fixture(c,'buzon',a.mensaje_id,attachment),target);
 const row:Row=existing?{...existing}:Object.fromEntries(Object.keys(rows[0]).map(k=>[k,''])); for(const key of Object.keys(row)) { const value=val(a.contrato,key); if(value!==null && !(existing && val(a.contrato,'otrosi')===true && ['requiere_poliza','tipo_poliza','estado_poliza'].includes(key))) row[key]=safe(value); } row.id_contrato=id; row.ruta_sharepoint=relative; if(existing){row.fecha_registro=existing.fecha_registro;row.fuente=existing.fuente;}else{row.fecha_registro=mail.fecha.slice(0,10);row.fuente='buzon';} if(!existing)rows.push(row);else rows[rows.indexOf(existing)]=row;
 const changes=existing?Object.fromEntries(Object.keys(row).filter(k=>row[k]!==existing[k]).map(k=>[k,{antes:existing[k],despues:row[k]}])):{};
 await saveRows(c,rows); await fs.appendFile(output(c,'sharepoint','historial.jsonl'),JSON.stringify({ts:new Date().toISOString(),id_contrato:id,accion:v.clasificacion,cambios:changes,mensaje_id:a.mensaje_id,fecha_mensaje:mail.fecha})+'\n'); await mark(c,a.mensaje_id,v.clasificacion); return {id_contrato:id,accion:v.clasificacion,ruta_archivo:relative};
});
export const alertas = tool('contratos_alertas','Genera alertas de vencimiento, pólizas y registros posteriores al corte.',{hoy:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha de referencia ISO YYYY-MM-DD')},async(a,c)=>{ const today=Date.parse(a.hoy+'T00:00:00Z'); if(!Number.isFinite(today)||new Date(today).toISOString().slice(0,10)!==a.hoy)throw new Error('Fecha inválida'); const rows=await readRows(c); const vencen=rows.filter(r=>{const d=(Date.parse(r.fecha_fin+'T00:00:00Z')-today)/86400000;return d>=0&&d<=60}); const polizas_pendientes=rows.filter(r=>r.requiere_poliza==='true'&&r.estado_poliza!=='vigente'); const registrados_desde_corte=rows.filter(r=>r.fecha_registro>'2026-05-30'); const section=(title:string,rs:Row[])=>`## ${title}\n`+(rs.map(r=>`- ${r.id_contrato} | ${r.cliente} | vence ${r.fecha_fin} | póliza ${r.estado_poliza}`).join('\n')||'- Ninguno')+'\n'; const report='# Alertas al '+a.hoy+'\n\n'+section('Vencen en 60 días',vencen)+section('Pólizas pendientes o vencidas',polizas_pendientes)+section('Registrados desde el corte',registrados_desde_corte); await fs.writeFile(output(c,'alertas.md'),report,'utf8');return {ruta:'out/alertas.md',vencen,polizas_pendientes,registrados_desde_corte}; });
