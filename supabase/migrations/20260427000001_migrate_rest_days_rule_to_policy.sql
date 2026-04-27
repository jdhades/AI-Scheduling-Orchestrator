-- =============================================================================
-- MIGRATION: 20260427000001_migrate_rest_days_rule_to_policy.sql
-- =============================================================================
-- Cleanup post-rollout de Company Policies. Hasta ahora, una regla del
-- tipo "2 días de descanso para el empleado aparte del feriado" vivía en
-- semantic_rules pero el matcher schema no la podía estructurar (es un
-- counting/distribution constraint, le sale intent=complex). En commit 2
-- se seedeó la CompanyPolicy equivalente con interpreter
-- min_rest_days_per_week. Esta migración soft-deletea la semantic_rule
-- original para que el manager no vea duplicada la información.
--
-- Safety: solo soft-deletea si existe una company_policy activa con el
-- interpreter equivalente para el mismo tenant. Si por alguna razón no
-- se seedeó (por ejemplo, otra rama del proyecto sin commit 2 aplicado),
-- la rule queda intacta — mejor un "Sin estructura" molesto que perder
-- contexto del manager.
--
-- Idempotente: re-correr la migración no afecta filas ya soft-deleted.
-- =============================================================================

UPDATE semantic_rules sr
SET
  is_active = false,
  deleted_at = NOW()
WHERE
  sr.deleted_at IS NULL
  AND sr.rule_text ILIKE '%2 d_a%descanso%aparte%feriado%'
  AND EXISTS (
    SELECT 1
    FROM company_policies cp
    WHERE cp.company_id = sr.company_id
      AND cp.interpreter_id = 'min_rest_days_per_week'
      AND cp.deleted_at IS NULL
      AND cp.is_active = true
  );

-- Auditoría manual: si querés ver qué se migró, después de aplicar:
--
--   SELECT id, rule_text, deleted_at FROM semantic_rules
--   WHERE rule_text ILIKE '%2 d_a%descanso%aparte%feriado%';
--
-- (deleted_at NOT NULL ⇒ migrada).
