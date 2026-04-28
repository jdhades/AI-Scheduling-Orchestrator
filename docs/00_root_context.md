# Root Context — AI Scheduling Orchestrator

> **MANDATORY LOAD ORDER**: This file MUST be read before any agent or skill file.
> Priority: `docs/ > .agents/ > .agents/skills/`
>
> Generated: 2026-04-11 | Last update: 2026-04-27 (Company Policies sprint) | Strict mode: ON

---

## 1. Project Identity

| Property | Value |
|---|---|
| **Repo** | `ai-scheduling-orchestrator` |
| **Companion repo** | `ai-scheduling-frontend` (Vite + React 19 + Zustand + React Query) |
| **Runtime** | NestJS 10 + Node 20 |
| **Database** | Supabase (PostgreSQL + pgvector + RLS) |
| **Architecture** | Clean Architecture + DDD + CQRS — no ORM, direct SQL |
| **Pattern** | Domain → Application → Infrastructure → Interface (dependencies inward only) |
| **Async jobs** | Redis Streams (no BullMQ) |
| **AI engine** | `qwen3.6-plus` (default, DashScope) — Gemini 2.0 Flash alt, LocalLLMService (LM Studio / Ollama / llama.cpp via OpenAI-compat) — selectable via `ACTIVE_AI_PROVIDER=qwen\|gemini\|local` |
| **Embeddings** | 768-dim, `text-embedding-004`, cosine distance |
| **Current test count** | 381+ passing, 0 TS errors |

---

## 2. Agent Roster

Eight specialized agents are defined in `.agents/AGENTS.md`. Each agent owns a vertical slice:

| # | Agent | Owns | Hard limits |
|---|---|---|---|
| 1 | **architecture-agent** | Cross-cutting decisions, C4 diagrams | Must validate every new module against 4-layer boundary |
| 2 | **backend-agent** | NestJS modules, CQRS handlers, repositories | NEVER touch domain layer from infrastructure |
| 3 | **ai-optimization-agent** | Gemini prompts, embedding pipeline, RAG, SemanticConstraintInterpreter | Must not leak Gemini models into domain |
| 4 | **whatsapp-agent** | Twilio integration, voice transcription, conversational state machine | Always validate HMAC-SHA1 signature |
| 5 | **data-agent** | Supabase migrations, RLS policies, SQL query optimization | Every table must have `company_id` + RLS policy |
| 6 | **test-agent** | Unit, integration, e2e specs | No mocking of database in integration tests |
| 7 | **incident-agent** | Incident reporting NLP, OCR pipeline (Tesseract) | OCR output must be re-validated via AI before persisting |
| 8 | **frontend-agent** | React 19 + Vite + Zustand + React Query admin dashboard | No server-side rendering; SPA only |

---

## 3. Active Skills

Skills live in `.agents/skills/`. Each SKILL.md is a procedural recipe to invoke before implementing a new feature.

### Backend (orchestrator)

| Skill | When to invoke |
|---|---|
| `backend-security-coder` | Any new endpoint, middleware, or handler — OWASP top-10 + tenant isolation checklist |
| `git-commit` | Before every commit — Conventional Commits format, co-author footer |
| `nestjs-module-creation` | New NestJS module scaffold |
| `cqrs-command-handler` | New Command + Handler pair |
| `cqrs-query-handler` | New Query + QueryHandler pair |
| `constraint-modeling` | New business rule → domain value object or strategy constraint |
| `fairness-calculation` | Any change touching FairnessHistoryVO or score formula |
| `supabase-migration` | New table, column, or index |
| `rls-policy` | Any multi-tenant table change |
| `redis-stream-producer` | Publishing to a Redis Stream |
| `redis-stream-consumer` | Consuming from a Redis Stream |
| `semantic-rule-ingestion` | Storing a new natural-language rule in the RAG store |
| `embedding-pipeline` | Batch or on-demand embedding generation |
| `whatsapp-handler` | New Twilio webhook route or message handler |
| `incident-report-parser` | OCR + NLP incident extraction |

