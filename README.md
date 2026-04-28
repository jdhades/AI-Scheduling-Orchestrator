# AI Scheduling Orchestrator

Backend NestJS multi-tenant para generación de horarios de turnos con asistencia de IA. Los empleados interactúan por **WhatsApp** (texto + audio), un manager web administra empleados, plantillas de turno, reglas semánticas, políticas de empresa, y aprobaciones (ausencias, swaps, días libres). El motor de scheduling es **híbrido**: deterministic baseline + LLM authoritative para líneas semanales con verify-loop y fallback.

> Companion repo (UI admin): [`ai-scheduling-frontend`](https://github.com/jdhades/ai-scheduling-frontend) — Vite + React 19 + TanStack Query.

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | NestJS 10 + Node 20 + TypeScript strict |
| Architecture | Clean Architecture + DDD + CQRS — sin ORM, repositorios directos contra Supabase JS SDK |
| DB | Supabase (PostgreSQL + pgvector + RLS) |
| Realtime | Socket.io (WebSocket gateway propio) |
| Async / sessions | Redis (sesiones de WhatsApp; sin BullMQ) |
| AI providers (intercambiables vía `ACTIVE_AI_PROVIDER`) | Qwen 3.6+ (DashScope, default) · Gemini 2.0 Flash · LM Studio / Ollama (local OpenAI-compat) |
| Embeddings | 768-dim, `text-embedding-004`, cosine distance |
| Mensajería | Twilio Programmable Messaging (WhatsApp) |
| Tests | Jest unit + integration (sin mocks de DB en integration) |

---

## Capacidades core

- **Generación híbrida de horario semanal**: `WeekScheduleBuilder` propone líneas vía LLM con verify-loop (max 2 intentos) y fallback determinístico round-robin si el LLM no converge.
- **RAG de reglas semánticas**: `RuleStructureExtractor` parsea texto NL → estructura con `intent` (`block` / `permit-multi-shift` / `preference` / `complex`) + matchers (employee/date/hour/shift). Embeddings persistidos en pgvector con dedup por coseno < 0.12.
- **Company Policies** (subsistema 2026-04, ver [`.agents/COMPANY-POLICIES.md`](.agents/COMPANY-POLICIES.md)): invariantes tenant-wide ("11h descanso entre turnos", "2 días libres por semana") con patrón **open + interpreter accelerators**. Si un interpreter del registry matchea el texto del manager → constraint deterministic; si no → suggestion-loop LLM-backed que propone reformulaciones verificadas.
- **Suggestion-loop por WhatsApp**: el manager dicta una policy/rule por mensaje; si el LLM no la puede aplicar, recibe una lista numerada de reformulaciones; responde "1"/"2"/"3" o texto libre.
- **Fairness**: score 0-1000 post-hoc; fórmula `(undesirable×2.0) + (night×1.5) + (weekend×1.2) - (voluntary×0.5)`. Persistido en `fairness_history`.
- **Incidents + OCR pipeline**: clasificación de mensajes WhatsApp (texto/audio/PDF/foto) en incidents con state machine (reported → ocr → validated → resolved/rejected).
- **Multi-tenant**: cada tabla con `company_id` + RLS; middleware extrae companyId del JWT (con fallback a `X-Company-Id` header — deuda HIGH conocida).

---

## Quickstart

### Prerequisitos
- Node 20+ y `npm` / `yarn` / `pnpm`
- Docker (para Supabase local + Redis)
- `npx supabase` CLI

### 1. Clonar e instalar
```bash
git clone <repo>
cd ai-scheduling-orchestrator
npm install
```

### 2. Variables de entorno
```bash
cp .env.example .env
# Editar .env con valores reales (NUNCA commitearlo — ya está en .gitignore).
```

Variables requeridas mínimas para arrancar local:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`
- `REDIS_HOST`, `REDIS_PORT`
- `ACTIVE_AI_PROVIDER` (qwen / gemini / local) + la key correspondiente (`QWEN_API_KEY` / `GEMINI_API_KEY` / `LLM_LOCAL_BASE_URL`)
- Para WhatsApp: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL` (ngrok en dev)
- `DEV_AUTH_BYPASS=true` en dev (saltea JWT cuando viene `X-Company-Id` header)

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
npm run start:dev    # NestJS con watch mode
```

API en `http://localhost:3000`. Smoke:
```bash
curl http://localhost:3000/health
```

### 6. Tests
```bash
npm test                  # unit + integration
npm run test:unit         # solo unit
npm run test:integration  # requiere Supabase corriendo
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
├── infrastructure/         # Adapters: Supabase, Redis, Twilio, LLMs, filters
│   ├── repositories/       # SupabaseXxxRepository
│   ├── services/           # QwenLLM, GeminiLLM, LocalLLM, Embeddings
│   ├── filters/            # PostgresExceptionFilter (errorCode mapping)
│   ├── auth/               # SupabaseAuthGuard
│   ├── tenant/             # TenantMiddleware + TenantContext
│   └── websocket/          # NotificationsGateway
└── interfaces/             # HTTP layer
    ├── controllers/        # CRUD per resource (employees, shift-templates, …)
    ├── dtos/               # Class-validator DTOs
    └── controllers/whatsapp.controller.ts  # Webhook Twilio
```

---

## Decisiones arquitectónicas clave

- **Sin ORM**. Repositorios manuales con Supabase JS SDK. Cero overhead de mapping mágico, control total de los queries.
- **CQRS estricto**. Commands y Queries van por `CommandBus`/`QueryBus`. Cero `service.method()` directo desde controllers.
- **Multi-tenant por defecto**. Cada tabla tiene `company_id`; cada repo filtra por `companyId` en cada call. RLS Postgres como segunda línea.
- **LLM authoritative en scheduling** (Phase 3.5). El builder propone líneas vía LLM, verifica violaciones, retry con feedback, y solo cae al determinístico si el LLM no converge en 2 intentos.
- **Open + interpreter accelerators** para policies. Permite multi-tenant flexible sin enum cerrado de tipos. Manager nunca elige type.
- **Suggestion-loop reusable**. Mismo patrón cuando el LLM marca complex (rules) o no matchea interpreter (policies), tanto en web como WhatsApp.

---

## Documentación detallada

| Doc | Contenido |
|---|---|
| [docs/00_root_context.md](docs/00_root_context.md) | **Punto de entrada para agentes IA y devs nuevos**. Roster de agentes, skills, invariantes, business rules, security debt, file map. |
| [docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md) | Estado real (no aspiracional) de seguridad: CORS, ValidationPipe, AuthGuard + DEV_AUTH_BYPASS, tenant isolation, error mapping, secrets. |
| [.agents/COMPANY-POLICIES.md](.agents/COMPANY-POLICIES.md) | Subsistema completo de Company Policies: diseño, componentes, suggestion-loop, integración solver pendiente, cómo agregar interpreter. |
| [.agents/RULES-ENGINE.md](.agents/RULES-ENGINE.md) | RAG semantic rules + pipeline ingestion + complex bucket. |
| [.agents/SCHEDULER-ENGINE.md](.agents/SCHEDULER-ENGINE.md) | Pipeline employee-first LLM-authoritative + verify-loop + fallback. |
| [.agents/SYSTEM-MAP.md](.agents/SYSTEM-MAP.md) | Vista global del sistema. |
| [.agents/AGENTS.md](.agents/AGENTS.md) | Roster de 8 agentes especializados con sus límites. |
| [.agents/EVENT-FLOWS.md](.agents/EVENT-FLOWS.md) | 7 flows de eventos (schedule generated, incident reported, etc.). |

---

## Estado de seguridad

🔴 **Pendientes HIGH** (bloquean prod):
- JWT real (hoy `DEV_AUTH_BYPASS` permite operar con `X-Company-Id` solo).
- Rotar credenciales que estuvieron expuestas en historial git (`.env.test*` antes de 2026-04-27).

🟢 **Cerrados en sprint Company Policies (2026-04-27)**:
- ValidationPipe + class-validator en TODOS los controllers.
- CORS fail-closed default en prod.
- `PostgresExceptionFilter` con `errorCode` estable + mensajes user-friendly.
- Partial UNIQUE indexes para soft-delete (no más 500 al recrear).
- Secrets fuera del tracking + `.env.example` documentado.

Detalle completo: [`docs/SECURITY-ARCHITECTURE.md`](docs/SECURITY-ARCHITECTURE.md).

---

## Status por escenario

| # | Escenario | Estado |
|---|---|---|
| 1 | Foundation & Core DDD | ✅ Complete |
| 2 | Scheduling Engine | ✅ Reworked en Phase 13 (employee-first) |
| 3 | Semantic RAG + LLM-authoritative | ✅ Phase 3.5 closed (2026-04-20) |
| 4 | WhatsApp + Voice (Twilio) | ⚙️ ~95% — voice + create_rule + create_policy funcionan |
| 5 | Incident Management + OCR | ⚙️ Conversational works; OCR pending |
| 6 | Frontend Admin Dashboard | ⚙️ DataTable rolled out a 10 listings; CompanyPolicies UI completo |
| 7 | Company Policies + suggestion-loop | ✅ Sprint cerrado (2026-04-27); integración solver = Phase 14 |

---

## Convenciones

- **Conventional Commits** — siempre invocar el skill `git-commit` antes de commit.
- **TypeScript strict** — `noImplicitAny`, `strictNullChecks`. Spanish en comentarios y dominio OK.
- **No mocking DB en integration tests** — usar Supabase test instance.
- **Antes de un endpoint nuevo**: invocar `backend-security-coder` skill (checklist OWASP top-10 + tenant isolation).

---

## Licencia

UNLICENSED — Private project.
