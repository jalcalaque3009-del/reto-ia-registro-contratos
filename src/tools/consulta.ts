import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { outputDirectory } from '../paths.js';
import { withWriteLock } from '../storage-lock.js';

type Context = { directory: string; sessionId: string };
type Row = Record<string, string>;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const ms=Date.parse(value+'T00:00:00Z'); return Number.isFinite(ms) && new Date(ms).toISOString().slice(0,10)===value;
}, 'Fecha inválida: usa YYYY-MM-DD');
const args = {
  vigente_al: date.optional().describe('Fecha ISO para buscar contratos vigentes en ese día; incluir fecha de inicio y fin.'),
  vence_desde: date.optional().describe('Primer día inclusive del rango de vencimiento, ISO YYYY-MM-DD.'),
  vence_hasta: date.optional().describe('Último día inclusive del rango de vencimiento, ISO YYYY-MM-DD.'),
  cliente: z.string().trim().min(1).max(200).optional().describe('Texto contenido en el nombre del cliente, sin distinguir mayúsculas ni tildes.'),
  id_contrato: z.string().trim().min(1).max(100).optional().describe('Identificador exacto del contrato, sin distinguir mayúsculas.'),
};
const fold=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const validDate=(s:string)=>date.safeParse(s).success;

/** Reads the complete current master; never writes to the registry or fixture. */
export const consultar_maestro = {
  description: 'Consulta todos los contratos del maestro por vigencia, vencimiento, cliente o identificador; devuelve el total y señala si alguna fecha impide filtrar con certeza.',
  args,
  async execute(raw: unknown, c: Context): Promise<string> {
    return withWriteLock(c.directory, async () => {
    let ok=true, summary='completada';
    try {
      const q=z.object(args).strict().parse(raw);
      if(q.vence_desde && q.vence_hasta && q.vence_desde>q.vence_hasta) throw new Error('El inicio del rango de vencimiento es posterior al fin');
      const out=path.join(outputDirectory(c.directory),'sharepoint','maestro-contratos.csv');
      const fixture=path.join(c.directory,'fixtures','reto-02','maestro-contratos.csv');
      let csv:string, fuente:'maestro_de_salida'|'fixture_original';
      try { csv=await fs.readFile(out,'utf8'); fuente='maestro_de_salida'; }
      catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; csv=await fs.readFile(fixture,'utf8'); fuente='fixture_original'; }
      const rows=parse(csv,{columns:true,skip_empty_lines:true,bom:true}) as Row[];
      const matches:Row[]=[]; let fechas_no_evaluables=0;
      for(const row of rows){
        if(q.cliente&&!fold(row.cliente??'').includes(fold(q.cliente)))continue;
        if(q.id_contrato&&fold(row.id_contrato??'')!==fold(q.id_contrato))continue;
        if((q.vigente_al||q.vence_desde||q.vence_hasta)&&(!validDate(row.fecha_fin??'')||(q.vigente_al&&!validDate(row.fecha_inicio??'')))){fechas_no_evaluables++;continue;}
        if(q.vigente_al&&(row.fecha_inicio>q.vigente_al||row.fecha_fin<q.vigente_al))continue;
        if(q.vence_desde&&row.fecha_fin<q.vence_desde)continue;
        if(q.vence_hasta&&row.fecha_fin>q.vence_hasta)continue;
        matches.push(row);
      }
      return JSON.stringify({ok:true,data:{fuente,total_maestro:rows.length,total_coincidencias:matches.length,fechas_no_evaluables,resultados_incompletos:fechas_no_evaluables>0,contratos:matches}});
    } catch(e) { ok=false; summary='consulta inválida o maestro no disponible'; const invalidRange=e instanceof Error&&e.message==='El inicio del rango de vencimiento es posterior al fin'; return JSON.stringify({ok:false,error:e instanceof z.ZodError?'Parámetros de consulta inválidos.':invalidRange?e.message:'No se pudo consultar el maestro.'}); }
    finally {
      // Audit only metadata; never include the query or contract contents.
      try { const dir=outputDirectory(c.directory);await fs.mkdir(dir,{recursive:true});await fs.appendFile(path.join(dir,'log.jsonl'),JSON.stringify({ts:new Date().toISOString(),herramienta:'contratos_consultar_maestro',mensaje_id:'',ok,resumen:summary})+'\n'); } catch { /* the query result remains usable */ }
    }
    });
  },
};
