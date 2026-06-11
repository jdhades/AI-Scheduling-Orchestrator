-- MIGRATION: limpiar flags de GPS viejos en descansos
--
-- Los descansos ya no se validan por geofence/GPS (fix 33e094b), pero los break
-- events creados ANTES de ese fix quedaron con anomaly_reason GPS en
-- pending_review, ensuciando la cola de revisión. Los resolvemos a 'valid'
-- (su única anomalía válida es overbreak, que NO se toca acá).

UPDATE public.time_clock_events
SET validation_status = 'valid',
    anomaly_reason = NULL
WHERE type IN ('break_start', 'break_end')
  AND validation_status = 'pending_review'
  AND anomaly_reason IN ('low_accuracy', 'outside_geofence');
