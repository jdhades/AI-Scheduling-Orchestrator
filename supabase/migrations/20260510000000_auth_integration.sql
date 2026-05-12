-- =============================================================================
-- Auth integration — PR 1 del sprint Auth + Multi-tenant + Vista Empleado
-- =============================================================================
-- Link entre `auth.users` (Supabase Auth) y `employees` + audit log de eventos
-- auth + tabla de invitaciones. NO habilita RLS en esta migration — eso es PR 6
-- atrás para no romper el path actual sin JWT. Esta sola es backward-compatible:
-- la columna `auth_user_id` es nullable, las nuevas tablas son additive.
-- =============================================================================

-- ─── 1. Link employees ↔ auth.users ─────────────────────────────────────────
-- Nullable porque los employees existentes (pre-auth sprint) no tienen user
-- linked todavía. El trigger del invitation flow (PR 7) lo poblará.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE
    REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS employees_auth_user_id_idx
  ON employees(auth_user_id);

-- ─── 2. Audit log de eventos auth ────────────────────────────────────────────
-- Separado de shift_assignment_edits porque shape distinto y cadencia alta:
-- cada login (success/fail), 403, role change, password reset escribe acá.
-- Sin FK a employees/auth.users porque queremos preservar el audit aunque la
-- fila origen se borre (compliance: retención del log > vida del registro).

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL si el evento es pre-auth (ej. login_fail antes de validar user).
  company_id      UUID NULL,
  auth_user_id    UUID NULL,
  employee_id     UUID NULL,
  -- Texto libre (no enum) para no requerir migration al sumar eventos.
  -- Convención: snake_case. Casos típicos:
  --   login_success | login_fail | logout | permission_denied
  --   role_changed | mfa_enrolled | password_reset | session_invalidated
  event           TEXT NOT NULL,
  ip_address      INET NULL,
  user_agent      TEXT NULL,
  -- Metadata event-specific (ej. {"from_role":"employee","to_role":"manager"}).
  metadata        JSONB NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_audit_log_company_time_idx
  ON auth_audit_log (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_audit_log_user_time_idx
  ON auth_audit_log (auth_user_id, created_at DESC);

-- Index parcial para queries de seguridad: "últimos fallos del último día".
-- Excluye eventos OK que dominan en volumen.
CREATE INDEX IF NOT EXISTS auth_audit_log_security_events_idx
  ON auth_audit_log (event, created_at DESC)
  WHERE event IN ('login_fail', 'permission_denied', 'session_invalidated');

-- ─── 3. Invitaciones ─────────────────────────────────────────────────────────
-- Flow: manager dispara POST /auth/invitations → fila acá. Email o phone
-- según rol (manager → email, employee → WhatsApp OTP, alineado con
-- handshake.repository existente). El user acepta vía /accept-invitation,
-- Supabase crea auth.users, trigger `handle_new_user` linkea a employee y
-- marca la fila como consumed.

CREATE TABLE IF NOT EXISTS auth_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL,
  -- employee_id del manager que invitó (para audit + revocar).
  invited_by      UUID NOT NULL,
  email           TEXT NULL,
  phone_number    TEXT NULL,
  role            TEXT NOT NULL CHECK (role IN ('manager', 'employee')),
  department_id   UUID NULL,
  -- Nonce random 32+ chars, generado en el backend con crypto.randomUUID()
  -- o similar. Indexed unique para lookup O(1) en /accept-invitation.
  token           TEXT NOT NULL UNIQUE,
  -- TTL típico: 7 días para email, 15 min para OTP WhatsApp. Lo decide
  -- el backend al crear la fila — esta tabla solo lo guarda.
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = pending. Set a now() cuando se consume. Las filas consumidas
  -- se mantienen para audit (no se borran); el cleanup de expiradas
  -- pendientes lo hace un job separado (TODO).
  consumed_at     TIMESTAMPTZ NULL,
  -- Al menos uno de los dos debe estar presente.
  CHECK (email IS NOT NULL OR phone_number IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS auth_invitations_company_idx
  ON auth_invitations(company_id);

-- Lookup por token único — usado en /accept-invitation.
CREATE UNIQUE INDEX IF NOT EXISTS auth_invitations_token_uidx
  ON auth_invitations(token);

-- Lookup por email/phone para el trigger handle_new_user (PR 7).
CREATE INDEX IF NOT EXISTS auth_invitations_email_pending_idx
  ON auth_invitations(email) WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_invitations_phone_pending_idx
  ON auth_invitations(phone_number) WHERE consumed_at IS NULL;
