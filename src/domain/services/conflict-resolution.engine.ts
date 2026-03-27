import { Injectable } from '@nestjs/common';
import { SemanticRuleAggregate } from '../aggregates/semantic-rule.aggregate';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface RuleConflict {
  ruleA: SemanticRuleAggregate;
  ruleB: SemanticRuleAggregate;
  conflictType: 'direct_contradiction' | 'priority_clash' | 'context_overlap';
}

export interface ConflictResolutionEngineResult {
  winner: SemanticRuleAggregate;
  loser: SemanticRuleAggregate;
  reason: string;
  requiresEscalation: boolean;
}

/**
 * ConflictResolutionEngine — Domain Service (Escenario 3)
 *
 * Resuelve contradicciones entre reglas semánticas recuperadas del motor RAG.
 * Extiende el ConflictResolutionService del Escenario 2 añadiendo la capa de
 * resolución específica para reglas semánticas (nivel 2 y 3 de la jerarquía).
 *
 * Jerarquía completa (5 capas en E3 vs 4 en E2):
 *   1. Legal (ConflictResolutionService E2)  — EU Working Time Directive
 *   2. Semántica-Restricción (este engine)   — restricciones en lenguaje natural
 *   3. Skill Matrix (ConflictResolutionService E2) — SkillValidationPolicy
 *   4. Semántica-Preferencia (este engine)   — preferencias en lenguaje natural
 *   5. Fairness Score (ConflictResolutionService E2) — FairnessThresholdGuard
 *
 * Reglas de resolución (deterministas y auditables):
 *   1. Mayor prioridad numérica (1 > 2 > 3) → gana
 *   2. Misma prioridad: tipo blocking (restriction/requirement) > preference
 *   3. Misma prioridad + mismo tipo → escalar a revisor humano
 */
@Injectable()
export class ConflictResolutionEngine {
  /**
   * Recibe un conjunto de reglas semánticas recuperadas y elimina las
   * contradictorias respetando la jerarquía normativa.
   *
   * @returns Reglas supervivientes ordenadas por prioridad (legal primero)
   */
  resolveRules(rules: SemanticRuleAggregate[]): SemanticRuleAggregate[] {
    if (rules.length <= 1) return [...rules];

    // 1. Ordenar por prioridad ascendente (1=legal primero)
    const sorted = [...rules].sort(
      (a, b) => a.getPriority().getValue() - b.getPriority().getValue(),
    );

    // 2. Detectar pares conflictivos
    const conflicts = this.detectConflicts(sorted);
    if (conflicts.length === 0) return sorted;

    // 3. Resolver cada conflicto y acumular perdedores
    const eliminated = new Set<string>();
    const escalations: ConflictResolutionEngineResult[] = [];

    for (const conflict of conflicts) {
      const resolution = this.resolve(conflict);
      eliminated.add(resolution.loser.getId());

      if (resolution.requiresEscalation) {
        escalations.push(resolution);
      }
    }

    // 4. Las escalaciones solo se loggean — no bloquean la ejecución
    // El caller (GenerateScheduleHandler) puede persistirlas en rule_conflicts
    if (escalations.length > 0) {
      // Disponible para quien inyecte este servicio
      this._lastEscalations = escalations;
    }

    return sorted.filter((r) => !eliminated.has(r.getId()));
  }

  /**
   * Escalaciones del último llamado a resolveRules().
   * El handler de aplicación las persiste en la tabla rule_conflicts.
   */
  getLastEscalations(): ConflictResolutionEngineResult[] {
    return [...this._lastEscalations];
  }

  // ─── Privados ──────────────────────────────────────────────────────────────

  private _lastEscalations: ConflictResolutionEngineResult[] = [];

  private detectConflicts(rules: SemanticRuleAggregate[]): RuleConflict[] {
    const conflicts: RuleConflict[] = [];

    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const conflictType = this.getConflictType(rules[i], rules[j]);
        if (conflictType) {
          conflicts.push({ ruleA: rules[i], ruleB: rules[j], conflictType });
        }
      }
    }

    return conflicts;
  }

  /**
   * Determina si dos reglas están en conflicto.
   *
   * Dos reglas son conflictivas si:
   *   - Ambas son de tipo blocking (restriction/requirement)
   *   - Tienen la misma prioridad
   *
   * Regla-preferencia vs cualquier otra cosa → no conflicto (se aplican ambas)
   */
  private getConflictType(
    a: SemanticRuleAggregate,
    b: SemanticRuleAggregate,
  ): RuleConflict['conflictType'] | null {
    const aBlocks = a.getRuleType().isBlocking();
    const bBlocks = b.getRuleType().isBlocking();
    const samePriority = a.getPriority().equals(b.getPriority());

    if (aBlocks && bBlocks && samePriority) {
      return 'direct_contradiction';
    }

    if (!samePriority && (aBlocks || bBlocks)) {
      return 'priority_clash';
    }

    return null;
  }

  private resolve(conflict: RuleConflict): ConflictResolutionEngineResult {
    const { ruleA, ruleB } = conflict;
    const priorityA = ruleA.getPriority();
    const priorityB = ruleB.getPriority();

    // Regla 1: mayor prioridad gana
    if (priorityA.isHigherThan(priorityB)) {
      return this.buildResult(ruleA, ruleB, 'higher_priority', false);
    }
    if (priorityB.isHigherThan(priorityA)) {
      return this.buildResult(ruleB, ruleA, 'higher_priority', false);
    }

    // Regla 2: misma prioridad — tipo blocking gana sobre preference
    const aRestricts = ruleA.getRuleType().isRestriction();
    const bRestricts = ruleB.getRuleType().isRestriction();

    if (aRestricts && !bRestricts) {
      return this.buildResult(
        ruleA,
        ruleB,
        'restriction_over_preference',
        false,
      );
    }
    if (bRestricts && !aRestricts) {
      return this.buildResult(
        ruleB,
        ruleA,
        'restriction_over_preference',
        false,
      );
    }

    // Regla 3: misma prioridad + mismo tipo → escalar
    // Se mantiene ruleA (más reciente en el orden de sort) pero se marca escalación
    return this.buildResult(
      ruleA,
      ruleB,
      'same_priority_same_type_escalated',
      true,
    );
  }

  private buildResult(
    winner: SemanticRuleAggregate,
    loser: SemanticRuleAggregate,
    reason: string,
    requiresEscalation: boolean,
  ): ConflictResolutionEngineResult {
    return { winner, loser, reason, requiresEscalation };
  }
}
