-- Agregamos la columna 'locale' a la tabla employees para el soporte de i18n
ALTER TABLE employees ADD COLUMN locale VARCHAR(10) NOT NULL DEFAULT 'es';
