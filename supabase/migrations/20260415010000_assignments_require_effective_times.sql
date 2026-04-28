-- =============================================================================
-- MIGRATION: 20260415010000_assignments_require_effective_times.sql
--
-- En el nuevo modelo employee-first cada ShiftAssignment lleva dentro de sí
-- sus horas efectivas (start/end). Siguen llamándose `actual_start_time` y
-- `actual_end_time` pero dejan de ser "override opcional del template" y
-- pasan a ser la fuente de verdad para las horas del turno. Esto elimina
-- el JOIN a shift_templates para consultar "¿a qué hora sale Juan?" y hace
-- que un cambio del manager ("Juan sale a las 13:00 en vez de 16:00") sea
-- una simple edición del row.
-- =============================================================================

-- 1. Backfill: cualquier row existente sin actual_* (no debería haber ninguna
--    porque ya purgamos datos en el rework, pero curamos por si acaso).
UPDATE shift_assignments sa
SET
  actual_start_time = COALESCE(
    sa.actual_start_time,
    (sa.date + st.start_time)::timestamptz
  ),
  actual_end_time = COALESCE(
    sa.actual_end_time,
    CASE
      WHEN st.end_time <= st.start_time
        THEN ((sa.date + st.end_time)::timestamp + INTERVAL '1 day')::timestamptz
      ELSE (sa.date + st.end_time)::timestamptz
    END
  )
FROM shift_templates st
WHERE sa.template_id = st.id
  AND (sa.actual_start_time IS NULL OR sa.actual_end_time IS NULL);

-- 2. NOT NULL — el aggregate ahora las obliga.
ALTER TABLE shift_assignments ALTER COLUMN actual_start_time SET NOT NULL;
ALTER TABLE shift_assignments ALTER COLUMN actual_end_time SET NOT NULL;

-- 3. Ajustar el CHECK para que coincida con la nueva semántica
--    (antes permitía ambos null; ahora no).
ALTER TABLE shift_assignments DROP CONSTRAINT IF EXISTS shift_assignments_actual_time_check;
ALTER TABLE shift_assignments ADD CONSTRAINT shift_assignments_actual_time_check
  CHECK (actual_end_time > actual_start_time);

COMMENT ON COLUMN shift_assignments.actual_start_time IS
  'Hora efectiva de inicio del turno. Se inicializa desde template.start_time + date '
  'al generar el horario. El manager puede editarla para cambios puntuales.';
COMMENT ON COLUMN shift_assignments.actual_end_time IS
  'Hora efectiva de fin del turno (cruza medianoche si correspondía). Editable '
  'por el manager sin tocar el template.';
