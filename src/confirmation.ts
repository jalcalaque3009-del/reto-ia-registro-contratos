/** Explicit human confirmation for changes to fields extracted from a contract. */
export type ConfirmedField = { valor: unknown; confianza: number };
export type ConfirmedContract = Record<string, ConfirmedField>;

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only an affirmative statement at the start of the turn may authorize an action. */
export function isExplicitConfirmation(message: string): boolean {
  const text = normalize(message).trim();
  if (!/^(?:si\s*[,.:;-]?\s+)?(?:confirmo|autorizo|apruebo)\b/.test(text)) return false;
  // Refuse ambiguous negations involving the requested action, but allow a field
  // value such as "requiere poliza: no" when it is not a denial of the action.
  if (/\b(?:no|nunca|jamas)\b[^.;\n]{0,80}\b(?:registr\w*|autoriz\w*|aprob\w*|confirm\w*|guard\w*|ingres\w*|proced\w*|modifi\w*|actualiz\w*|camb\w*|proces\w*|contin\w*|quiero|hagas|crear|crees)\b/.test(text)) return false;
  if (/\b(?:cancel\w*|suspend\w*|deten\w*|deteng\w*|rechaz\w*|omit\w*|ignor\w*|esper\w*|paus\w*|excepto|salvo|sin|tampoco|nunca|jamas)\b/.test(text)) return false;
  // A naked "no" is not consent, even after an affirmative prefix. The only
  // accepted occurrence is an adjacent explicit boolean field value; remove
  // that exact expression before checking for any remaining denial.
  const withoutBooleanValues = text.replace(/(?:^|[^a-z0-9_])(?:requiere[_\s]+poliza|valor[_\s]+indeterminado)\s*(?:(?:es|sera|igual\s+a)\s*)?(?:[:=]\s*)?["'“”]?no["'“”]?(?![a-z0-9_])/g, ' ');
  if (/\bno\b/.test(withoutBooleanValues)) return false;
  return true;
}

const aliases: Record<string, string[]> = {
  fecha_inicio: ['fecha_inicio', 'fecha de inicio', 'fecha inicio'],
  fecha_fin: ['fecha_fin', 'fecha de fin', 'fecha fin', 'fecha de vencimiento'],
  valor: ['valor', 'importe', 'monto'],
  moneda: ['moneda'],
  requiere_poliza: ['requiere_poliza', 'requiere poliza'],
  estado_poliza: ['estado_poliza', 'estado de la poliza', 'estado poliza'],
  tipo_poliza: ['tipo_poliza', 'tipo de poliza', 'tipo poliza'],
  valor_indeterminado: ['valor_indeterminado', 'valor indeterminado'],
  id_contrato: ['id_contrato', 'id de contrato', 'numero de contrato'],
  nit_cliente: ['nit_cliente', 'nit del cliente', 'nit cliente'],
  cliente: ['cliente'], pais: ['pais'], objeto: ['objeto'], comercial: ['comercial'],
};

function mentionedFieldValue(message: string, name: string, value: unknown): boolean {
  if (value === null || !['string', 'number', 'boolean'].includes(typeof value)) return false;
  const labels = aliases[name] ?? [name, name.replace(/_/g, ' ')];
  const labelPattern = labels.map(label => escapePattern(normalize(label)).replace(/ /g, '\\s+')).join('|');
  const values = typeof value === 'boolean' ? (value ? ['true', 'si'] : ['false', 'no']) : [normalize(String(value))];
  const valuePattern = values.map(v => escapePattern(v).replace(/_/g, '[_\\s]+').replace(/ /g, '\\s+')).join('|');
  // A field and its value must be adjacent, apart from ordinary Spanish
  // connectors; numeric boundaries prevent the 0 in a date from matching 0.
  const expression = new RegExp(`(?:^|[^a-z0-9_])(?:${labelPattern})(?![a-z0-9_])\\s*(?:(?:es|sera|igual\\s+a|de)\\s*)?(?:[:=]\\s*)?["'“”]?(${valuePattern})["'“”]?(?![a-z0-9_]|[.,-]\\d)`, 'i');
  return expression.test(normalize(message));
}

function validDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** Returns a safe user-facing error, or null when every proposed change is explicit. */
export function confirmedChangesError(message: string, original: ConfirmedContract, proposed: ConfirmedContract): string | null {
  const originalKeys = Object.keys(original);
  if (Object.keys(proposed).length !== originalKeys.length || originalKeys.some(k => !Object.hasOwn(proposed, k))) return 'Se requiere el contrato extraído completo.';
  for (const key of originalKeys) {
    const source = original[key]; const candidate = proposed[key];
    if (!candidate || typeof candidate !== 'object') return `Campo inválido: ${key}`;
    if (candidate.confianza !== source.confianza) return `No se puede modificar la confianza de extracción: ${key}`;
    if (JSON.stringify(candidate.valor) === JSON.stringify(source.valor)) continue;
    if (!isExplicitConfirmation(message)) return 'Se requiere confirmación humana explícita.';
    if ((key === 'fecha_inicio' || key === 'fecha_fin') && !validDate(candidate.valor)) return `La fecha debe existir y tener formato YYYY-MM-DD: ${key}`;
    if (!mentionedFieldValue(message, key, candidate.valor)) return `Indica explícitamente el campo y su valor para ${key}.`;
  }
  return null;
}
