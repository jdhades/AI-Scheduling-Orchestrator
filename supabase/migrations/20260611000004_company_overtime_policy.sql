-- MIGRATION: company overtime policy (módulo de marcaciones / hoja de horas)
--
-- Define cómo se calculan las horas extra del tenant: diaria, semanal, ambas o
-- ninguna, con su umbral en horas. La hoja de horas usa esto para los subtotales.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS overtime_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (overtime_mode IN ('none', 'daily', 'weekly', 'both')),
  ADD COLUMN IF NOT EXISTS overtime_daily_threshold_hours NUMERIC NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS overtime_weekly_threshold_hours NUMERIC NOT NULL DEFAULT 40;

COMMENT ON COLUMN public.companies.overtime_mode IS
  'Cálculo de horas extra: none | daily | weekly | both. La hoja de horas lo usa para los subtotales.';
