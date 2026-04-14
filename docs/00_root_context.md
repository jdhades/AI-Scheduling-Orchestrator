# Root Context — AI Scheduling Orchestrator

> **MANDATORY LOAD ORDER**: This file MUST be read before any agent or skill file.
> Priority: `docs/ > .agents/ > .agents/skills/`
>
> Generated: 2026-04-11 | Strict mode: ON

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
| **AI engine** | Gemini 2.0 Flash (primary) + Qwen Plus/Max (fallback) |
| **Embeddings** | 768-dim, `text-embedding-004`, cosine distance |
| **Current test count** | 366 passing, 0 TS errors |

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

### Scheduling Engine (9-step pipeline)
1. Load employees + shifts + fairness histories
2. Filter by `shiftTemplateId` if provided
3. Select strategy (cost / fairness / hybrid)
4. `retrieveAllForCompany()` → raw semantic rules
5. `SemanticConstraintInterpreter.interpret()` → structured constraints with `employeeId` + `shiftId`
6. `strategy.generate(employees, shifts, histories, resolvedConstraints)`
7. `scheduleAggregate.validate()` — invariant check (overlaps, etc.)
8. Persist assignments + update fairness histories
9. Publish events + WebSocket notification

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
| Minimum gap between shifts | 11 hours | EU Anti-Clopening Directive |
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

## 6. Data Hierarchy (V2)

```
Organization
  └── Branch
        └── Department
              └── ShiftTemplate  (logical definition — recurrence, skill, demand)
                    └── ShiftInstance  (concrete occurrence — date, employees)
                          └── ShiftAssignment  (employee ↔ shift binding)
```

`ShiftTemplate` is the scheduling unit. `ShiftInstance` is what gets assigned.

---

## 7. Scenario Status

| # | Escenario | State | Tests |
|---|---|---|---|
| 1 | Foundation & Core DDD | ✅ Complete | 139 |
| 2 | Scheduling Engine (3 strategies) | ✅ Complete | 137 |
| 3 | Semantic RAG | ✅ Gap closed (2026-04-11) | +12 new |
| 4 | WhatsApp + Voice (Twilio) | ⚙️ ~90% — voice flow functional | — |
| 5 | Incident Management + OCR | ⚙️ Conversational works; OCR pending | — |
| 6 | Frontend Admin Dashboard | ⚙️ Base structure + Orchestrated Shadow ready | — |

**Escenario 3 gap closed**: `SemanticConstraintInterpreter` now resolves rule text → structured `{employeeId, shiftId}` before strategies run. All three strategies (cost, fairness, hybrid) enforce hard blocks and apply soft score penalties.

---

## 8. Known Security Debt

🔴 **HIGH**
- No JWT/Bearer Token auth — `X-Company-Id` header only; any UUID grants access
- Cross-tenant phone lookup possible in WhatsApp webhook (phone not scoped to companyId)

🟡 **MEDIUM**
- No rate limiting on Gemini API endpoints (cost + abuse risk)
- Twilio HMAC-SHA1 validation skipped when `NODE_ENV=test`
- `companyId` accepted as query param fallback (insecure)
- No global `ValidationPipe`

**Planned mitigations**: `@nestjs/throttler`, JWT middleware, `@CurrentTenant()` decorator, API versioning at `/api/v1/`.

---

## 9. Key File Locations

### Orchestrator critical paths

| Purpose | Path |
|---|---|
| Scheduling engine | `src/domain/services/scheduling-engine.service.ts` |
| Semantic interpreter | `src/domain/services/semantic-constraint-interpreter.ts` |
| RAG retrieval | `src/domain/services/semantic-retrieval.service.ts` |
| Strategy interface | `src/domain/strategies/scheduling-strategy.interface.ts` |
| Cost strategy | `src/domain/strategies/cost-optimized.strategy.ts` |
| Fairness strategy | `src/domain/strategies/fairness-optimized.strategy.ts` |
| Hybrid strategy | `src/domain/strategies/hybrid.strategy.ts` |
| Generate handler | `src/application/handlers/generate-schedule.handler.ts` |
| FairnessHistoryVO | `src/domain/value-objects/fairness-history.vo.ts` |
| Notifications gateway | `src/infrastructure/websocket/notifications.gateway.ts` |

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
- **Handler** (`GenerateScheduleHandler`): validate that `command.weekStart` is ≥ today in UTC before proceeding; throw `BadRequestException` if past
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
