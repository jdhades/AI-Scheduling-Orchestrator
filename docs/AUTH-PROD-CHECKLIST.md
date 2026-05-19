# Auth Production Checklist

Sprint Auth + Multi-tenant quedó cerrado el 2026-05-11. Este doc lista los
pasos operacionales para llevar la auth a prod-grade. Ya no son código —
son toggles en Supabase Dashboard, Cloudflare, y el `.env` del orchestrator.

## Estado actual (2026-05-19)

- [x] **Hook custom_access_token** creado en local + activado vía `supabase/config.toml`.
- [x] **Smoke test local**: signup → JWT incluye `company_id`, `employee_id`, `employee_role`, `department_id`.
- [x] **Migration cleanup**: helpers `auth.user_*` movidos a `public.user_*` (CREATE como postgres). `handle_new_user` + trigger en `sql-extra/auth_setup.sql` (apply como supabase_admin).
- [x] **Hard-fail check** en `main.ts`: si `DEV_AUTH_BYPASS=true` y `APP_ENV`/`NODE_ENV` son prod-like, el server NO arranca.
- [ ] Hook activado en Supabase Cloud Dashboard.
- [ ] Cloudflare configurado (`docs/CLOUDFLARE-SETUP.md`).
- [ ] `DEV_AUTH_BYPASS=false` en el `.env` de prod del orchestrator.

## Pasos para apagar el bypass

### 1. Supabase Cloud — Hook activation

Solo aplica si vas a Supabase Cloud (no self-hosted).

1. Ejecutar las migrations + sql-extra contra el proyecto Cloud:
   - Dashboard → SQL Editor → pegar `supabase/sql-extra/auth_setup.sql` → Run.
   - Pegar `supabase/sql-extra/custom_access_token_hook.sql` → Run.
2. Dashboard → **Authentication → Hooks → Customize Access Token** →
   seleccionar `auth.custom_access_token_hook` → Save.
3. Cerrar sesión y volver a entrar (los JWT existentes no tienen los claims
   nuevos; los próximos sí).

Self-hosted: setear en el container `supabase_auth`:
```
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/auth/custom_access_token_hook
```
y restart del container.

### 2. Cloudflare

Seguir `docs/CLOUDFLARE-SETUP.md` end-to-end. Resumen:

- DNS proxied (naranja) en `api.*` y `app.*`.
- SSL Full (strict) + Origin Cert.
- WAF Managed Ruleset ON.
- 1 rate limit rule (login brute-force).
- Turnstile site key en frontend (`VITE_TURNSTILE_SITEKEY`) + secret en
  Supabase Auth Dashboard → CAPTCHA Protection.
- Cloudflare Tunnel apuntando al origin + firewall cerrando puerto público.

### 3. Apagar `DEV_AUTH_BYPASS`

En el `.env` de prod del orchestrator:
```
DEV_AUTH_BYPASS=false
APP_ENV=production
NODE_ENV=production
```

El hard-fail de `main.ts:87` garantiza que aunque alguien deje `true` por error,
con `APP_ENV=production` o `NODE_ENV=production` el server hace `process.exit(1)`.
No hay path para que el bypass funcione en prod.

Verificar después del deploy: hacer un curl con header `X-Company-Id` y SIN
`Authorization: Bearer` → debería responder 401, NO 200.

## Local dev — cómo regenerar el stack

Si tenés que hacer `supabase stop` + `start` desde cero:

```bash
# 1. start (las migrations corren limpio porque ya no tocan schema auth)
pnpm dlx supabase start

# 2. aplicar los archivos sql-extra como supabase_admin
docker exec -i -e PGPASSWORD=postgres supabase_db_ai-scheduling-orchestrator \
  psql -U supabase_admin -d postgres < supabase/sql-extra/auth_setup.sql

docker exec -i -e PGPASSWORD=postgres supabase_db_ai-scheduling-orchestrator \
  psql -U supabase_admin -d postgres < supabase/sql-extra/custom_access_token_hook.sql

# 3. seed (opcional — demo data)
docker exec -i -e PGPASSWORD=postgres supabase_db_ai-scheduling-orchestrator \
  psql -U postgres -d postgres < supabase/seed.sql
```

Para crear usuarios dev: signup via `POST /auth/v1/signup`. El trigger
crea company + employee owner automáticamente.
