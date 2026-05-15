---
description: Auditoría de seguridad transversal — dependencias, secrets, RLS, gating, validation
---

Recorré este checklist de manera estructurada. Para cada item, decidí
explícitamente: **OK / FAIL / N/A** (con archivo:línea si FAIL).

Reportá el resultado al final en formato markdown. Si hay FAIL: NO
declarar terminado — abrir issues o tareas concretas.

Aplica a ambos repos. Si el repo actual es el frontend, los items
backend-only quedan N/A.

## 1. Dependencias

- [ ] `pnpm audit --audit-level=high` corre sin nuevas vulnerabilidades
- [ ] Cualquier paquete agregado en este branch cumple regla de
      CLAUDE_RULES: >1000 downloads/semana + >7 días desde publish
- [ ] Inspect de `postinstall` / `preinstall` en deps nuevas: ninguno
      hace fetch a hosts externos no esperados (curl, wget, etc.)
- [ ] Pin de `axios@1.13.6` sigue activo (vía `overrides` en package.json)
- [ ] No hay imports de paquetes bloqueados (`plain-crypto-js`, etc.)

Comandos:
```bash
pnpm audit --audit-level=high
grep -rn "from ['\"]plain-crypto-js" src/
cat package.json | jq '.overrides // empty'
```

## 2. Secrets en el repo

- [ ] No hay `.env*` commiteados (sólo `.env.example` y solo si no
      tiene valores reales)
- [ ] No hay `sk_`, `whsec_`, `sb_secret_`, `pk_live_`, `AIza` (Google),
      `xoxb-` (Slack) en ningún archivo trackeado
- [ ] No hay tokens hardcoded en tests/fixtures

Comandos:
```bash
git ls-files | xargs grep -lE "sk_(test|live)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|sb_secret_|AIza[0-9A-Za-z-_]{30,}|xox[abp]-[0-9A-Za-z-]{10,}" 2>/dev/null
git ls-files | grep -E "^\\.env" | grep -v example
```

## 3. RLS y multi-tenancy (backend / Supabase)

- [ ] Toda tabla agregada en migrations recientes tiene `ENABLE ROW LEVEL SECURITY`
- [ ] Toda tabla tenant-scoped tiene policy `tenant_isolation` con
      `company_id = auth.user_company_id()`
- [ ] Tablas con datos sensibles (audit_log, employee_capabilities,
      manager_scopes, platform_admins, stripe_events) tienen RLS lockdown
      (no policy = nadie ve nada via authenticated)
- [ ] Endpoints write nuevos validan tenant del recurso antes de mutar
      (cross-tenant guard, no solo trust al `companyId` del JWT)

Comandos:
```bash
# Tablas con RLS:
docker exec ... psql -c "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' ORDER BY tablename;"
# Policies por tabla:
docker exec ... psql -c "SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' ORDER BY tablename;"
```

## 4. Auth + gating (backend)

- [ ] Endpoints write (POST/PATCH/DELETE) tienen `@Roles(...)` o `@Requires(...)`
- [ ] Endpoints público (sin auth) tienen `@Public()` explícito
- [ ] Endpoints scoped (que mutan recursos de un depto) llaman a
      `scope.assertDeptInScope(user, deptId)` antes de mutar
- [ ] Endpoints de billing/settings/admin son owner/platform_admin only

Comandos:
```bash
# Endpoints sin @Roles/@Requires/@Public (posible gap):
grep -rn -B 2 "@(Post|Patch|Delete)" src/interfaces/controllers/ | grep -v "@(Roles|Requires|Public)"
```

## 5. Webhooks (backend)

- [ ] Cada webhook endpoint verifica firma antes de procesar payload
  - Stripe: `stripe.webhooks.constructEvent(rawBody, sig, secret)`
  - Twilio: validar header `X-Twilio-Signature`
  - WhatsApp: validar token
- [ ] Webhooks NO loguean el body crudo (puede contener PII)
- [ ] Endpoints webhook están en el exclude list de `TenantMiddleware`
- [ ] Webhook handlers son idempotentes (dedup por event id)

## 6. Input validation

- [ ] Cada DTO usa decorators de `class-validator` (no plain interfaces)
- [ ] String fields tienen `MinLength` / `MaxLength` cuando aplica
- [ ] UUID fields tienen `@IsUUID()` o `@IsString` + check posterior
- [ ] Endpoints públicos (signup, webhooks) tienen `@Throttle()` agresivo

## 7. Rate limiting

- [ ] `ThrottlerModule` global activo (en AppModule)
- [ ] Endpoints sensibles (login, signup, webhook callbacks) tienen
      `@Throttle()` específico más restrictivo que el default

## 8. Frontend

- [ ] No hay tokens / secrets en código JS (publishable keys son OK, pero
      con prefix `VITE_` y prefix `pk_test_`)
- [ ] `console.log` con data de usuarios eliminados antes de commit
- [ ] CSP en `index.html` no permite `'unsafe-inline'` scripts (si fue
      necesario, justificación en el meta tag)
- [ ] `dangerouslySetInnerHTML` solo en lugares específicos y con input
      sanitizado / trusted (ej. MFA QR code que viene de Supabase)

Comandos:
```bash
grep -rn "console\\.log" src/ --include="*.tsx" --include="*.ts" | grep -v "test\\|spec"
grep -rn "dangerouslySetInnerHTML" src/
```

## 9. CORS / headers

- [ ] Helmet activo en backend con CSP restrictivo
- [ ] HSTS habilitado (`maxAge` ≥ 1 año en prod)
- [ ] CORS allowlist explícito (no `*` en producción)

## 10. Audit log

- [ ] Eventos sensibles (login_success, login_fail, permission_denied,
      role_changed, mfa_enrolled, password_reset, session_invalidated)
      se escriben al `auth_audit_log`
- [ ] Cambios de capabilities/scopes (Sprint RBAC) van al audit log
      cuando el feature se considere production-ready

## Reporte

Al terminar, devolvé:

```
## Security Audit — <fecha>

✅ Pass: <N items>
❌ FAIL: <item> — <archivo:línea>
🚫 N/A: <item> — <razón>

### Action items
- [ ] Fix X en archivo Y
- [ ] ...
```

Si hay 0 FAILs, sumá una línea: "Auditoría limpia." Si hay FAILs, crear
issues / TODOs concretos antes de seguir.
