-- MIGRATION: chat announcements room flag (Sprint 3 — broadcast)
--
-- Marks the tenant's announcements group (one per company). A broadcast posts
-- to it; every employee is a member so the announcement reaches everyone.

ALTER TABLE public.chat_rooms
  ADD COLUMN IF NOT EXISTS is_announcement BOOLEAN NOT NULL DEFAULT false;
