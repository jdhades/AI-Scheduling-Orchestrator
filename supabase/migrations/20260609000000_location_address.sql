-- MIGRATION: locations.address (Locations feature)
--
-- Dirección legible de la locación (resuelta por geocoding al fijar el punto).
-- Opcional — el geofence (lat/lng/radio) sigue siendo lo que valida el marcaje;
-- la dirección es para mostrar/editar de forma humana.

ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS address TEXT;
