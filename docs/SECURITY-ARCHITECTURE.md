# Arquitectura de Seguridad del Backend

Estado real (2026-04-27, post-sprint Company Policies). Este documento
describe lo que **está implementado**, lo que es **deuda reconocida**, y
los **gaps abiertos**. Se actualiza cuando la realidad cambia.

---

## 1. Network Security

### Helmet
- Aplicado globalmente en `main.ts` antes que cualquier otro middleware.
- Mitiga: clickjacking (X-Frame-Options), reflected XSS, MIME-sniff,
  Powered-By disclosure.

### CORS
- `ALLOWED_ORIGIN` (env var) es la fuente autoritativa.
- Soporta string único o lista separada por coma (`a.com,b.com`).
- **Defaults seguros por entorno**:
  - `NODE_ENV` o `APP_ENV` ∈ {`development`, `test`} → `'*'` (dev abierto).
  - Otro caso (prod-like) sin `ALLOWED_ORIGIN` → **`false`** (fail closed).
- Allowed headers explícitos: `Content-Type, Accept, Authorization, X-Company-Id`.
- Implementación: `src/main.ts`.

---

## 2. Input Validation

### ValidationPipe global
- `whitelist: true` + `forbidNonWhitelisted: true` aplicados en
  `main.ts` antes que cualquier ruta.
- Cualquier campo no decorado en el DTO es rechazado con 400.
- **Cobertura**: todos los controllers HTTP tienen DTOs con
  `class-validator` (rollout completo el 2026-04-27). Convenciones del
  proyecto:
  - **IDs**: `@IsString() @IsNotEmpty()` — la seed data usa formato
    UUID-shape no estricto RFC 4122; `@IsUUID()` los rechazaría.
  - **Fechas**: `@Matches(/^\d{4}-\d{2}-\d{2}$/)` para `date` y
    `effectiveFrom`.
  - **Times HH:MM**: `@Matches(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)`.
  - **Booleanos**: `@IsBoolean()` con `@IsOptional()` cuando tengan default.
  - **URLs**: `@IsUrl({ require_tld: false })` para soportar Twilio
    media URLs locales.

---

## 3. Authentication

### SupabaseAuthGuard
- Ubicación: `src/infrastructure/auth/supabase-auth.guard.ts`.
- Comportamiento: extrae `Bearer` token, valida contra Supabase Auth,
  inyecta `request.user` con `company_id`.

### 🔴 DEV_AUTH_BYPASS (deuda HIGH conocida)
- Flag de entorno: `DEV_AUTH_BYPASS=true`.
- Cuando está `true` y la request trae `X-Company-Id`, **el guard
  saltea la validación JWT** y usa el header como `request.user.company_id`.
- Único uso legítimo: dev local sin Supabase Auth montado, tests E2E.
- **DEBE estar `false` en producción**. El template `.env.example`
  default es `true` (dev). Cambiar a `false` en cualquier entorno
  prod-like.

### `@Public()`
- Decora endpoints sin auth (webhooks de Twilio, health, root).
- El guard lee la metadata y los deja pasar.

---

## 4. Tenant Isolation (multi-tenant)

### TenantMiddleware
- Ubicación: `src/infrastructure/tenant/tenant.middleware.ts`.
- Resolución del `companyId` (orden de precedencia):
  1. `request.user.company_id` (del JWT validado por el AuthGuard).
  2. `X-Company-Id` header (fallback para llamadas internas/tests).
- Falla con `401 Unauthorized` si ninguno está presente.

### 🔴 X-Company-Id sin JWT (deuda HIGH conocida)
- Cuando `DEV_AUTH_BYPASS=true`, cualquier UUID en `X-Company-Id`
  garantiza acceso al tenant.
- Esto es **el modo actual de operación de la app**. La capa de
  defensa-en-profundidad es la RLS de Postgres + el `service_role_key`
  bypass que NO se quita. Si alguien obtiene un companyId válido y
  llega al backend, accede a los datos de ese tenant.
- Mitigación pendiente: implementar JWT real + retirar el bypass.

### RLS (defensa en profundidad)
- Cada tabla con datos de negocio tiene `company_id` como FK + policies
  RLS.
- El backend usa `service_role_key` (que bypass-ea RLS) — el aislamiento
  efectivo viene del middleware. RLS protege solo si alguien accede a
  Supabase con `anon_key` (frontend SPA, por ejemplo).

---

## 5. Webhooks de Terceros (Twilio)

### Firma HMAC-SHA1
- `WhatsAppController.receive` valida `x-twilio-signature` contra
  `Twilio.validateRequest(authToken, signature, url, body)`.
- **Skip condicional**: cuando `app.env` ∈ {`test`, `development`} la
  validación se omite. Garantiza que en prod-like se enforce.

### Multi-tenant lookup
- `_findEmployeeByPhone(phone)` busca **across all companies** (la app
  no tiene company context antes de identificar al sender).
