-- =============================================================================
-- shift_assignment_id NULLABLE (Phase 16.1 — manual approval entries)
-- =============================================================================
-- absence_reports y shift_swap_requests tenían `shift_assignment_id NOT NULL`
-- desde el scenario 4, asumiendo que cada reporte/swap originaba en un shift
-- ya generado y conocido. Eso era cierto cuando todo entraba por WhatsApp y el
-- empleado primero veía su turno.
--
-- Con el alta manual desde el panel (CreateAbsenceReportDialog del manager)
-- el caso "el empleado avisó por teléfono que no va mañana, no sé qué turno
-- tiene" es legítimo. El domain ya trataba `assignmentId` como nullable; la
-- BD se quedó atrás.
--
-- Esto solo relaja la columna; el FK sigue siendo CASCADE en absence_reports
-- y existente en shift_swap_requests. Reportes con assignment NULL quedan
-- como "sin turno asociado" — el manager aún ve el evento y puede triagear.
-- =============================================================================

ALTER TABLE absence_reports
  ALTER COLUMN shift_assignment_id DROP NOT NULL;

ALTER TABLE shift_swap_requests
  ALTER COLUMN shift_assignment_id DROP NOT NULL;
