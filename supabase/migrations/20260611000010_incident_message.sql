-- Mensaje libre que escribe el empleado al reportar un incidente desde la app
-- (POST /incidents/report). El flujo OCR/medical-leave (WhatsApp, con
-- certificado) no usa esta columna — su texto va en ocr_text.
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS message text;
