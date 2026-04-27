-- =============================================================================
-- MIGRATION: 20260427000002_seed_min_rest_hours_policy.sql
-- =============================================================================
-- Seedea la policy "11 horas de descanso entre turnos consecutivos" para
-- cada tenant existente, con interpreter min_rest_hours_between_shifts.
--
-- Contexto: el valor 11h vivía como hardcode en
-- ConflictResolutionService.MIN_REST_HOURS pero esa clase no está wireada
-- al scheduler activo (no es provider en ningún módulo). Por ahora la
-- policy queda catalogada — el RuleRephraseService la puede sugerir y
-- el manager la puede ver/editar/desactivar desde la UI. La integración
-- al scheduler activo (WeekScheduleBuilder) queda como trabajo aparte.
--
-- Idempotente: NOT EXISTS por (tenant, interpreter).
-- =============================================================================

INSERT INTO company_policies (
  company_id, text, severity, params, interpreter_id, is_active, created_by
)
SELECT
  c.id,
  'Cada empleado descansa al menos 11 horas entre turnos consecutivos',
  'hard',
  jsonb_build_object('hours', 11),
  'min_rest_hours_between_shifts',
  true,
  'system:seed_20260427'
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM company_policies cp
  WHERE cp.company_id = c.id
    AND cp.interpreter_id = 'min_rest_hours_between_shifts'
    AND cp.deleted_at IS NULL
);
