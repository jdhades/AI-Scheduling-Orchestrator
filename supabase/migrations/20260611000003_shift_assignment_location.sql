-- MIGRATION: shift location (feature Locations — scheduler)
--
-- Cada turno puede tener una localidad asignada (multi-sitio bajo sucursal). La
-- elige el manager al crear/editar el turno; se clona junto con el turno. Si la
-- localidad se borra, el turno queda sin localidad (SET NULL), no se pierde.

ALTER TABLE public.shift_assignments
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES public.locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS shift_assignments_location_idx
  ON public.shift_assignments(location_id);
