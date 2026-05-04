-- =============================================================================
-- Schedule generation lock — Fase 0 Async Migration
-- =============================================================================
-- Mutex de aplicación para serializar runs de `generate_schedule` por
-- (company_id, week_start). Impide doble disparo concurrente que llevaría
-- a duplicación de assignments o gasto inútil de Qwen.
--
-- Política: rechazar el segundo request mientras el primero está en curso.
--
-- Stale TTL: 5 min — si el orchestrator crashea entre acquire y release,
-- el siguiente request a los 5min puede tomar el lock asumiendo que el
-- job anterior está muerto. El servicio lo gestiona en código, esta tabla
-- solo guarda estado.
--
-- Esto es la red de seguridad del path SÍNCRONO. Cuando se active el
-- worker (Fase 1), la concurrencia se cubre con pg-boss singletonKey y
-- esta tabla queda como respaldo de cualquier flujo legacy que no haya
-- migrado.
-- =============================================================================

CREATE TABLE IF NOT EXISTS schedule_generation_locks (
  company_id  UUID NOT NULL,
  week_start  DATE NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acquired_by TEXT, -- 'http' / 'whatsapp:<phone>' / 'system' — informativo
  PRIMARY KEY (company_id, week_start)
);

-- Index para limpieza eficiente de stale locks (queries del tipo
-- "todos los locks > 5 min" en jobs de mantenimiento futuros).
CREATE INDEX IF NOT EXISTS schedule_generation_locks_acquired_at_idx
  ON schedule_generation_locks (acquired_at);
