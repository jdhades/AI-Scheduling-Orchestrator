-- MIGRATION: tenant_features — feature flags per-tenant que soporte
-- habilita/deshabilita desde el admin panel. Default = disabled (sin
-- override). El catálogo de feature_keys se mantiene en código
-- (constants) — esta tabla solo almacena overrides.

CREATE TABLE IF NOT EXISTS public.tenant_features (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  -- Payload opcional para flags que llevan config (ej. límites,
  -- thresholds, listas). NULL = solo on/off.
  payload     JSONB NULL,
  notes       TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, feature_key)
);

CREATE INDEX IF NOT EXISTS tenant_features_company_idx
  ON public.tenant_features (company_id);

COMMENT ON TABLE public.tenant_features IS
  'Feature flags per-tenant. El catálogo de keys vive en código; esta tabla solo almacena overrides explícitos del admin.';

ALTER TABLE public.tenant_features ENABLE ROW LEVEL SECURITY;

-- Solo platform_admin lee/escribe esta tabla. Los tenants no la
-- consultan directamente — el backend lee con service-role y aplica
-- el feature flag silenciosamente.
CREATE POLICY tenant_features_platform_admin_all ON public.tenant_features
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.platform_admins WHERE auth_user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.platform_admins WHERE auth_user_id = auth.uid())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_features TO postgres;
