-- MIGRATION: companies.week_starts_on
--
-- Algunas empresas trabajan con semana lunes-domingo (default ISO,
-- Europa/LATAM mayoría), otras con domingo-sábado (US, retail). El
-- onboarding ya preguntaba por la preferencia pero el valor se
-- descartaba al completar — sin columna donde persistir.
--
-- Default 'monday' para mantener el comportamiento existente sin
-- migración de data. Las companies preexistentes quedan en lunes.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS week_starts_on TEXT NOT NULL DEFAULT 'monday'
    CHECK (week_starts_on IN ('sunday', 'monday'));

COMMENT ON COLUMN public.companies.week_starts_on IS
  'Primer día de la semana laboral (sunday|monday). Afecta cómputo de "semana" en dashboard, generación de horarios y fairness_history.week_start.';