### Frontend (ai-scheduling-frontend)

| Skill | When to invoke |
|---|---|
| `frontend-design` | New UI component or layout — design tokens + Tailwind rules |
| `frontend-security-coder` | Any fetch, form, or localStorage operation — XSS + CSRF checklist |
| `frontend-ui-ux-engineer` | New user-facing feature — accessibility + interaction patterns |
| `vercel-react-best-practices` | All React code — 50+ atomic rules covering renders, async, bundles, rerenders |
| `styling` | Tailwind class ordering and design-system conventions |

---

## 4. Architecture Invariants (non-negotiable)

### Domain Layer
- Zero external dependencies — no NestJS, no Supabase, no Gemini in `src/domain/`
- Aggregates expose `getUncommittedEvents()` + `commit()`
- Value Objects are immutable; use `.withX()` factory methods for updates
- All scheduling strategies implement `SchedulingStrategy` interface
- `SemanticConstraint.employeeId = '*'` (`SEMANTIC_BLOCKED_ALL`) means entire shift is blocked

### CQRS
- Commands mutate state; Queries read state — never mix
- Controllers call `CommandBus.execute()` or `QueryBus.execute()` only — zero direct service injection in controllers
- EventBus publishes domain events AFTER aggregate.commit()

### Multi-tenancy
- Every DB table has `company_id` column + matching RLS policy
- `TenantMiddleware` reads `X-Company-Id` header — this is the ONLY source of companyId in handlers
- `companyId` in query params is an insecure fallback — documented as security debt

### Scheduling Engine (LLM-authoritative, Phase 3.5)

The 9-step strategy pipeline was replaced by an employee-first LLM-authoritative flow.

1. Load employees, active `shift_templates`, `shift_memberships`, fairness histories.
2. `ShiftSlotGeneratorService` materializes `VirtualShiftSlot[]` on-demand from templates × week-dates (in-memory value objects; NOT persisted).
3. RAG retrieval → `StructuredRuleResolver.resolve()` splits rules into `constraints` (hard, enforceable) + `unstructuredRules` + `complexRules` + `multiShiftPermits`.
4. `WeekScheduleBuilder.buildWithRetries()`:
   - a. `LLMLineProposerService.proposeLines()` asks the LLM for one weekly line per employee. Prompt is English, uses names (not UUIDs), allows chain-of-thought, injects hard constraints + raw rule texts (unstructured/complex go through untouched, translated to English via a cached prior LLM call).
   - b. `verify()` checks violations: `holiday-worked`, `employee-blocked`, `skill-mismatch`, `two-shifts-same-day`, `unknown-employee`, `unknown-template`.
   - c. If violations, rebuild prompt with feedback and retry once (max 2 LLM attempts).
   - d. If LLM never converges → deterministic fallback (`build()`, the legacy employee-first engine with round-robin).
5. Persist `ShiftAssignment[]` (single source of truth) + update fairness histories.
6. `LLMUsageTracker` emits consolidated log `📊 Hybrid schedule LLM usage — calls=N prompt=P completion=C total=T`.
7. Publish events + WebSocket notification.

### Semantic Constraint Weight Semantics
| Weight | Type | Effect |
|---|---|---|
| 3 | Legal hard block | Hard block; cannot be overridden |
| 2 | Semantic hard block | Hard block (holiday, specific absence) |
| 1 | Soft preference | Score penalty ×1.5; candidate deprioritized but not excluded |

---

## 5. Business Rules

