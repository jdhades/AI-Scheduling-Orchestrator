# Auth Production Checklist

Sprint Auth + Multi-tenant quedó cerrado el 2026-05-11. Este doc lista los
pasos operacionales para llevar la auth a prod-grade. Ya no son código —
son toggles en Supabase Dashboard, Cloudflare, y el `.env` del orchestrator.

## Estado actual (2026-05-31)

- [x] **Hook custom_access_token** creado en local + activado vía `supabase/config.toml`.
- [x] **Smoke test local**: signup → JWT incluye `company_id`, `employee_id`, `employee_role`, `department_id`.
- [x] **Migration cleanup**: helpers `auth.user_*` movidos a `public.user_*` (CREATE como postgres). `handle_new_user` + trigger en `sql-extra/auth_setup.sql` (apply como supabase_admin).
- [x] **Hard-fail check** en `main.ts`: si `DEV_AUTH_BYPASS=true` y `APP_ENV`/`NODE_ENV` son prod-like, el server NO arranca.
- [x] **Hook activado en Supabase STAGING** (proyecto `gpjxtotkqwiwputcvgrw`). JWT incluye claims, confirmado.
- [x] **STAGING `.env` migrado**: `DEV_AUTH_BYPASS=false`, `APP_ENV=production`.
- [ ] **Hook activado en Supabase PROD** (proyecto a crear cuando exista dominio comercial).
- [ ] **Decisión Cloudflare vs NPM directo** — `staging` está con GoDaddy DNS + NPM + Let's Encrypt (no Cloudflare). Para prod decidir antes del lanzamiento (ver sección al final).
- [ ] **PROD `.env`**: idem staging.

## Pasos para apagar el bypass

### 1. Supabase Cloud — Hook activation (PROD)

Cuando crees el proyecto Supabase prod (separado de staging):

1. **Aplicar migrations**:
   ```bash
   supabase link --project-ref <PROD_PROJECT_REF>
   supabase db push --linked
   ```
2. **Aplicar sql-extra Cloud** (no las versions de schema `auth` — Cloud no las permite):
   - Dashboard → SQL Editor → pegar `supabase/sql-extra/auth_setup_cloud.sql` → Run.
   - Pegar `supabase/sql-extra/custom_access_token_hook_cloud.sql` → Run.
3. **Activar hook**: Dashboard → **Authentication → Hooks → Customize Access Token**:
   - Enable hook: **ON**
   - Hook type: **Postgres**
   - Schema: **public** (no `auth` — Cloud restriction)
   - Function: **custom_access_token_hook**
   - Save.
4. **Smoke test**: signup desde la frontend → inspeccionar el JWT (decoded en jwt.io) → debe incluir:
   ```json
   {
     "company_id": "<uuid>",
     "employee_id": "<uuid>",
     "employee_role": "owner",
     "department_id": null
   }
   ```
   Si los claims faltan, el hook NO está activo. Reaplicar SQL + revisar Dashboard.

5. **Verificar el path B no se está usando**: en los logs del backend NO debería aparecer
   `[SupabaseAuthGuard] JWT lacks company_id, falling back to employees lookup`. Si aparece,
   el hook está mal o la function tiene un bug.

Self-hosted: setear en el container `supabase_auth`:
```
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/public/custom_access_token_hook
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

---

## Decisión: Cloudflare vs NPM directo (PROD)

Pendiente para el lanzamiento. Tradeoffs:

### Opción A — Cloudflare proxy (recomendado)
- ✅ WAF managed ruleset (OWASP core rules + DDoS auto-mitigation)
- ✅ Rate limiting integrado (configurable por path: `/auth/login` brute-force)
- ✅ Turnstile (captcha invisible) ya cableado en frontend (`VITE_TURNSTILE_SITEKEY`)
- ✅ CDN para assets estáticos del frontend (latencia mundial)
- ✅ Origin Cert válido por 15 años, sin renovaciones Let's Encrypt
- ❌ Setup más complejo: DNS proxied + SSL Full strict + Origin Cert + Tunnel
- ❌ Cuenta Cloudflare + alguna config requiere Pro plan ($20/mes)

### Opción B — NPM directo (lo que está en staging)
- ✅ Setup simple: GoDaddy DNS A record → VPS → NPM con Let's Encrypt
- ✅ Cero costo adicional
- ✅ Control total del stack (no hay capa de terceros)
- ❌ Sin WAF — todo el tráfico llega al backend
- ❌ Rate limiting: solo el de ThrottlerGuard del backend (60/min IP-based). Sin protección si el atacante distribuye IPs
- ❌ Turnstile no se puede usar (requiere Cloudflare aunque sea modo gratis)
- ❌ DDoS: el VPS aguanta lo que aguante. Hetzner/DO mid-tier saturan en ~10k rps

### Recomendación
**Para lanzamiento inicial: Opción A.** El plan free de Cloudflare ya cubre lo
esencial (DNS proxy + WAF basic + DDoS auto + Turnstile sin Pro). Si el costo
del Pro plan no se justifica desde el día 1, igual conviene tener el dominio
proxiado para usar el plan free como capa base — siempre podés upgrade después.

**Si el lanzamiento es small-scale (1-5 clientes piloto): Opción B alcanza.**
El rate limiting interno del backend + Helmet + CORS strict es suficiente para
tráfico controlado. Migrar a Cloudflare cuando aparezca el primer brute force
real o cuando un cliente pida SLA serio.

Cuando decidas, seguir `docs/CLOUDFLARE-SETUP.md` (opción A) o documentar la
config del NPM en este checklist (opción B).
