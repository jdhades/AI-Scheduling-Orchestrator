-- MIGRATION: available_llm_models — whitelist de modelos que el admin
-- puede asignar a un tenant. Sin entry para un (provider, model),
-- el admin NO debería ofrecerlo en el dropdown del LlmConfigDialog.
-- El backend igual acepta cualquier model string (no enforcing en
-- DB porque los providers cambian rápido); este registry es solo UX.

CREATE TABLE IF NOT EXISTS public.available_llm_models (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    TEXT NOT NULL CHECK (provider IN ('qwen', 'gemini', 'local')),
  model       TEXT NOT NULL,
  -- Nombre amigable opcional (ej. "Qwen 3.6 Plus", "Gemini 2.0 Flash").
  label       TEXT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, model)
);

COMMENT ON TABLE public.available_llm_models IS
  'Whitelist UX-only de (provider, model) que el admin puede asignar a tenants. El backend no enforza esta lista a nivel de aceptación.';

ALTER TABLE public.available_llm_models ENABLE ROW LEVEL SECURITY;

-- Solo platform_admin lee/escribe.
CREATE POLICY available_llm_models_platform_admin_all
  ON public.available_llm_models
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.platform_admins WHERE auth_user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.platform_admins WHERE auth_user_id = auth.uid())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.available_llm_models TO postgres;

-- Seed inicial — modelos que sabemos que funcionan en el sistema.
INSERT INTO public.available_llm_models (provider, model, label, notes)
VALUES
  ('qwen',   'qwen3.6-plus',     'Qwen 3.6 Plus',     'Paid tier — DashScope'),
  ('qwen',   'qwen-plus',        'Qwen Plus (free)',  'Free tier, legacy'),
  ('gemini', 'gemini-2.0-flash', 'Gemini 2.0 Flash',  'Default Gemini para producción'),
  ('local',  'llama-3.1-8b',     'Llama 3.1 8B',      'Default para LM Studio/Ollama')
ON CONFLICT (provider, model) DO NOTHING;
