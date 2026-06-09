-- MIGRATION: chat attachments (Sprint 3, Phase 5)
--
-- Image/file attachments on chat messages. The mobile/web uploads to the
-- private `chat-attachments` bucket (path: ${companyId}/${roomId}/...) and sends
-- a message carrying the path; the backend returns a signed URL on read.

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS attachment_path TEXT NULL,
  ADD COLUMN IF NOT EXISTS attachment_type TEXT NULL
    CHECK (attachment_type IS NULL OR attachment_type IN ('image', 'file')),
  ADD COLUMN IF NOT EXISTS attachment_name TEXT NULL;

-- content may be empty when the message is attachment-only.
ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_content_check;
ALTER TABLE public.chat_messages
  ADD CONSTRAINT chat_messages_content_len CHECK (char_length(content) <= 4000);
ALTER TABLE public.chat_messages
  ADD CONSTRAINT chat_messages_content_or_attachment
  CHECK (char_length(content) > 0 OR attachment_path IS NOT NULL);

-- ─── bucket ─────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-attachments', 'chat-attachments', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "chat_attachments_insert" ON storage.objects;
CREATE POLICY "chat_attachments_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chat-attachments');
