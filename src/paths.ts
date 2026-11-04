import path from 'node:path';

/** Keep all simulated artifacts in one explicitly controlled directory. */
export function outputDirectory(projectDirectory: string): string {
 const override=process.env.CONTRATOS_OUTPUT_DIR;
 return override ? path.resolve(override) : process.env.VERCEL ? '/tmp/reto-contratos-out' : path.join(projectDirectory,'out');
}