| Rule | Value | Source |
|---|---|---|
| Minimum gap between shifts | 11 hours (default) | `CompanyPolicy` con interpreter `min_rest_hours_between_shifts` — configurable por tenant. Antes era hardcode en `ConflictResolutionService` (código muerto). |
| Min rest days per week | 2 days, holidays excluded (default) | `CompanyPolicy` con interpreter `min_rest_days_per_week`. |
| Max hours per day | 8 h | Labor law |
| Max hours per week | 40 h | Labor law |
| Fairness score range | 0 – 1000 | Domain design |
| Fairness formula | `(undesirable×2.0) + (night×1.5) + (weekend×1.2) - (voluntary×0.5)` | FairnessHistoryVO |
| FairnessThresholdGuard default | 700 | Configurable per company |
| Embedding dimensions | 768 | `text-embedding-004` |
| RAG retrieval threshold | < 0.35 cosine distance | SemanticRetrievalService |
| Deduplication threshold | < 0.12 cosine distance | SemanticDeduplicationService |
| Deduplication fallback | Allow insertion if embedding API fails | Prefer false-negative over data loss |

---

## 6. Data Hierarchy (V3 — Phase 13 rework)

```
Organization
  ├── Branch
  │     └── Department
  │           └── ShiftTemplate        (logical definition — recurrence, skill, demand, required_employees nullable=elastic)
  │                 ├── ShiftMembership      (employee ↔ template with effective dates; stable relationship)
  │                 └── VirtualShiftSlot     (in-memory value object, materialized on-demand: template × date)
  │                       └── ShiftAssignment  (persisted: PK = own UUID; keyed by (templateId, date, origin, empId); requires actualStartTime/actualEndTime)
  ├── SemanticRule[]    (caso particular: "Pablo no trabaja los lunes" — RAG-indexed)
  └── CompanyPolicy[]   (tenant-wide: "11h descanso entre turnos", "2 días libres/semana" — open + interpreter accelerators; ver .agents/COMPANY-POLICIES.md)
```

- `ShiftTemplate` is the scheduling unit.
- `ShiftMembership` replaces the old "employee pegado to a daily shift instance" concept.
- `VirtualShiftSlot` is NOT persisted — it is generated by `ShiftSlotGeneratorService` each time the week is built.
- `ShiftAssignment` is the single persisted output of generation. The legacy `shifts` table is deprecated.
- `required_employees = null` on a template ⇒ **elastic slot** (absorbs leftover employees after exact-target slots are filled).

---

## 7. Scenario Status

| # | Escenario | State | Tests |
|---|---|---|---|
| 1 | Foundation & Core DDD | ✅ Complete | 139 |
| 2 | Scheduling Engine | ✅ Reworked in Phase 13 — employee-first builder replaces the 3 legacy strategies | see `week-schedule-builder.spec` |
| 3 | Semantic RAG + LLM-authoritative | ✅ Phase 3.5 complete (2026-04-20) | — |
| 4 | WhatsApp + Voice (Twilio) | ⚙️ ~90% — voice flow functional | — |
| 5 | Incident Management + OCR | ⚙️ Conversational works; OCR pending | — |
| 6 | Frontend Admin Dashboard | ⚙️ Base structure + Orchestrated Shadow ready | — |

**Phase 3.5 closed**: the LLM is now authoritative over weekly lines (with verify-loop + deterministic fallback). Unstructured/complex rules travel to the prompt as raw text (previously dropped). `target_mode` was added and then removed in the same phase (migration `20260420000000_drop_shift_template_target_mode.sql`). `LLMUsageTracker` records per-generation token cost.

**Company Policies sprint closed (2026-04-26 → 2026-04-27)**: subsystem nuevo para invariantes tenant-wide. Reemplaza hardcodes (11h descanso, 2 días libres por semana). Patrón **open + interpreter accelerators**: el manager escribe en NL; si un interpreter del registry matchea → constraint deterministic; si no → suggestion-loop LLM-backed que propone reformulaciones verificadas. Funciona vía web (`/policies`, `/rules`) y vía WhatsApp (intents `create_policy`, `create_rule`). El `PolicyEnforcementService` está listo para que el `WeekScheduleBuilder` lo invoque, pero la integración al solver activo queda para Phase 14. Detalle: `.agents/COMPANY-POLICIES.md`.

---

## 8. Known Security Debt

> Doc detallado: `docs/SECURITY-ARCHITECTURE.md`.

