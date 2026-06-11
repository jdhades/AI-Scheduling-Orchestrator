-- MIGRATION: branches.address
--
-- Dirección de la sucursal. Cuando el feature 'locations' está desactivado, la
-- sucursal es el punto de marcaje por defecto (geofence_*); la dirección la
-- identifica para el manager.

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS address TEXT;
