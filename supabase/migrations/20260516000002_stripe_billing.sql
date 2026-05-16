-- =============================================================================
-- Stripe billing integration
-- =============================================================================
-- Columnas para linkear cada company con su Customer/Subscription en
-- Stripe, más tabla de idempotency para webhooks (Stripe puede entregar
-- el mismo evento múltiples veces — la spec garantiza at-least-once).
-- =============================================================================

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT,
  ADD COLUMN IF NOT EXISTS stripe_price_id         TEXT,
  ADD COLUMN IF NOT EXISTS current_period_end      TIMESTAMPTZ;

-- Unique para detectar duplicados defensivamente. Permite null para
-- las companies que aún no pasaron por checkout.
CREATE UNIQUE INDEX IF NOT EXISTS companies_stripe_customer_idx
  ON public.companies(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS companies_stripe_subscription_idx
  ON public.companies(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- ─── Idempotency table ─────────────────────────────────────────────────
-- Cada evento de Stripe llega con un id estable (`evt_xxx`). Si el
-- webhook handler crashea/timeout después de procesarlo pero antes de
-- responder 200, Stripe lo reentrega. Sin idempotency, doble-procesado.
--
-- El handler hace INSERT ... ON CONFLICT DO NOTHING + check RETURNING:
-- si la fila ya existía, skipea. Garantiza exactly-once.
--
-- Retención: el `stripe_events` puede crecer. Cron de limpieza > 30 días
-- queda como TODO; mientras tanto el volumen es bajo.

CREATE TABLE IF NOT EXISTS public.stripe_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload      JSONB
);

CREATE INDEX IF NOT EXISTS stripe_events_processed_idx
  ON public.stripe_events(processed_at DESC);

-- RLS: solo service_role / postgres bypassean. El backend escribe vía
-- service role, nadie más necesita acceso (ni siquiera platform_admin).
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;
-- Sin policy → ningún user authenticated ve nada (locked down).

GRANT INSERT, SELECT ON public.stripe_events TO postgres;
