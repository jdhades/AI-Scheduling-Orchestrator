import { SemanticRuleAggregate } from '../../../src/domain/aggregates/semantic-rule.aggregate';
import { RulePriority } from '../../../src/domain/value-objects/rule-priority.vo';
import { RuleType } from '../../../src/domain/value-objects/rule-type.vo';
import { ConflictResolutionEngine } from '../../../src/domain/services/conflict-resolution.engine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRule(
  overrides: {
    id?: string;
    ruleText?: string;
    priority?: RulePriority;
    ruleType?: RuleType;
    companyId?: string;
    isActive?: boolean;
  } = {},
): SemanticRuleAggregate {
  return SemanticRuleAggregate.create({
    id: overrides.id ?? 'rule-id-1',
    ruleText:
      overrides.ruleText ??
      'Los empleados no pueden trabajar más de 8 horas seguidas',
    priority: overrides.priority ?? RulePriority.legal(),
    ruleType: overrides.ruleType ?? RuleType.create('restriction'),
    companyId: overrides.companyId ?? 'company-uuid-1',
    createdBy: 'admin-uuid',
  });
}

function makeVector(value = 0.1): number[] {
  return Array(768).fill(value);
}

// ─── SemanticRuleAggregate ────────────────────────────────────────────────────

describe('SemanticRuleAggregate', () => {
  describe('create() factory', () => {
    it('should create a rule with correct values', () => {
      const rule = makeRule();
      expect(rule.getId()).toBe('rule-id-1');
      expect(rule.getRuleText()).toBe(
        'Los empleados no pueden trabajar más de 8 horas seguidas',
      );
      expect(rule.getPriority().getValue()).toBe(1);
      expect(rule.getRuleType().getValue()).toBe('restriction');
      expect(rule.getIsActive()).toBe(true);
    });

    it('should start without an embedding', () => {
      const rule = makeRule();
      expect(rule.hasEmbedding()).toBe(false);
      expect(rule.getEmbedding()).toBeNull();
    });

    it('should throw for empty rule text', () => {
      expect(() => makeRule({ ruleText: '' })).toThrow();
    });

    it('should throw for rule text shorter than minimum length', () => {
      expect(() => makeRule({ ruleText: 'corto' })).toThrow();
    });

    it('should throw for rule text exceeding 1000 characters', () => {
      expect(() => makeRule({ ruleText: 'x'.repeat(1001) })).toThrow();
    });
  });

  describe('setEmbedding()', () => {
    it('should set embedding when given a valid 768-dim vector', () => {
      const rule = makeRule();
      rule.setEmbedding(makeVector());
      expect(rule.hasEmbedding()).toBe(true);
    });

    it('should throw when given wrong dimension vector', () => {
      const rule = makeRule();
      expect(() => rule.setEmbedding(Array(100).fill(0.1))).toThrow();
    });
  });

  describe('updateText()', () => {
    it('should update rule text and invalidate embedding', () => {
      const rule = makeRule();
      rule.setEmbedding(makeVector());
      expect(rule.hasEmbedding()).toBe(true);

      rule.updateText(
        'Nueva regla: descanso mínimo de 12 horas entre turnos consecutivos',
      );
      expect(rule.getRuleText()).toContain('descanso mínimo');
      expect(rule.hasEmbedding()).toBe(false); // invalidado
    });

    it('should throw when updating to empty text', () => {
      const rule = makeRule();
      expect(() => rule.updateText('')).toThrow();
    });
  });

  describe('deactivate()', () => {
    it('should mark rule as inactive', () => {
      const rule = makeRule();
      expect(rule.getIsActive()).toBe(true);
      rule.deactivate();
      expect(rule.getIsActive()).toBe(false);
    });
  });

  describe('fromPersistence() factory', () => {
    it('should reconstruct a rule from DB row including embedding', () => {
      const rule = SemanticRuleAggregate.fromPersistence({
        id: 'persisted-id',
        company_id: 'c1',
        rule_text: 'Regla reconstituida desde base de datos',
        embedding: makeVector(0.3),
        priority_level: 2,
        rule_type: 'preference',
        created_by: null,
        is_active: true,
        metadata: {},
        structure: null,
        created_at: new Date().toISOString(),
      });

      expect(rule.getId()).toBe('persisted-id');
      expect(rule.getPriority().getValue()).toBe(2);
      expect(rule.hasEmbedding()).toBe(true);
      expect(rule.getIsActive()).toBe(true);
    });

    it('should reconstruct rule with null embedding', () => {
      const rule = SemanticRuleAggregate.fromPersistence({
        id: 'id-2',
        company_id: 'c1',
        rule_text: 'Regla sin embedding todavía pendiente de procesar',
        embedding: null,
        priority_level: 3,
        rule_type: 'requirement',
        created_by: 'admin',
        is_active: false,
        metadata: {},
        structure: null,
        created_at: new Date().toISOString(),
      });

      expect(rule.hasEmbedding()).toBe(false);
      expect(rule.getIsActive()).toBe(false);
    });
  });
});

