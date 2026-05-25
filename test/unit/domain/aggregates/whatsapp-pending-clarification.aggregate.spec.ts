import { WhatsappPendingClarification } from '../../../../src/domain/aggregates/whatsapp-pending-clarification.aggregate';

describe('WhatsappPendingClarification aggregate', () => {
  const baseInput = {
    employeeId: 'e-1',
    companyId: 'c-1',
    targetKind: 'policy' as const,
    originalText: 'que descansen aparte del feriado',
    suggestions: [
      { id: 's1', suggestedText: 'opción A' },
      { id: 's2', suggestedText: 'opción B' },
      { id: 's3', suggestedText: 'opción C' },
    ],
  };

  it('crea con expiresAt = now + 10min por default', () => {
    const before = Date.now();
    const entry = WhatsappPendingClarification.create(baseInput);
    const after = Date.now();

    expect(entry.getId()).toMatch(/^[0-9a-f-]{36}$/i);
    expect(entry.getExpiresAt().getTime()).toBeGreaterThanOrEqual(
      before + 600 * 1000,
    );
    expect(entry.getExpiresAt().getTime()).toBeLessThanOrEqual(
      after + 600 * 1000 + 100,
    );
    expect(entry.getResolvedAt()).toBeNull();
    expect(entry.isResolved()).toBe(false);
  });

  it('respeta ttlSeconds custom', () => {
    const entry = WhatsappPendingClarification.create({
      ...baseInput,
      ttlSeconds: 60,
    });
    const diff =
      entry.getExpiresAt().getTime() - entry.getCreatedAt().getTime();
    expect(diff).toBeGreaterThanOrEqual(60 * 1000);
    expect(diff).toBeLessThanOrEqual(60 * 1000 + 50);
  });

  it('rechaza suggestions vacías', () => {
    expect(() =>
      WhatsappPendingClarification.create({ ...baseInput, suggestions: [] }),
    ).toThrow(/at least one suggestion/);
  });

  it('pickByNumber es 1-indexed (como WhatsApp) y devuelve null fuera de rango', () => {
    const entry = WhatsappPendingClarification.create(baseInput);
    expect(entry.pickByNumber(1)?.id).toBe('s1');
    expect(entry.pickByNumber(2)?.id).toBe('s2');
    expect(entry.pickByNumber(3)?.id).toBe('s3');
    expect(entry.pickByNumber(0)).toBeNull();
    expect(entry.pickByNumber(4)).toBeNull();
    expect(entry.pickByNumber(-1)).toBeNull();
  });

  it('resolve marca resolvedAt — segunda llamada es idempotente', () => {
    const entry = WhatsappPendingClarification.create(baseInput);
    expect(entry.isResolved()).toBe(false);

    const t1 = new Date('2026-04-27T10:00:00Z');
    entry.resolve(t1);
    expect(entry.isResolved()).toBe(true);
    expect(entry.getResolvedAt()).toEqual(t1);

    // Segunda llamada con timestamp distinto NO modifica.
    const t2 = new Date('2026-04-27T11:00:00Z');
    entry.resolve(t2);
    expect(entry.getResolvedAt()).toEqual(t1);
  });

  it('isExpired refleja la comparación con el tiempo pasado', () => {
    const entry = WhatsappPendingClarification.create({
      ...baseInput,
      ttlSeconds: 1,
    });
    expect(
      entry.isExpired(new Date(entry.getCreatedAt().getTime() + 500)),
    ).toBe(false);
    expect(
      entry.isExpired(new Date(entry.getCreatedAt().getTime() + 1500)),
    ).toBe(true);
  });

  it('toSnapshot devuelve un objeto plano y un clon de suggestions', () => {
    const entry = WhatsappPendingClarification.create(baseInput);
    const snap = entry.toSnapshot();
    expect(snap.id).toBe(entry.getId());
    expect(snap.suggestions).toHaveLength(3);
    // Mutar snap.suggestions NO afecta el aggregate.
    snap.suggestions[0].suggestedText = 'mutado';
    expect(entry.getSuggestions()[0].suggestedText).toBe('opción A');
  });
});
