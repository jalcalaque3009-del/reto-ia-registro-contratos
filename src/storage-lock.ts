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
    return await operation();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
