import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const transactionOutput = new AsyncLocalStorage<string>();

/** Use an isolated output directory for the lifetime of one asynchronous operation. */
export function withOutputDirectory<T>(directory: string, operation: () => Promise<T>): Promise<T> {
 return transactionOutput.run(directory, operation);
}

/** Keep all simulated artifacts in one explicitly controlled directory. */
export function outputDirectory(projectDirectory: string): string {
 const transactional = transactionOutput.getStore();
 if (transactional) return transactional;
 const override=process.env.CONTRATOS_OUTPUT_DIR;
 return override ? path.resolve(override) : process.env.VERCEL ? '/tmp/reto-contratos-out' : path.join(projectDirectory,'out');
}
