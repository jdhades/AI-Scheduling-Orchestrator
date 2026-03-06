-- =============================================================================
-- MIGRATION: 20240302000000_scenario2_scheduling_engine.sql
-- AI Scheduling Orchestrator — Escenario 2: Scheduling Engine + Strategy Pattern
--
-- Este archivo extiende el esquema inicial (20240301000000) con las columnas
-- necesarias para el motor de scheduling, ski-matrix validation y fairness tracking.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- ALTER TABLE: shifts
--
-- Añade:
--   required_skill_level        — nivel mínimo requerido (junior/intermediate/senior)
--   required_experience_months  — experiencia mínima en meses
--
-- Nota: required_skill_id y demand_score/undesirable_weight ya existen en la
-- migración inicial (20240301000000). Solo se agregan las columnas faltantes.
-- ---------------------------------------------------------------------------
ALTER TABLE shifts
    ADD COLUMN IF NOT EXISTS required_skill_level        TEXT
        CHECK (required_skill_level IN ('junior', 'intermediate', 'senior')),
    ADD COLUMN IF NOT EXISTS required_experience_months  INTEGER NOT NULL DEFAULT 0
        CHECK (required_experience_months >= 0);


-- ---------------------------------------------------------------------------
-- ALTER TABLE: shift_assignments
--
-- La tabla original usaba (shift_id, employee_id) como PK compuesta y no tenía
-- id propio ni trazabilidad de la estrategia usada.
--
-- Añade:
--   id                   — UUID propio para permitir referencias directas
--   company_id           — redundante pero necesario para RLS sin JOIN
--   assigned_by_strategy — cuál estrategia generó esta asignación (auditoría)
--
-- Migración conservadora: los cambios son aditivos, no destructivos.
-- ---------------------------------------------------------------------------
ALTER TABLE shift_assignments
    ADD COLUMN IF NOT EXISTS id                   UUID NOT NULL DEFAULT uuid_generate_v4(),
    ADD COLUMN IF NOT EXISTS company_id           UUID REFERENCES companies(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS assigned_by_strategy TEXT
        CHECK (assigned_by_strategy IN ('cost', 'fairness', 'hybrid'));

-- Crear índice para búsquedas por empresa + semana (query frecuente en GetCompanyScheduleQuery)
CREATE INDEX IF NOT EXISTS shift_assignments_company_idx
    ON shift_assignments(company_id);

-- Backfill company_id desde shifts para filas existentes
UPDATE shift_assignments sa
SET company_id = s.company_id
FROM shifts s
WHERE sa.shift_id = s.id
  AND sa.company_id IS NULL;

-- Una vez backfilleado, hacer NOT NULL
ALTER TABLE shift_assignments
    ALTER COLUMN company_id SET NOT NULL;

-- Comentario: assigned_by_ai (columna original) se mantiene por retrocompatibilidad.
-- assigned_by_strategy es más específico para el Escenario 2.


-- ---------------------------------------------------------------------------
-- ALTER TABLE: fairness_history
--
-- La tabla original solo tenía `score` (valor normalizado final).
-- El Escenario 2 necesita los componentes individuales para:
--   1. Recalcular el score con diferentes fórmulas sin perder datos
--   2. Mostrar desglose al manager (horas, noches, fines de semana)
--   3. Auditoría determinística del algoritmo de fairness
--
-- Añade:
--   hours_worked          — horas trabajadas en la semana
--   night_shift_count     — número de turnos nocturnos
--   weekend_count         — número de turnos en fin de semana
--   voluntary_extra_shifts — turnos aceptados voluntariamente (reducen score)
-- ---------------------------------------------------------------------------
ALTER TABLE fairness_history
    ADD COLUMN IF NOT EXISTS hours_worked           NUMERIC(6,2) NOT NULL DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS night_shift_count      INTEGER NOT NULL DEFAULT 0
        CHECK (night_shift_count >= 0),
    ADD COLUMN IF NOT EXISTS weekend_count          INTEGER NOT NULL DEFAULT 0
        CHECK (weekend_count >= 0),
    ADD COLUMN IF NOT EXISTS voluntary_extra_shifts INTEGER NOT NULL DEFAULT 0
        CHECK (voluntary_extra_shifts >= 0);

-- Nota: la columna `score` original se mantiene para retrocompatibilidad.
-- El FairnessCalculator recalcula el score normalizado en memoria desde los componentes.

-- Renombrar undesirable_count a nombre consistente (la columna original ya existe)
-- No se renombra para evitar breaking changes, se deja como está.


-- ---------------------------------------------------------------------------
-- ÍNDICES adicionales para performance del SchedulingEngine
-- ---------------------------------------------------------------------------

-- Búsquedas de turnos por empresa + rango de fechas (findByCompanyAndWeek)
CREATE INDEX IF NOT EXISTS shifts_company_start_time_idx
    ON shifts(company_id, start_time);

-- Búsquedas de historial de fairness por empresa + semana (findByWeek en GenerateScheduleHandler)
CREATE INDEX IF NOT EXISTS fairness_history_company_week_idx
    ON fairness_history(company_id, week_start);

-- Búsquedas de asignaciones por empleado (GetEmployeeCalendarQuery)
CREATE INDEX IF NOT EXISTS shift_assignments_employee_idx
    ON shift_assignments(employee_id);


-- ---------------------------------------------------------------------------
-- COMENTARIOS DE COLUMNAS (documentación en DB)
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN shifts.required_skill_level IS
    'Nivel mínimo requerido para el turno: junior / intermediate / senior';
COMMENT ON COLUMN shifts.required_experience_months IS
    'Meses de experiencia mínima que debe tener el empleado asignado';

COMMENT ON COLUMN shift_assignments.assigned_by_strategy IS
    'Estrategia del SchedulingEngine que generó la asignación: cost / fairness / hybrid';
COMMENT ON COLUMN shift_assignments.company_id IS
    'Redundante para RLS eficiente sin JOIN a shifts. Siempre = shifts.company_id';

COMMENT ON COLUMN fairness_history.hours_worked IS
    'Horas trabajadas en la semana. Componente del FairnessCalculator';
COMMENT ON COLUMN fairness_history.night_shift_count IS
    'Número de turnos nocturnos (startTime 22:00-06:00). Peso ×1.5 en la fórmula';
COMMENT ON COLUMN fairness_history.weekend_count IS
    'Número de turnos en sábado/domingo. Peso ×1.2 en la fórmula';
COMMENT ON COLUMN fairness_history.voluntary_extra_shifts IS
    'Turnos aceptados voluntariamente fuera del schedule. Descuento -0.5 en la fórmula';
