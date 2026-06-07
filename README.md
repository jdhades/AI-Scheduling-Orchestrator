# AI Scheduling Orchestrator

Backend NestJS multi-tenant para generación de horarios de turnos con asistencia de IA. Los empleados interactúan por **WhatsApp** (texto + audio), un manager web administra empleados, plantillas de turno, reglas semánticas, políticas de empresa, y aprobaciones (ausencias, swaps, días libres). El motor de scheduling es **híbrido**: deterministic baseline + LLM authoritative para líneas semanales con verify-loop y fallback. La generación corre **asíncrona** sobre una cola pg-boss con progreso en tiempo real por WebSocket.

> Companion repo (UI admin): [`ai-scheduling-frontend`](https://github.com/jdhades/ai-scheduling-frontend) — Vite + React 19 + TanStack Query.

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | NestJS 10 + Node 20 + TypeScript strict |
| Architecture | Clean Architecture + DDD + CQRS — sin ORM, repositorios directos contra Supabase JS SDK |
| DB | Supabase (PostgreSQL + pgvector + RLS) |
| Auth | Supabase Auth (JWT vía `jose`) + custom access token hook (`company_id` / rol en claims) + RBAC (roles + capabilities + manager scopes) |
| Async jobs | **pg-boss** sobre Postgres (generación de horario + imports); gated por `USE_ASYNC_SCHEDULE_GEN` |
| Realtime | Socket.io (WebSocket gateway propio) — progreso de jobs + notificaciones |
| Sessions / cache | Redis (sesiones de WhatsApp; sin BullMQ) |
| AI providers (intercambiables vía `ACTIVE_AI_PROVIDER`) | Qwen 3.6+ (DashScope, default) · Gemini 2.0 Flash · LM Studio / Ollama (local OpenAI-compat) · Claude (Anthropic SDK, vision para imports) |
| Embeddings | 768-dim, `text-embedding-004`, cosine distance |
| Mensajería | Twilio Programmable Messaging (WhatsApp) · Resend (email transaccional / invitaciones) |
| Billing | Stripe (planes, trials, webhooks) |
| Hardening | Helmet · ValidationPipe global · `@nestjs/throttler` · CORS fail-closed · `nestjs-i18n` |
| Tests | Jest unit + integration (sin mocks de DB en integration) |

---

## Capacidades core

- **Generación híbrida de horario semanal**: `WeekScheduleBuilder` propone líneas vía LLM con verify-loop (max 2 intentos) y fallback determinístico round-robin si el LLM no converge. Corre como job pg-boss con progreso y cancelación por WebSocket.
- **RAG de reglas semánticas**: `RuleStructureExtractor` parsea texto NL → estructura con `intent` (`block` / `permit-multi-shift` / `preference` / `complex`) + matchers (employee/date/hour/shift). Embeddings persistidos en pgvector con dedup por coseno < 0.12.
- **Company Policies** (ver [`.agents/COMPANY-POLICIES.md`](.agents/COMPANY-POLICIES.md)): invariantes tenant-wide ("11h descanso entre turnos", "2 días libres por semana") con patrón **open + interpreter accelerators**. Si un interpreter del registry matchea el texto del manager → constraint deterministic; si no → suggestion-loop LLM-backed que propone reformulaciones verificadas.
- **Suggestion-loop por WhatsApp**: el manager dicta una policy/rule por mensaje; si el LLM no la puede aplicar, recibe una lista numerada de reformulaciones; responde "1"/"2"/"3" o texto libre.
- **Importación multi-modal**: cargar plantel/turnos vía Claude vision (foto/PDF), plantillas Excel (`xlsx`) o JSON canónico → staging → preview con diff por campo → commit transaccional → revert. Snap-to-current-week + anti-duplicate guard.
- **Auth + RBAC multi-tenant**: Supabase Auth con custom claims (`company_id`, rol); guards `@Requires(capability)` / `@Roles()` + manager scopes. Invitaciones por email (Resend) y onboarding self-service.
- **Billing**: Stripe con planes, trials y enforcement (`TrialGuard`); webhooks firmados en `stripe-webhook.controller`.
- **Admin console**: suite de endpoints `/admin/*` — integraciones (Twilio/Resend/Qwen/Gemini/Local LLM con secretos cifrados en Vault + test connection + reload sin restart), LLM allowlist/budgets/usage, prompt history, tenant features/ops, impersonate, jobs, solver-stats, support tickets.
- **Fairness**: score 0-1000 post-hoc; fórmula `(undesirable×2.0) + (night×1.5) + (weekend×1.2) - (voluntary×0.5)`. Persistido en `fairness_history`.
- **Incidents + OCR pipeline**: clasificación de mensajes WhatsApp (texto/audio/PDF/foto) en incidents con state machine (reported → ocr → validated → resolved/rejected).
- **Multi-tenant**: cada tabla con `company_id` + RLS; el JWT (o `X-Company-Id` en dev) resuelve el tenant en cada request.

---

## Quickstart

### Prerequisitos
- Node 20+ y `pnpm` (preferido; `npm` / `yarn` también funcionan)
- Docker (para Supabase local + Redis)
- `npx supabase` CLI

### 1. Clonar e instalar
```bash
git clone <repo>
cd ai-scheduling-orchestrator
pnpm install
```

### 2. Variables de entorno
```bash
cp .env.example .env
# Editar .env con valores reales (NUNCA commitearlo — ya está en .gitignore).
```

Variables requeridas mínimas para arrancar local:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (pg-boss usa esta conexión)
- `REDIS_HOST`, `REDIS_PORT`
- `ACTIVE_AI_PROVIDER` (qwen / gemini / local) + la key correspondiente (`QWEN_API_KEY` / `GEMINI_API_KEY` / `LLM_LOCAL_BASE_URL` + `LLM_LOCAL_MODEL`)
- Para WhatsApp: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL` (ngrok en dev)
- `APP_ENV` / `NODE_ENV`, `PORT`, `ALLOWED_ORIGIN`, `FRONTEND_URL`
- `USE_ASYNC_SCHEDULE_GEN=true` para la generación asíncrona (requiere `DATABASE_URL`; si falta, cae al path síncrono)
- `DEV_AUTH_BYPASS=true` solo en dev (saltea JWT cuando viene `X-Company-Id` header) — **debe ser `false` en staging/prod**

> Integraciones de runtime (Resend, Stripe, providers LLM, Twilio) se gestionan además desde `/admin/integrations` con secretos cifrados en Vault y se recargan sin reiniciar.

### 3. Levantar Supabase + Redis local
```bash
npx supabase start                   # arranca Postgres+pgvector+Auth en Docker
docker run -d -p 6379:6379 redis     # o usar el docker-compose si está
```

### 4. Aplicar migraciones
```bash
npx supabase db reset    # primera vez (aplica todas las migraciones de supabase/migrations/)
# Migraciones nuevas a futuro:
docker exec -i supabase_db_<project> psql -U postgres -d postgres < supabase/migrations/<file>.sql
```

### 5. Run dev
```bash
pnpm start:dev    # NestJS con watch mode
```

API en `http://localhost:3000`. Smoke:
```bash
curl http://localhost:3000/health
```

### 6. Tests
```bash
pnpm test                  # unit + integration
pnpm test:unit             # solo unit
pnpm test:integration      # requiere Supabase corriendo
```

---

## Estructura del proyecto

```
src/
├── domain/                 # Pure business logic — sin Nest, sin Supabase
│   ├── aggregates/         # Employee, ShiftTemplate, ShiftAssignment, SemanticRule, CompanyPolicy, …
│   ├── value-objects/      # FairnessScore, RulePriority, PolicySeverity, …
│   ├── repositories/       # Ports (interfaces) + Symbol tokens
│   ├── services/           # Domain services (RuleStructureExtractor, PolicyInterpreterRegistry, …)
│   └── events/             # Domain events
├── application/            # Use cases CQRS
│   ├── commands/           # Command DTOs
│   ├── queries/            # Query DTOs
│   ├── handlers/           # CommandHandler / QueryHandler
│   └── conversational/     # MessageRouter, CommandMapper (WhatsApp)
├── infrastructure/         # Adapters
│   ├── repositories/       # SupabaseXxxRepository
│   ├── services/           # QwenLLM, GeminiLLM, LocalLLM, Claude vision, Embeddings
│   ├── queue/              # pg-boss lifecycle + bootstrap + cancellation registry
│   ├── stripe/             # Stripe client + webhooks
│   ├── notifications/      # Resend email
│   ├── integrations/       # Vault-backed integration registry (test connection + reload)
│   ├── filters/            # PostgresExceptionFilter (errorCode mapping)
│   ├── auth/               # SupabaseAuthGuard + RBAC guards/decorators (roles, capabilities)
│   ├── tenant/             # TenantMiddleware + TenantContext
│   └── websocket/          # NotificationsGateway (job progress + notifs)
└── interfaces/             # HTTP layer
    ├── controllers/        # CRUD per resource + suite /admin/* + billing + imports
    ├── dtos/               # Class-validator DTOs
    └── controllers/whatsapp.controller.ts  # Webhook Twilio
```

---

## Decisiones arquitectónicas clave

- **Sin ORM**. Repositorios manuales con Supabase JS SDK. Cero overhead de mapping mágico, control total de los queries.
- **CQRS estricto**. Commands y Queries van por `CommandBus`/`QueryBus`. Cero `service.method()` directo desde controllers.
- **Multi-tenant por defecto**. Cada tabla tiene `company_id`; cada repo filtra por `companyId` en cada call. RLS Postgres como segunda línea.
- **Auth real + RBAC**. Supabase Auth con custom access token hook inyecta `company_id`/rol en el JWT; guards de roles + capabilities + manager scopes gobiernan cada endpoint. `DEV_AUTH_BYPASS` queda como escape hatch solo de dev.
- **Generación asíncrona**. La generación de horario corre como job pg-boss sobre Postgres (sin BullMQ), con progreso/cancelación por WebSocket. Si `DATABASE_URL`/`USE_ASYNC_SCHEDULE_GEN` no están, cae al path síncrono.
- **LLM authoritative en scheduling** (Phase 3.5). El builder propone líneas vía LLM, verifica violaciones, retry con feedback, y solo cae al determinístico si el LLM no converge en 2 intentos.
- **Integraciones gestionadas en runtime**. Resend / Stripe / providers LLM / Twilio se configuran desde `/admin/integrations` con secretos cifrados en Vault, test connection y reload sin restart.
- **Open + interpreter accelerators** para policies. Permite multi-tenant flexible sin enum cerrado de tipos. Manager nunca elige type.
- **Suggestion-loop reusable**. Mismo patrón cuando el LLM marca complex (rules) o no matchea interpreter (policies), tanto en web como WhatsApp.

---

## Documentación detallada

| Doc | Contenido |
|---|---|
| [docs/00_root_context.md](docs/00_root_context.md) | **Punto de entrada para agentes IA y devs nuevos**. Roster de agentes, skills, invariantes, business rules, security debt, file map. |
| [docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md) | Estado real (no aspiracional) de seguridad: CORS, ValidationPipe, AuthGuard + RBAC, tenant isolation, error mapping, secrets. |
| [docs/AUTH-BLUEPRINT.md](docs/AUTH-BLUEPRINT.md) | Plan completo del sprint Auth + Multi-tenant (PRs, claims, custom access token hook). |
| [docs/AUTH-PROD-CHECKLIST.md](docs/AUTH-PROD-CHECKLIST.md) | Checklist de cutover de auth a producción + `verify-prod-auth`. |
| [docs/CLOUDFLARE-SETUP.md](docs/CLOUDFLARE-SETUP.md) | Proxy DNS, Turnstile, Tunnel, WAF (decisión CF vs NPM directo). |
| [docs/SUPABASE-ENVS.md](docs/SUPABASE-ENVS.md) | Mapeo de proyectos Supabase por entorno. |
| [.agents/COMPANY-POLICIES.md](.agents/COMPANY-POLICIES.md) | Subsistema completo de Company Policies: diseño, componentes, suggestion-loop, integración solver pendiente, cómo agregar interpreter. |
| [.agents/RULES-ENGINE.md](.agents/RULES-ENGINE.md) | RAG semantic rules + pipeline ingestion + complex bucket. |
| [.agents/SCHEDULER-ENGINE.md](.agents/SCHEDULER-ENGINE.md) | Pipeline employee-first LLM-authoritative + verify-loop + fallback. |
| [.agents/SYSTEM-MAP.md](.agents/SYSTEM-MAP.md) | Vista global del sistema. |
| [.agents/AGENTS.md](.agents/AGENTS.md) | Roster de 8 agentes especializados con sus límites. |
| [.agents/EVENT-FLOWS.md](.agents/EVENT-FLOWS.md) | Flows de eventos (schedule generated, incident reported, etc.). |

---

## Estado de seguridad

🟢 **Cerrado** (sprints Auth/RBAC + audits de seguridad):
- **JWT real** vía Supabase Auth + custom access token hook (`company_id`/rol en claims). RBAC: roles + capabilities + manager scopes con guards por endpoint.
- Cross-tenant data leakage (2 CRITICAL) + cross-tenant lookup cerrados.
- Helmet + ValidationPipe global + `@nestjs/throttler` + CORS fail-closed en prod.
- `PostgresExceptionFilter` con `errorCode` estable + mensajes user-friendly resueltos vía i18n.
- Prompt injection hardening + thresholds de OCR/longitud mínima + deshardcodeo de constantes.
- Secrets de integraciones fuera del código → Vault cifrado, gestionados desde `/admin/integrations`.

🔴 **Pendiente antes de prod**:
- Cutover de auth a producción (ver [`docs/AUTH-PROD-CHECKLIST.md`](docs/AUTH-PROD-CHECKLIST.md)): replicar el hook en el proyecto Supabase de prod, `DEV_AUTH_BYPASS=false`, decidir Cloudflare vs NPM directo.
- Rotar credenciales que estuvieron expuestas en historial git (`.env.test*` antes de 2026-04-27).

Detalle completo: [`docs/SECURITY-ARCHITECTURE.md`](docs/SECURITY-ARCHITECTURE.md).

---

## Status por escenario

| # | Escenario | Estado |
|---|---|---|
| 1 | Foundation & Core DDD | ✅ Complete |
| 2 | Scheduling Engine | ✅ Reworked en Phase 13 (employee-first) + generación async (pg-boss + WS) |
| 3 | Semantic RAG + LLM-authoritative | ✅ Phase 3.5 closed (2026-04-20) |
| 4 | WhatsApp + Voice (Twilio) | ⚙️ ~95% — voice + create_rule + create_policy funcionan |
| 5 | Incident Management + OCR | ⚙️ Conversational works; OCR pipeline pending |
| 6 | Frontend Admin Dashboard | ✅ DataTable + CompanyPolicies + suite /admin |
| 7 | Company Policies + suggestion-loop | ✅ Sprint cerrado (2026-04-27); integración solver = Phase 14 |
| 8 | Auth + RBAC + Multi-tenant | ✅ Staging cerrado; cutover prod pendiente |
| 9 | Billing (Stripe) + Onboarding | ✅ Planes/trials/enforcement + invitaciones (Resend) + self-signup |
| 10 | Importación multi-modal | ✅ Vision/Excel/JSON → staging → preview → commit/revert |

---

## Convenciones

- **Conventional Commits** — siempre invocar el skill `git-commit` antes de commit.
- **TypeScript strict** — `noImplicitAny`, `strictNullChecks`. Spanish en comentarios y dominio OK.
- **No mocking DB en integration tests** — usar Supabase test instance.
- **Antes de un endpoint nuevo**: invocar `backend-security-coder` skill (checklist OWASP top-10 + tenant isolation + RBAC).

---

## Licencia

UNLICENSED — Private project.
