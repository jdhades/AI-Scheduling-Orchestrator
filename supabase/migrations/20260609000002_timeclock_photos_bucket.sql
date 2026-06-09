-- MIGRATION: timeclock-photos storage bucket (selfie verification)
--
-- Private bucket for clock-in selfies. The mobile app uploads with the
-- employee's session; the web review queue reads them via server-side signed
-- URLs (service role bypasses RLS). No public read.

INSERT INTO storage.buckets (id, name, public)
VALUES ('timeclock-photos', 'timeclock-photos', false)
ON CONFLICT (id) DO NOTHING;

-- Authenticated employees can upload selfies into the bucket.
DROP POLICY IF EXISTS "timeclock_photos_insert" ON storage.objects;
CREATE POLICY "timeclock_photos_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'timeclock-photos');

-- Reads happen server-side (service role + signed URLs) — no SELECT policy for
-- regular users, so selfies are not publicly browsable.
