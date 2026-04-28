import { CompanyPolicy } from '../../../../src/domain/aggregates/company-policy.aggregate';
import { PolicySeverity } from '../../../../src/domain/value-objects/policy-severity.vo';

describe('CompanyPolicy aggregate', () => {
  const severity = PolicySeverity.create('hard');
  const baseInput = {
    companyId: 'co-1',
    text: 'Cada empleado descansa al menos 2 días por semana',
    severity,
  };

  it('creates an active policy with sane defaults', () => {
    const policy = CompanyPolicy.create(baseInput);

    expect(policy.getId()).toMatch(/^[0-9a-f-]{36}$/i);
    expect(policy.getCompanyId()).toBe('co-1');
    expect(policy.getText()).toBe(baseInput.text);
    expect(policy.getSeverity().getValue()).toBe('hard');
    expect(policy.getParams()).toEqual({});
    expect(policy.getInterpreterId()).toBeNull();
    expect(policy.hasInterpreter()).toBe(false);
    expect(policy.getIsActive()).toBe(true);
    expect(policy.getEffectiveFrom()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects text shorter than 10 chars', () => {
    expect(() =>
      CompanyPolicy.create({ ...baseInput, text: 'corta' }),
    ).toThrow(/at least 10 characters/);
  });

  it('rejects effectiveFrom that is not YYYY-MM-DD', () => {
    expect(() =>
      CompanyPolicy.create({ ...baseInput, effectiveFrom: '04/26/2026' }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('attachInterpreter sets interpreterId and params', () => {
    const policy = CompanyPolicy.create(baseInput);
    policy.attachInterpreter('min_rest_days_per_week', {
      days: 2,
      holidayCounts: false,
    });

    expect(policy.hasInterpreter()).toBe(true);
    expect(policy.getInterpreterId()).toBe('min_rest_days_per_week');
    expect(policy.getParams()).toEqual({ days: 2, holidayCounts: false });
  });

  it('detachInterpreter clears interpreterId and params', () => {
    const policy = CompanyPolicy.create(baseInput);
    policy.attachInterpreter('min_rest_days_per_week', { days: 2, holidayCounts: false });

    policy.detachInterpreter();

    expect(policy.hasInterpreter()).toBe(false);
    expect(policy.getInterpreterId()).toBeNull();
    expect(policy.getParams()).toEqual({});
  });

  it('replaceText resets the interpreter (debe re-evaluarse)', () => {
    const policy = CompanyPolicy.create(baseInput);
    policy.attachInterpreter('min_rest_days_per_week', { days: 2, holidayCounts: false });

    policy.replaceText('Cada empleado descansa al menos 3 días por semana');

    expect(policy.getText()).toBe('Cada empleado descansa al menos 3 días por semana');
    expect(policy.hasInterpreter()).toBe(false);
    expect(policy.getParams()).toEqual({});
  });

  it('setActive toggles isActive', () => {
    const policy = CompanyPolicy.create(baseInput);

    policy.setActive(false);
    expect(policy.getIsActive()).toBe(false);

    policy.setActive(true);
    expect(policy.getIsActive()).toBe(true);
  });

  it('toSnapshot returns a plain object decoupled from the aggregate', () => {
    const policy = CompanyPolicy.create(baseInput);
    const snap = policy.toSnapshot();

    expect(snap.id).toBe(policy.getId());
    expect(snap.text).toBe(policy.getText());
    // Mutating the snapshot must not bleed into the aggregate.
    snap.params.foo = 'bar';
    expect(policy.getParams()).toEqual({});
  });
});