🔴 **HIGH** — bloquean producción
- **JWT real pendiente**. El guard tiene un `DEV_AUTH_BYPASS=true` que cuando está activo + `X-Company-Id` header presente, salta la validación JWT y usa el header como tenant. Es **el modo actual de operación**. Defensa-en-profundidad: RLS Postgres (cuando se accede con anon_key) + middleware (cuando se accede con service-role).
- **Secrets en historial git**. `.env.test` y `.env.test.twilio` estuvieron tracked desde el initial commit con secrets reales (Supabase service-role key, Twilio auth token, Qwen API key, DATABASE_URL). Hoy están untracked y `.env.example` documenta el template, pero el historial público sigue accesible. **Rotar todas las credenciales** que aparezcan en el historial.

🟡 **MEDIUM** — antes de scaling
- Rate limiting (`@nestjs/throttler`) en endpoints LLM (cost) y auth (brute force).
- Cross-tenant phone lookup en WhatsApp webhook.
- Twilio HMAC-SHA1 skip cuando `app.env` ∈ `test`/`development`.

🟢 **DONE** (cerradas en sprint Company Policies)
- ✅ ValidationPipe + class-validator en TODOS los controllers (rollout completo 2026-04-27).
- ✅ CORS fail-closed default en prod (`ALLOWED_ORIGIN` requerido o `false`).
- ✅ `PostgresExceptionFilter` global con `errorCode` estable que el frontend resuelve via i18n. Mensajes user-friendly sin filtrar info sensible.
- ✅ Partial UNIQUE indexes para soft-delete (phone, external_id, membership, skill, policy interpreter) — re-crear tras delete funciona sin colisión.
- ✅ `.env*` removidos del tracking; `.env.example` template sin valores.

**Planned mitigations**: `@nestjs/throttler`, JWT real, `@CurrentTenant()` decorator, API versioning at `/api/v1/`.

---

## 9. Key File Locations

### Orchestrator critical paths

| Purpose | Path |
|---|---|
| Week builder (employee-first, LLM-authoritative) | `src/domain/services/week-schedule-builder.service.ts` |
| LLM line proposer + rule translation | `src/domain/services/llm-line-proposer.service.ts` |
| Virtual slot materialization | `src/domain/services/shift-slot-generator.service.ts` |
| Rule structure extractor | `src/domain/services/rule-structure-extractor.service.ts` |
| Structured rule resolver | `src/domain/services/structured-rule-resolver.service.ts` |
| Semantic interpreter (legacy, still referenced) | `src/domain/services/semantic-constraint-interpreter.ts` |
| RAG retrieval | `src/domain/services/semantic-retrieval.service.ts` |
| Strategy interface (sole member, no concrete strategies) | `src/domain/strategies/scheduling-strategy.interface.ts` |
| Generate handler (LLM-authoritative) | `src/application/handlers/generate-hybrid-schedule.handler.ts` |
| FairnessHistoryVO | `src/domain/value-objects/fairness-history.vo.ts` |
| VirtualShiftSlot VO | `src/domain/value-objects/virtual-shift-slot.vo.ts` |
| Notifications gateway | `src/infrastructure/websocket/notifications.gateway.ts` |
| Qwen LLM service | `src/infrastructure/services/qwen-llm.service.ts` |
| Gemini LLM service | `src/infrastructure/services/gemini-llm.service.ts` |
| Local LLM service (LM Studio / Ollama) | `src/infrastructure/services/local-llm.service.ts` |
| LLM usage tracker | `src/infrastructure/observability/llm-usage-tracker.service.ts` |
| **Postgres exception filter (errorCode mapping)** | `src/infrastructure/filters/postgres-exception.filter.ts` |
| **CompanyPolicy aggregate** | `src/domain/aggregates/company-policy.aggregate.ts` |
| **PolicyInterpreterRegistry** | `src/domain/services/policy-interpreter-registry.ts` |
| **PolicyEnforcementService (MVP, no wireado al solver)** | `src/domain/services/policy-enforcement.service.ts` |
| **CompanyPolicyCreator (controller + WhatsApp comparten)** | `src/domain/services/company-policy-creator.service.ts` |
| **Suggestion-loop policies (LLM-backed)** | `src/domain/services/llm-rule-rephrase.service.ts` |
| **Suggestion-loop semantic rules** | `src/domain/services/llm-semantic-rule-rephrase.service.ts` |
| **WhatsApp pending clarifications (state machine)** | `src/domain/aggregates/whatsapp-pending-clarification.aggregate.ts` |
| **Permiso configurable por tenant para crear policies vía WhatsApp** | `src/domain/services/whatsapp-policy-permission.service.ts` |

