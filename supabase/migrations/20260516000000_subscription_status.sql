-- =============================================================================
-- Subscription status — habilita el TrialGuard del backend
-- =============================================================================
-- Cierra TODO(billing) del trial flow: hasta ahora `trial_ends_at` se
-- seteaba pero no se enforzaba. Acá agregamos el estado de suscripción
-- por company y el TrialGuard del NestJS lo lee para responder 402
-- cuando el trial expira sin pago.
--
-- States:
--   trialing  — dentro del free trial. Bloquea cuando trial_ends_at < now().
--   active    — suscripción al día. Acceso completo.
--   past_due  — pago falló pero no canceló. Acceso con grace period (no bloquea).
--   canceled  — explicitly canceled. Bloquea.
--
-- TODO(payments): integración con proveedor (Stripe/Lemon Squeezy) para
-- mover estos states automáticamente. Por ahora solo la columna y el
-- enforcement del trial; un manager con DB access puede cambiar el state
-- manualmente para extender o cancelar.
-- =============================================================================

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL
    DEFAULT 'trialing'
    CHECK (subscription_status IN ('trialing', 'active', 'past_due', 'canceled'));

-- Companies sembradas por SQL (dev/demo) NO deben quedar atrapadas en
-- trial. Las migramos a 'active' una vez. Las self_signup nuevas siguen
-- con el default 'trialing'.
UPDATE public.companies
SET subscription_status = 'active'
WHERE created_via = 'sql_seed'
  AND subscription_status = 'trialing';

CREATE INDEX IF NOT EXISTS companies_subscription_status_idx
  ON public.companies(subscription_status);
