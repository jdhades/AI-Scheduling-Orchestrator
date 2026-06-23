-- MIGRATION: idioma base → inglés.
--
-- Los empleados nuevos arrancan en 'en'. Las filas existentes mantienen su
-- valor (los clientes móvil/web sincronizan su idioma real en el próximo login
-- vía PATCH /employees/me/locale, así que no hace falta forzar un UPDATE).

ALTER TABLE public.employees ALTER COLUMN locale SET DEFAULT 'en';
