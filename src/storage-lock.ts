import path from 'node:path';
import { outputDirectory } from './paths.js';

// Serialize complete read/modify/write operations that share one output folder.
// This protects one Node process only. Separate serverless instances require a
// shared transactional store and cannot be coordinated by this in-memory lock.
const tails = new Map<string, Promise<void>>();

export async function withWriteLock<T>(projectDirectory: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(outputDirectory(projectDirectory));
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  await previous;
  try {
    // Hosted deployments must fail closed rather than silently fall back to
    // an instance-local registry if the shared database is unavailable.
    if (process.env.CONTRATOS_PERSISTENCE === 'postgres' || process.env.VERCEL) {
      try {
        const { withPostgresSnapshot } = await import('./postgres-storage.js');
        return await withPostgresSnapshot(operation);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw error;
        // Provider errors can contain connection details. Never expose them to
        // the model, browser, or logs.
        throw new Error('No se pudo acceder al almacenamiento compartido.');
      }
    }
    return await operation();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
