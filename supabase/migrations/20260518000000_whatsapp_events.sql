-- MIGRATION: whatsapp_events para dedup de webhooks Twilio.
--
-- Twilio entrega webhooks at-least-once: si el handler tarda > 15s o
-- responde !=2xx, retry-ea hasta 5 veces con backoff. Sin dedup, el
-- mismo MessageSid puede crear incidents duplicados o disparar el
-- MessageRouter varias veces.
--
-- Patrón espejo de `stripe_events` (20260516000002_stripe_billing.sql):
-- INSERT ON CONFLICT DO NOTHING — si la inserción no afecta filas, es
-- un duplicado y respondemos 200 sin reprocesar.

CREATE TABLE IF NOT EXISTS public.whatsapp_events (
  message_sid  TEXT PRIMARY KEY,
  source       TEXT NOT NULL,  -- 'whatsapp' | 'twilio-incident'
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_events_processed_idx
  ON public.whatsapp_events(processed_at DESC);

-- RLS lockdown: solo service_role / postgres escriben. Sin policy →
-- ningún user authenticated lee nada. Espejo de stripe_events.
ALTER TABLE public.whatsapp_events ENABLE ROW LEVEL SECURITY;

GRANT INSERT, SELECT ON public.whatsapp_events TO postgres;

COMMENT ON TABLE public.whatsapp_events IS
  'Idempotency log para webhooks de Twilio (WhatsApp messages + incident certs). PK por MessageSid evita reprocesar retries.';