// ─── ConflictResolutionEngine ─────────────────────────────────────────────────

describe('ConflictResolutionEngine', () => {
  let engine: ConflictResolutionEngine;

  beforeEach(() => {
    engine = new ConflictResolutionEngine();
  });

  it('should return empty array for no rules', () => {
    expect(engine.resolveRules([])).toEqual([]);
  });

  it('should return single rule unchanged', () => {
    const rule = makeRule();
    const result = engine.resolveRules([rule]);
    expect(result).toHaveLength(1);
    expect(result[0].getId()).toBe(rule.getId());
  });

  it('keeps both legal and semantic restrictions at different priorities (no auto-conflict)', () => {
    // Tras eliminar el branch `priority_clash` en ConflictResolutionEngine
    // (reglas con distinta prioridad ya no se descartan entre sí), las 2
    // reglas coexisten. El motor de scheduling aplica ambas; si contradicen
    // lo mismo el efecto neto es el mismo (ambas bloquean).
    const legal = makeRule({
      id: 'legal-1',
      priority: RulePriority.legal(),
      ruleType: RuleType.create('restriction'),
    });
    const semantic = makeRule({
      id: 'semantic-1',
      priority: RulePriority.semantic(),
      ruleType: RuleType.create('restriction'),
    });
    const result = engine.resolveRules([semantic, legal]);
    const ids = result.map((r) => r.getId());
    expect(ids).toContain('legal-1');
    expect(ids).toContain('semantic-1');
  });

  it('should keep both restriction and preference when they are at the same priority (no conflict)', () => {
    // Una regla preference NO es blocking, por tanto no hay conflicto entre
    // una restriction (blocking) y una preference (no-blocking) del mismo nivel.
    // Ambas sobreviven — la preference se aplica como "orientativa".
    const restriction = makeRule({
      id: 'res-1',
      priority: RulePriority.semantic(),
      ruleType: RuleType.create('restriction'),
    });
    const preference = makeRule({
      id: 'pref-1',
      priority: RulePriority.semantic(),
      ruleType: RuleType.create('preference'),
    });
    const result = engine.resolveRules([preference, restriction]);
    const ids = result.map((r) => r.getId());
    // Ambas sobreviven — restriction orientará, preference es complementaria
    expect(ids).toContain('res-1');
    expect(ids).toContain('pref-1');
  });

  it('keeps both rules when same priority and both blocking (no auto-conflict)', () => {
    // Tras el fix: priority+blocking no es evidencia de contradicción real.
    // Dos restricciones pueden coexistir (ej. "feriado 16/4" + "día libre rotativo").
    const restriction = makeRule({
      id: 'res-1',
      priority: RulePriority.semantic(),
      ruleType: RuleType.create('restriction'),
    });
    const requirement = makeRule({
      id: 'req-1',
      priority: RulePriority.semantic(),
      ruleType: RuleType.create('requirement'),
    });
    const result = engine.resolveRules([restriction, requirement]);
    expect(result).toHaveLength(2);
  });

  it('no escalation triggered — engine never eliminates rules anymore', () => {
    const r1 = makeRule({
      id: 'r1',
      priority: RulePriority.legal(),
      ruleType: RuleType.create('restriction'),
    });
    const r2 = makeRule({
      id: 'r2',
      priority: RulePriority.legal(),
      ruleType: RuleType.create('restriction'),
    });
    engine.resolveRules([r1, r2]);
    const escalations = engine.getLastEscalations();
    expect(escalations.length).toBe(0);
  });

  it('should sort rules by priority ascending (legal first)', () => {
    const pref = makeRule({
      id: 'pref',
      priority: RulePriority.preference(),
      ruleType: RuleType.create('preference'),
    });
    const legal = makeRule({
      id: 'legal',
      priority: RulePriority.legal(),
      ruleType: RuleType.create('requirement'),
    });
    const result = engine.resolveRules([pref, legal]);
    // Both non-conflicting (different types), both survive
    expect(result[0].getId()).toBe('legal');
  });

  it('should not escalate when there is no conflict', () => {
    const r1 = makeRule({
      id: 'r1',
      priority: RulePriority.legal(),
      ruleType: RuleType.create('restriction'),
    });
    const r2 = makeRule({
      id: 'r2',
      priority: RulePriority.preference(),
      ruleType: RuleType.create('preference'),
    });
    engine.resolveRules([r1, r2]);
    expect(engine.getLastEscalations()).toHaveLength(0);
  });
});
