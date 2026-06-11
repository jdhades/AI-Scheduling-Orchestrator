-- MIGRATION: time_clock_events.source — permitir 'auto'
--
-- El job de auto-corte de overbreak inserta un break_end con source='auto', pero
-- el CHECK original solo permitía gps/nfc/manual/biometric → el insert fallaba.

ALTER TABLE public.time_clock_events
  DROP CONSTRAINT IF EXISTS time_clock_events_source_check;

ALTER TABLE public.time_clock_events
  ADD CONSTRAINT time_clock_events_source_check
  CHECK (source IN ('gps', 'nfc', 'manual', 'biometric', 'auto'));
