import { describe, expect, it } from 'vitest';
import { planNameOf } from '../web/src/logic';

describe('planNameOf', () => {
  it('a számlából jött név helyett „Havi díj”, a saját név marad', () => {
    expect(planNameOf('Pharmazone WS Kft. · Penge / 2026-000053')).toBe('Havi díj');
    expect(planNameOf('Számla Penge / 2026-000053')).toBe('Havi díj');
    expect(planNameOf('Marketing tanácsadás')).toBe('Marketing tanácsadás');
    expect(planNameOf('Anthropic')).toBe('Anthropic');
  });
});
