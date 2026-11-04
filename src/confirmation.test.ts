import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmedChangesError, isExplicitConfirmation, type ConfirmedContract } from './confirmation.js';

const original: ConfirmedContract = {
  valor: { valor: 0, confianza: 0.5 },
  fecha_inicio: { valor: null, confianza: 0 },
  fecha_fin: { valor: null, confianza: 0 },
  requiere_poliza: { valor: true, confianza: 0.5 },
};
const withFields = (updates: Partial<ConfirmedContract>): ConfirmedContract => ({ ...original, ...updates } as ConfirmedContract);

test('denial is never an explicit confirmation', () => {
  assert.equal(isExplicitConfirmation('Confirmo que no se registre el contrato'), false);
  assert.equal(isExplicitConfirmation('Confirmo que no se modifique el contrato'), false);
  assert.equal(isExplicitConfirmation('Confirmo, pero no autorizo el registro'), false);
  assert.equal(isExplicitConfirmation('Confirmo, no.'), false);
  assert.equal(isExplicitConfirmation('Confirmo que no'), false);
  assert.equal(isExplicitConfirmation('Confirmo; no'), false);
  assert.equal(isExplicitConfirmation('Confirmo que no se cambie el valor'), false);
  assert.equal(isExplicitConfirmation('Confirmo pero cancelo el registro'), false);
  assert.equal(isExplicitConfirmation('Confirmo, espera antes de registrar'), false);
  assert.equal(isExplicitConfirmation('Confirmo requiere póliza: no; no registres todavía'), false);
  assert.equal(isExplicitConfirmation('Confirmo requiere póliza: no se registre'), false);
  assert.equal(isExplicitConfirmation('No, confirmo después'), false);
  assert.equal(isExplicitConfirmation('Sí, confirmo el registro'), true);
  assert.equal(isExplicitConfirmation('Confirmo requiere póliza: no'), true);
});

test('dates cannot accidentally confirm an unrelated zero or another field', () => {
  const changed = withFields({ valor: { valor: 100, confianza: 0.5 } });
  assert.match(confirmedChangesError('Confirmo fecha inicio 2026-08-31 y fecha fin 2027-08-31', original, changed) ?? '', /valor/);
  const zeroOriginal = withFields({ valor: { valor: 100, confianza: 0.5 } });
  assert.match(confirmedChangesError('Confirmo fecha inicio 2026-08-31', zeroOriginal, original) ?? '', /valor/);
  assert.match(confirmedChangesError('Confirmo valor 1000', original, changed) ?? '', /valor/);
});

test('accepts explicit field-value pairs and preserves extraction confidence', () => {
  const edited = withFields({ fecha_inicio: { valor:'2026-08-31', confianza:0 }, fecha_fin:{valor:'2027-08-31',confianza:0}, requiere_poliza:{valor:false,confianza:0.5} });
  assert.equal(confirmedChangesError('Confirmo fecha inicio 2026-08-31, fecha fin: 2027-08-31 y requiere póliza: no', original, edited), null);
  const valueEdit = withFields({ valor: { valor:100, confianza:0.5 } });
  assert.equal(confirmedChangesError('Confirmo valor: 100', original, valueEdit), null);
});

test('rejects invalid dates, confidence tampering, and missing fields', () => {
  const date = withFields({ fecha_inicio: { valor:'2026-02-31', confianza:0 } });
  assert.match(confirmedChangesError('Confirmo fecha inicio 2026-02-31', original, date) ?? '', /fecha/i);
  const confidence = withFields({ valor: { valor:0, confianza:1 } });
  assert.match(confirmedChangesError('Confirmo valor 0', original, confidence) ?? '', /confianza/);
  const {valor: _removed, ...incomplete}=original;
  assert.match(confirmedChangesError('Confirmo todo', original, incomplete) ?? '', /completo/);
});
