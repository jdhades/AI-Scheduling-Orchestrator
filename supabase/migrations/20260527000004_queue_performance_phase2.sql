-- MIGRATION: queue_performance fase 2 — sparkline 7d + breakdown por tenant.
--
-- Dos funciones RPC nuevas, complementarias a `queue_performance(hours)`:
--
--  · queue_performance_daily(days INT)
--      Buckets diarios por queue: para cada (queue, day en últimos N días)
--      cuántos jobs completed/failed. Útil para sparkline.
--
--  · queue_performance_by_tenant(hours INT)
--      Agrupado por company_id (extraído del payload jsonb `data->>'companyId'`)
--      + queue: cuántos jobs y latencias. El admin ve qué tenants están
--      generando más carga / más errores.
--
-- Ambas SECURITY DEFINER, sólo EXECUTE para service_role. Igual que la
-- función fase 1.

-- ─── Sparkline diario ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.queue_performance_daily(days INT DEFAULT 7)
RETURNS TABLE (
  bucket_date DATE,
  queue_name TEXT,
  completed_count BIGINT,
  failed_count BIGINT
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pgboss, public
AS $$
  WITH window_jobs AS (
    SELECT
      (created_on AT TIME ZONE 'UTC')::DATE AS bucket_date,
      name,
      state
    FROM pgboss.job
    WHERE created_on >= NOW() - (days || ' days')::INTERVAL
      AND state IN ('completed', 'failed', 'cancelled')
  )
  SELECT
    bucket_date,
    name AS queue_name,
    COUNT(*) FILTER (WHERE state = 'completed') AS completed_count,
    COUNT(*) FILTER (WHERE state IN ('failed', 'cancelled')) AS failed_count
  FROM window_jobs
  GROUP BY bucket_date, name
  ORDER BY bucket_date ASC, name ASC;
$$;

REVOKE EXECUTE ON FUNCTION public.queue_performance_daily(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_performance_daily(INT) TO service_role;

COMMENT ON FUNCTION public.queue_performance_daily(INT) IS
  'Buckets diarios de queue performance para el sparkline 7d del AdminDashboard.';

-- ─── Breakdown por tenant ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.queue_performance_by_tenant(hours INT DEFAULT 24)
RETURNS TABLE (
  company_id UUID,
  company_name TEXT,
  queue_name TEXT,
  completed_count BIGINT,
  failed_count BIGINT,
  p50_duration_ms NUMERIC,
  p95_duration_ms NUMERIC
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pgboss, public
AS $$
  WITH window_jobs AS (
    SELECT
      (data->>'companyId')::UUID AS company_id,
      name,
      state,
      EXTRACT(EPOCH FROM (completed_on - created_on)) * 1000 AS duration_ms
    FROM pgboss.job
    WHERE created_on >= NOW() - (hours || ' hours')::INTERVAL
      AND state IN ('completed', 'failed', 'cancelled')
      AND data->>'companyId' IS NOT NULL
  )
  SELECT
    wj.company_id,
    c.name AS company_name,
    wj.name AS queue_name,
    COUNT(*) FILTER (WHERE wj.state = 'completed') AS completed_count,
    COUNT(*) FILTER (WHERE wj.state IN ('failed', 'cancelled')) AS failed_count,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY wj.duration_ms)
      FILTER (WHERE wj.state = 'completed') AS p50_duration_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY wj.duration_ms)
      FILTER (WHERE wj.state = 'completed') AS p95_duration_ms
  FROM window_jobs wj
  LEFT JOIN public.companies c ON c.id = wj.company_id
  GROUP BY wj.company_id, c.name, wj.name
  ORDER BY completed_count DESC, failed_count DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.queue_performance_by_tenant(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_performance_by_tenant(INT) TO service_role;

COMMENT ON FUNCTION public.queue_performance_by_tenant(INT) IS
  'Carga + latencia por (tenant, queue) en las últimas N horas. Lee data->>companyId del payload jsonb del job.';