### Agent & skill references

| Purpose | Path |
|---|---|
| Agent roster + boundaries | `.agents/AGENTS.md` |
| 4-layer architecture | `.agents/ARCHITECTURE.md` |
| System navigation map | `.agents/SYSTEM-MAP.md` |
| Scheduling pipeline detail | `.agents/SCHEDULER-ENGINE.md` |
| RAG / rules engine | `.agents/RULES-ENGINE.md` |
| All skills catalog | `.agents/SKILLS-CATALOG.md` |
| Event flows (7 flows) | `.agents/EVENT-FLOWS.md` |
| Backend security skill | `.agents/skills/backend-security-coder/SKILL.md` |
| Git commit skill | `.agents/skills/git-commit/SKILL.md` |
| **Company Policies subsystem** | `.agents/COMPANY-POLICIES.md` |
| **Security architecture (estado real)** | `docs/SECURITY-ARCHITECTURE.md` |

### Antigravity knowledge base

| Purpose | Path |
|---|---|
| Truth engine (master KI) | `/home/jhav/.gemini/antigravity/knowledge/master-orchestrator-v2-status/artifacts/truth_engine.md` |
| Testing status | `/home/jhav/.gemini/antigravity/knowledge/master-orchestrator-v2-status/artifacts/testing_status.md` |
| Architecture report (9 findings) | `/home/jhav/.gemini/antigravity/brain/c85641ac-d05e-41a0-8ecd-14f1fc698344/architecture_report.md` |
| API endpoints (16) | `/home/jhav/.gemini/antigravity/brain/c85641ac-d05e-41a0-8ecd-14f1fc698344/api_endpoints.md` |
| Event flows | `/home/jhav/.gemini/antigravity/brain/c85641ac-d05e-41a0-8ecd-14f1fc698344/event_flows.md` |

---

## 10. Date Resolution Rules (Schedule Generation)

These rules apply whenever a user specifies a week or day for schedule generation:

| Rule | Behavior |
|---|---|
| **Never use past dates** | A `weekStart` must always be today or in the future |
| **Day-number only input** (e.g., "the 13th") | Resolve to the next upcoming occurrence of that day — use next month if the day has already passed this month |
| **Day in future this month** | Use current month |
| **Day already passed this month** | Use next month |
| **Past week generated** | Discard and regenerate using the next valid future date |

### Enforcement points

- **Frontend**: date picker must disable past dates; validate before dispatching generate command
- **Handler** (`GenerateHybridScheduleHandler`): validate that `command.weekStart` is ≥ today in UTC before proceeding; throw `BadRequestException` if past
- **AI/LLM context**: when interpreting free-text scheduling requests, apply the resolution rules above before constructing the command payload

---

## 11. Development Conventions

- **Commits**: Conventional Commits — always invoke `git-commit` skill
- **Language**: TypeScript strict mode; Spanish allowed in comments and domain identifiers
- **Tests**: Unit tests in `test/unit/`, integration in `test/integration/`
- **No mocking DB in integration tests** — real Supabase test instance only
- **New endpoint checklist**: invoke `backend-security-coder` skill before opening PR
- **Domain services**: pure static or stateless class — no `@Injectable()` unless it has external deps
- **Naming**: aggregates in PascalCase, value objects end in `VO`, events end in `Event`, commands end in `Command`
