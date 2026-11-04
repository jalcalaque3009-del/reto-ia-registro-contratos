import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { withOutputDirectory } from './paths.js';

type Snapshot = Record<string, string>;
export type SnapshotClient = {
 query(statement: string, parameters?: unknown[]): Promise<{rows: Array<Record<string, unknown>>}>;
 release(): void;
};
const maxBytes = 16 * 1024 * 1024;
let pool: Pool | undefined;

export function configuredPostgresUrl(env: NodeJS.ProcessEnv = process.env): string {
 const connectionString = env.POSTGRES_URL || env.DATABASE_URL;
 if (!connectionString) throw new Error('Falta POSTGRES_URL o DATABASE_URL para el almacenamiento persistente.');
 return connectionString;
}

function getPool(): Pool {
 const connectionString = configuredPostgresUrl();
 pool ??= new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, allowExitOnIdle: true });
 return pool;
}

function safeRelative(name: string): boolean {
 return !!name && !name.includes('\\') && !name.includes('\0') && !path.posix.isAbsolute(name)
   && path.posix.normalize(name) === name && name.split('/').every(part => part !== '..' && part !== '.' && part !== '');
}

async function restoreSnapshot(root: string, snapshot: Snapshot): Promise<void> {
 let bytes = 0;
 for (const [name, encoded] of Object.entries(snapshot)) {
  if (!safeRelative(name) || typeof encoded !== 'string' || encoded.length > Math.ceil(maxBytes/3)*4 || encoded.length%4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Datos persistidos inválidos.');
  const value = Buffer.from(encoded, 'base64'); if(value.toString('base64')!==encoded) throw new Error('Datos persistidos inválidos.'); bytes += value.length;
  if (bytes > maxBytes) throw new Error('El almacenamiento persistente supera el límite permitido.');
  const destination = path.join(root, ...name.split('/'));
  await fs.mkdir(path.dirname(destination), {recursive: true});
  await fs.writeFile(destination, value);
 }
}

async function captureSnapshot(root: string): Promise<Snapshot> {
 const snapshot: Snapshot = {}; let bytes = 0;
 async function visit(dir: string, relative: string): Promise<void> {
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
   const name = relative ? `${relative}/${entry.name}` : entry.name;
   if (!safeRelative(name)) throw new Error('Ruta de salida inválida.');
   const location = path.join(dir, entry.name);
   if (entry.isDirectory()) await visit(location, name);
   else if (entry.isFile()) {
    const value = await fs.readFile(location); bytes += value.length;
    if (bytes > maxBytes) throw new Error('El almacenamiento persistente supera el límite permitido.');
    snapshot[name] = value.toString('base64');
   } else throw new Error('Tipo de archivo de salida no permitido.');
  }
 }
 await visit(root, '');
 return snapshot;
}

/** Execute one complete tool operation as a serializable snapshot transaction. */
export async function withPostgresSnapshot<T>(operation: () => Promise<T>, testClient?: SnapshotClient): Promise<T> {
 const client = testClient ?? await getPool().connect() as unknown as SnapshotClient;
 let directory: string | undefined;
 try {
  await client.query('BEGIN');
  // A transaction-scoped advisory lock serializes both first-time creation and updates.
  await client.query('SELECT pg_advisory_xact_lock($1)', [867231041]);
  await client.query('CREATE TABLE IF NOT EXISTS contratos_snapshot (id INTEGER PRIMARY KEY, files JSONB NOT NULL)');
  const result = await client.query('SELECT files FROM contratos_snapshot WHERE id = 1');
  const files = result.rows[0]?.files ?? {};
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Datos persistidos inválidos.');
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'contratos-snapshot-'));
  await restoreSnapshot(directory, files as Snapshot);
  const value = await withOutputDirectory(directory, operation);
  // Tools serialize failures instead of throwing. Do not commit files that a
  // failed tool may have partially written before producing its error result.
  let failed = false;
  if (typeof value === 'string') {
   try { const result: unknown = JSON.parse(value); failed = !!result && typeof result === 'object' && (result as {ok?: unknown}).ok === false; } catch { /* non-JSON operation result */ }
  } else if (value && typeof value === 'object') failed = (value as {ok?: unknown}).ok === false;
  if (failed) {
   // Keep the original snapshot, not the partial operation's files. Append only
   // allowlisted metadata, never the provider/tool error or its arguments.
   const baseline = { ...(files as Snapshot) };
   const previous = baseline['log.jsonl'] ? Buffer.from(baseline['log.jsonl'], 'base64').toString('utf8') : '';
   let tool = 'operacion', messageId = '';
   try {
    const contents = await fs.readFile(path.join(directory, 'log.jsonl'), 'utf8');
    // Only attribute this failure to a log record produced by this operation.
    const appended = contents.startsWith(previous) ? contents.slice(previous.length) : '';
    const last: unknown = JSON.parse(appended.trim().split('\n').at(-1) ?? '{}');
    if (last && typeof last === 'object') {
     const item = last as {herramienta?: unknown; mensaje_id?: unknown};
     if (typeof item.herramienta === 'string' && /^contratos_[a-z0-9_]{1,80}$/.test(item.herramienta)) tool = item.herramienta;
     if (typeof item.mensaje_id === 'string' && /^msg-\d{3}$/.test(item.mensaje_id)) messageId = item.mensaje_id;
    }
   } catch { /* use generic audit metadata */ }
   const line = JSON.stringify({ts:new Date().toISOString(),herramienta:tool,mensaje_id:messageId,ok:false,resumen:'operación fallida o rechazada'})+'\n';
   const currentBytes=Object.values(baseline).reduce((sum,encoded)=>sum+Buffer.from(encoded,'base64').length,0);
   if (currentBytes + Buffer.byteLength(line) > maxBytes) { await client.query('ROLLBACK'); return value; }
   baseline['log.jsonl'] = Buffer.from(previous + line).toString('base64');
   await client.query('INSERT INTO contratos_snapshot (id, files) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET files = EXCLUDED.files', [JSON.stringify(baseline)]);
   await client.query('COMMIT');
   return value;
  }
  const snapshot = await captureSnapshot(directory);
  await client.query('INSERT INTO contratos_snapshot (id, files) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET files = EXCLUDED.files', [JSON.stringify(snapshot)]);
  await client.query('COMMIT');
  return value;
 } catch (error) {
  try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
  throw error;
 } finally {
  client.release();
  if (directory) await fs.rm(directory, {recursive: true, force: true});
 }
}
