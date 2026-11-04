import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Local Windows key is DPAPI-encrypted for the current Windows account.
 * Hosted environments should supply the provider's secret environment variable. */
export function loadApiKey(): string | undefined {
 const configured=process.env.OPENAI_API_KEY?.trim(); if(configured)return configured;
 const encrypted=path.resolve('.secrets/openai.dpapi'); if(process.platform!=='win32'||!existsSync(encrypted))return undefined;
 return execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.resolve('scripts/decrypt-key.ps1'),'-Path',encrypted],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']}).trim() || undefined;
}
