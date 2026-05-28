-- MIGRATION: imports Fase 3 — upload libre con vision LLM.
--
-- Owner sube PDF/imagen → backend extrae con Claude/Gemini/Qwen vision →
-- ImportPayload canónico → spine de Fase 1. Decisiones:
--   - Provider configurable per-tenant (companies.imports_vision_provider).
--   - Model también per-tenant (companies.imports_vision_model). Si null,
--     el resolver usa el default del provider.
--   - Bucket privado `import-uploads`: el original se borra al confirmar
--     o descartar — solo lo mantenemos durante la ventana del staging.
--   - Provider `anthropic` registrado en integration_credentials para
--     que /admin/integrations lo gestione (Vault cifrado, igual que el
--     resto de LLM providers).

-- ─── 1. companies: vision provider/model por tenant ────────────────────
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS imports_vision_provider TEXT
    NOT NULL DEFAULT 'anthropic'
    CHECK (imports_vision_provider IN ('anthropic', 'gemini', 'qwen'));

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS imports_vision_model TEXT NULL;

COMMENT ON COLUMN public.companies.imports_vision_provider IS
  'Provider LLM con visión para extraer ImportPayload desde uploads libres. Anthropic default.';
COMMENT ON COLUMN public.companies.imports_vision_model IS
  'Modelo específico del provider (ej. claude-sonnet-4-6, gemini-2.0-flash-exp). Null = default del provider.';

-- ─── 2. imports_staging: relación al archivo subido ────────────────────
-- Solo lo seteamos para source='upload_freeform'. El path se construye
-- como `${companyId}/${importId}/original.${ext}` — único y trazable.
ALTER TABLE public.imports_staging
  ADD COLUMN IF NOT EXISTS upload_storage_path TEXT NULL;

ALTER TABLE public.imports_staging
  ADD COLUMN IF NOT EXISTS upload_mime_type TEXT NULL;

-- Raw output crudo del LLM antes del parse JSON. Lo guardamos para que
-- /admin/imports/:id/raw lo pueda inspeccionar si el parse falló o el
-- payload extraído no coincide con lo esperado. Solo platform_admin.
ALTER TABLE public.imports_staging
  ADD COLUMN IF NOT EXISTS extract_raw_output JSONB NULL;

COMMENT ON COLUMN public.imports_staging.extract_raw_output IS
  'Output crudo del vision LLM (raw text + usage). Para debug admin — solo accesible vía /admin/imports/:id/raw.';

-- Estado adicional 'extracting': el upload entró pero todavía no se
-- terminó de procesar con vision. Cuando el worker termina, transiciona
-- a 'pending_review' (caso happy) o 'failed' (extract error).
ALTER TABLE public.imports_staging
  DROP CONSTRAINT IF EXISTS imports_staging_status_check;

ALTER TABLE public.imports_staging
  ADD CONSTRAINT imports_staging_status_check
  CHECK (status IN (
    'extracting',
    'pending_review',
    'confirming',
    'committed',
    'failed',
    'discarded'
  ));

-- ─── 3. Provider 'anthropic' en integration_credentials ───────────────
-- La tabla tiene CHECK constraint hardcoded — actualizamos para sumar
-- anthropic (vision para imports). Drop+recreate porque ADD VALUE no
-- aplica a CHECK constraints (solo a enums).
ALTER TABLE public.integration_credentials
  DROP CONSTRAINT IF EXISTS integration_credentials_provider_check;

ALTER TABLE public.integration_credentials
  ADD CONSTRAINT integration_credentials_provider_check
  CHECK (provider IN (
    'twilio', 'resend', 'qwen', 'gemini', 'local_llm', 'anthropic'
  ));

-- ─── 4. Bucket privado import-uploads ──────────────────────────────────
-- storage.buckets es una tabla pública en el schema storage de Supabase.
-- ON CONFLICT DO NOTHING para que la migration sea idempotente entre envs.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'import-uploads',
  'import-uploads',
  false,
  20 * 1024 * 1024, -- 20 MB
  ARRAY[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Policy: solo platform_admin + el owner del tenant pueden tocar
-- objetos en este bucket. El path empieza con companyId/ — esa es la
-- tenant key.
DROP POLICY IF EXISTS import_uploads_tenant_read ON storage.objects;
CREATE POLICY import_uploads_tenant_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'import-uploads' AND (
      public.is_platform_admin() OR
      (split_part(name, '/', 1))::uuid = public.user_company_id()
    )
  );

DROP POLICY IF EXISTS import_uploads_tenant_write ON storage.objects;
CREATE POLICY import_uploads_tenant_write ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'import-uploads' AND
    (split_part(name, '/', 1))::uuid = public.user_company_id()
  );

DROP POLICY IF EXISTS import_uploads_tenant_delete ON storage.objects;
CREATE POLICY import_uploads_tenant_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'import-uploads' AND (
      public.is_platform_admin() OR
      (split_part(name, '/', 1))::uuid = public.user_company_id()
    )
  );
