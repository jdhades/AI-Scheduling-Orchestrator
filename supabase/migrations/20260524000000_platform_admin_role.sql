-- MIGRATION: agrega role a platform_admins ('super' | 'support').
-- super = puede gestionar otros platform_admins (alta/baja/promote/demote).
-- support = ve el panel y opera todos los endpoints existentes pero NO
-- puede tocar la tabla platform_admins.

ALTER TABLE public.platform_admins
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'support'
    CHECK (role IN ('super', 'support'));

COMMENT ON COLUMN public.platform_admins.role IS
  'Sub-rol del platform_admin. super gestiona otros admins; support solo opera el panel.';

-- Seed: cualquier admin pre-existente del manager@demo.local arranca
-- como super para que Jean no pierda acceso al panel de gestión.
UPDATE public.platform_admins
SET role = 'super'
WHERE email IN ('manager@demo.local', 'soporte@platform.local');

-- Garantía mínima: si por algún motivo la tabla no tiene ningún super
-- todavía (ej. ambientes nuevos), promovemos al admin más antiguo a
-- super. Evita arrancar sin nadie capaz de gestionar usuarios.
UPDATE public.platform_admins
SET role = 'super'
WHERE id = (
  SELECT id FROM public.platform_admins
  ORDER BY created_at ASC
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1 FROM public.platform_admins WHERE role = 'super'
);