- 🟡 **Riesgo MEDIUM conocido**: si dos tenants tienen el mismo `phone`
  por algún hueco de validación, el primer match gana. La unique
  partial `(company_id, phone_number) WHERE deleted_at IS NULL` previene
  duplicados dentro de un tenant pero no entre tenants. Mitigación
  futura: requerir tenant context explícito en el primer mensaje
  (handshake).

---

## 6. Error Mapping (PostgresExceptionFilter)

- Filter global registrado en `main.ts` después del ValidationPipe.
- Captura cualquier `Error` no-HTTP y lo traduce a `HttpException` con
  un `errorCode` estable (frontend lo resuelve via i18n).
- Códigos mapeados: `EMPLOYEE_PHONE_DUPLICATE`,
  `EMPLOYEE_EXTERNAL_ID_DUPLICATE`, `MEMBERSHIP_DUPLICATE`,
  `SKILL_DUPLICATE`, `POLICY_INTERPRETER_DUPLICATE`,
  `UNIQUE_VIOLATION`, `NOT_NULL_VIOLATION`, `FOREIGN_KEY_VIOLATION`,
  `CHECK_VIOLATION`, `INTERNAL_ERROR`.
- HttpException ya formada (ValidationPipe, throws explícitos) se
  forwardea sin modificar.

---

## 7. Database Security

### Queries parametrizadas
- `@supabase/supabase-js` parametriza automáticamente. Cero SQL crudo
  manual en el proyecto. Esto elimina los vectores clásicos de SQL
  injection.

### Soft-delete con partial UNIQUE
- Patrón: `is_active=false, deleted_at=NOW()` para borrado lógico.
- **UNIQUE constraints relevantes son partiales** con `WHERE
  deleted_at IS NULL` para permitir re-crear tras borrado:
  - `employees_phone_company_idx (company_id, phone_number)`
  - `employees_external_id_per_company (company_id, external_id)`
  - `shift_memberships_unique_active_per_emp_tpl_from`
  - `company_skills_unique_active_per_company_skill`
  - `company_policies_unique_active_per_interpreter`

---

## 8. Secrets Management

### Estado actual
- `.env`, `.env.test`, `.env.test.twilio` están en `.gitignore`
  (excepción tracked: `.env.example`, template documentado sin valores).
- **Incidente histórico (2026-04-27)**: `.env.test` y `.env.test.twilio`
  estuvieron tracked en git desde el initial commit con secrets reales
  (Supabase service role key, Twilio auth token, Qwen API key,
  DATABASE_URL). Pusheados a GitHub público.
- **Acción requerida**: rotar todas las credenciales que aparecen en
  el historial. Borrarlas del HEAD no las quita del log público.
- **Opcional**: history rewrite con `git filter-repo` o BFG. Disruptivo
  (todos re-clonan).

### En código
- ✅ Cero hardcoded secrets en código tracked (verificado con grep
  de patrones comunes: `sk-*`, `AC[a-f0-9]{32}` Twilio SIDs, JWTs
  base64).
- ✅ Service role key solo se lee de `process.env.SUPABASE_SERVICE_ROLE_KEY`.

---

## 9. Logs

- `Logger` de Nest emite a stdout. **No se loguean** tokens, passwords,
  ni `Authorization` headers (verificado por grep — busca patrones
  `log.*\${.*token` y similares).
- Empleados se loguean por `id` truncado (8 chars) o por nombre, nunca
  por phone.
- Errores de Postgres pasan por el filter — el mensaje completo
  (incluye constraint names) va a logs internos pero **NO al cliente**;
  el cliente solo ve el `errorCode` + mensaje user-friendly.

---

## 10. Deuda Abierta (resumen)

🔴 **HIGH** — bloquean producción
- JWT real (eliminar `DEV_AUTH_BYPASS`).
- Rotación de credenciales expuestas en historial.

🟡 **MEDIUM** — antes de scaling
- Rate limiting (`@nestjs/throttler`) en endpoints LLM (cost) y auth
  (brute force).
- Cross-tenant phone lookup en WhatsApp webhook.
- Twilio signature skip en `development` — garantizar APP_ENV correcto
  en cualquier deploy compartido.

🟢 **DONE** (cerradas en este sprint)
- Validators class-validator en todos los controllers.
- CORS fail-closed por default en prod.
- PostgresExceptionFilter con errorCodes estables.
- Partial UNIQUE indexes para soft-delete.
- `.env*` removidos del tracking + `.env.example` documentado.

---

## 11. Checklist para nuevo endpoint

Antes de mergear:
1. ✅ DTO con class-validator decorators (¿`@IsString @IsNotEmpty` o
   más restrictivo?).
2. ✅ Endpoint registrado en `interfaces.module.ts` (controllers list).
3. ✅ Si requiere tenant context, **NO leer `companyId` del body** —
   leer del `TenantContext` (inyectado por el middleware).
4. ✅ Si es webhook externo, marcar `@Public()` + validar firma.
5. ✅ Si persiste, considerar partial UNIQUE para soft-delete.
6. ✅ Si retorna errores específicos del dominio, agregar mapping al
   `PostgresExceptionFilter` con un `errorCode` estable.
7. ✅ Tests: caso happy + caso 400 (validator triggered) + caso
   conflict (UNIQUE).
