-- MIGRATION: function `public.queue_performance(hours int)` para el
-- AdminDashboard. Lee `pgboss.job` y devuelve por queue:
--   · completed_count    — jobs en state='completed' en la ventana
--   · failed_count       — jobs en state='failed' (cancelled cuenta como fail)
--   · p50_duration_ms    — mediana del (completedon − createdon) sólo de completed
--   · p95_duration_ms    — percentile 95 de la misma serie
--   · success_rate       — completed / (completed + failed), 0..1
--
-- Por qué RPC y no `supabase.schema('pgboss').from('job')`: pgboss
-- mantiene su propio schema y no exponemos privilegios SELECT al rol
-- `authenticated`. Definimos esta function como SECURITY DEFINER para
-- que el rol service_role pueda llamarla pero los datos crudos no se
-- filtren. El controller la invoca como platform admin (no como
-- tenant), así que no aplicamos filter por company_id acá.

CREATE OR REPLACE FUNCTION public.queue_performance(hours INT DEFAULT 24)
RETURNS TABLE (
  queue_name TEXT,
  completed_count BIGINT,
  failed_count BIGINT,
  p50_duration_ms NUMERIC,
  p95_duration_ms NUMERIC,
  success_rate NUMERIC
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pgboss, public
AS $$
  WITH window_jobs AS (
    SELECT
      name,
      state,
      EXTRACT(EPOCH FROM (completedon - createdon)) * 1000 AS duration_ms
    FROM pgboss.job
    WHERE createdon >= NOW() - (hours || ' hours')::INTERVAL
      AND state IN ('completed', 'failed', 'cancelled')
  )
  SELECT
    name AS queue_name,
    COUNT(*) FILTER (WHERE state = 'completed') AS completed_count,
    COUNT(*) FILTER (WHERE state IN ('failed', 'cancelled')) AS failed_count,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)
      FILTER (WHERE state = 'completed') AS p50_duration_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)
      FILTER (WHERE state = 'completed') AS p95_duration_ms,
    CASE
      WHEN COUNT(*) FILTER (WHERE state IN ('completed', 'failed', 'cancelled')) = 0
        THEN 0
      ELSE COUNT(*) FILTER (WHERE state = 'completed')::NUMERIC
        / COUNT(*) FILTER (WHERE state IN ('completed', 'failed', 'cancelled'))::NUMERIC
    END AS success_rate
  FROM window_jobs
  GROUP BY name
  ORDER BY name;
$$;

-- Permisos: el AdminDashboardController autentica como service_role
-- vía el guard PlatformAdmin. Restringimos el EXECUTE a service_role
-- para que ningún tenant pueda invocarla por accidente.
REVOKE EXECUTE ON FUNCTION public.queue_performance(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_performance(INT) TO service_role;

COMMENT ON FUNCTION public.queue_performance(INT) IS
  'Métricas operacionales por queue de pg-boss en una ventana de N horas. SECURITY DEFINER porque pgboss schema no es accesible desde el rol authenticated.';
