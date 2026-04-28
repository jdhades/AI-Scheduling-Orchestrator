# ARCHITECTURE.md

System: AI Workforce Scheduling SaaS

Goal:
Generate optimized work schedules, manage incidents automatically, and interact via conversational interfaces.

Architecture style:

- Domain-Driven Design (DDD)
- Clean Architecture
- Command Query Responsibility Segregation (CQRS)
- Event Driven Architecture
- AI Hybrid Decision Engine (Self-Healing)

---

# SYSTEM LAYERS

Presentation Layer

Interfaces:

- Admin Web App / Manager Dashboard (Vite + React 19 + Zustand + React Query + TailwindCSS — SPA, not Next.js)
- Real-time Visual Analytics (Coverage Heatmaps & Demand Heatmaps)
- Employee WhatsApp Bot (Conversational Interface)

Responsibilities:

- capture user inputs
- display schedules and reactive state via React Query / Zustand
- visualize real-time coverage and fairness metrics
- trigger commands via REST APIs and Webhooks

---

Application Layer

Coordinates business use cases using CQRS.

Modules:

ScheduleGeneration
EmployeeManagement
ShiftManagement
Conversational (WhatsApp Router & Mapper)
IncidentProcessing (Auto-Repair)

Responsibilities:

- command and query handling
- orchestration
- integrating Infrastructure services to Domain

---

Domain Layer

Core business logic. Completely agnostic of external frameworks.

Entities and Aggregates:

EmployeeAggregate (Phase 14 — `externalId` para legajo / payroll id)
ShiftTemplateAggregate
ShiftMembershipAggregate (Phase 13)
ShiftAssignmentAggregate (single persisted scheduling output)
SemanticRuleAggregate (carries `structure` JSON produced at ingestion)
CompanyPolicyAggregate (sprint 2026-04-27 — invariantes tenant-wide, "open + interpreter accelerators")
WhatsappPendingClarificationAggregate (state machine del suggestion-loop por WhatsApp)
IncidentAggregate (Scenario 5)
CompanyAggregate / CompanySkillAggregate
WhatsAppHandshakeAggregate

Value Objects:

FairnessHistoryVO
VirtualShiftSlot (materialized on-demand from ShiftTemplate × date)
WorkingTimePolicyVO
ConversationIntentVO
PolicySeverity ('hard' | 'soft' — encapsulado, valida en construcción)
OCRConfidence
MedicalLeavePeriod

Domain Services:

WeekScheduleBuilder — employee-first, LLM-authoritative with verify-loop + deterministic fallback (Phase 3.5)
LLMLineProposerService — builds the English prompt, translates rule texts, parses JSON
ShiftSlotGeneratorService — materializes VirtualShiftSlot[] on-demand
StructuredRuleResolver / RuleStructureExtractor — splits rules into structured vs free-text buckets
FairnessCalculatorService
ConflictResolverService (legacy — código muerto en este momento, no wireado al solver activo)
SemanticRetrievalService
AutoRepairEngine / ConflictResolutionEngine (Scenario 5)
PolicyInterpreterRegistry + concrete interpreters (sprint 2026-04-27) — registry con `findMatch(text)` de los `PolicyInterpreter`s registrados
  · MinRestDaysPerWeekInterpreter — "N días libres por semana" (replaces hardcode)
  · MinRestHoursBetweenShiftsInterpreter — "N horas descanso entre turnos" (replaces 11h hardcode dead-code)
CompanyPolicyCreator — encapsula el flow `findMatch → extract → save` o `rephrase → suggestions`. Reusable por controller HTTP y MessageRouter (WhatsApp)
PolicyEnforcementService — MVP `evaluate(companyId, ctx)` + `formatForPrompt(companyId)`. Ready-to-plug; integración al WeekScheduleBuilder pendiente de Phase 14
LlmRuleRephraseService — suggestion-loop para CompanyPolicy (verifica suggestions contra el registry — descarta hallucinations)
LlmSemanticRuleRephraseService — suggestion-loop para SemanticRule cuando el extractor marca `intent='complex'`
WhatsappPolicyPermissionService — permission check contra `companies.whatsapp_policy_creator_roles[]` (default ['manager'], configurable por tenant)

---

Infrastructure Layer

External services.

Components:

PostgreSQL (Supabase)
Vector Database (pgvector)
Redis Streams (Async Jobs)
WebSockets Server (Real-time Frontend sync)
Twilio API (WhatsApp)
LLM providers (selectable via `ACTIVE_AI_PROVIDER` env):
  - Qwen (DashScope OpenAI-compat) — default, model `qwen3.6-plus`
  - Gemini 2.0 Flash (Google)
  - LocalLLMService — any OpenAI-compat runtime (LM Studio, Ollama, llama.cpp server)
    via `LLM_LOCAL_BASE_URL` + `LLM_LOCAL_MODEL`
Embeddings: Gemini `text-embedding-004` (768-dim)
LLMUsageTracker (AsyncLocalStorage-based token accumulator per generation)
Google Vision API (OCR, Scenario 5)

Responsibilities:

- persistence
- AI integrations
- messaging
- async document processing

---

# DATABASE ARCHITECTURE

Main database:

PostgreSQL (Supabase RLS Enabled)

Tables:

employees (con `external_id` legajo/payroll id, partial UNIQUE per tenant)
company_skills
shift_templates (logical definition)
shift_memberships (Phase 13 — employee ↔ template with effective dates)
shift_assignments (single persisted scheduling output; has its own UUID PK + actualStartTime/actualEndTime)
shifts (legacy — deprecated in Phase 13, not written by new code paths)
semantic_rules (carries `structure` JSONB from ingestion-time LLM)
company_policies (sprint 2026-04-27 — invariantes tenant-wide; partial UNIQUE `(company_id, interpreter_id) WHERE deleted_at IS NULL`)
whatsapp_pending_clarifications (sprint 2026-04-27 — state machine del suggestion-loop, target_kind ∈ {'policy', 'rule'})
companies (con `whatsapp_policy_creator_roles TEXT[]` para permisos configurables del bot)
shift_swap_requests
absence_reports
day_off_requests
incidents (Scenario 5)
incident_events (Scenario 5 - Audit Table)

Partial UNIQUE indexes por soft-delete (sprint 2026-04-27):
- employees_phone_company_idx, employees_external_id_per_company
- shift_memberships_unique_active_per_emp_tpl_from
- company_skills_unique_active_per_company_skill
- company_policies_unique_active_per_interpreter
Cada uno: `WHERE deleted_at IS NULL` — permite recrear tras soft-delete sin colisión.

Vector database:

pgvector

Stores:

semantic_rules (rule_embedding)

---

# AI COMPONENTS

Semantic Rule Engine

- transforms natural language rules into embeddings
- retrieves rules using pgvector (RAG)
- resolves conflicts contextually
- **Suggestion-loop al complex** (sprint 2026-04-27): cuando el extractor marca `intent='complex'`, en vez de persistir como tal, el `LlmSemanticRuleRephraseService` propone 2-3 reformulaciones que sí encajen en el matcher schema. El frontend / WhatsApp muestra picker.

Schedule Generation (LLM-authoritative, Phase 3.5)

- LLMLineProposerService proposes one weekly line per employee (English prompt, chain-of-thought allowed, names instead of UUIDs)
- WeekScheduleBuilder.verify() audits for 6 hard-violation kinds
- Up to 2 LLM attempts (second with feedback on violations)
- Deterministic fallback if the LLM cannot converge
- LLMUsageTracker emits per-generation token totals

Company Policies Engine (sprint 2026-04-27)

- **Open + interpreter accelerators**: el manager submitea texto NL; el `PolicyInterpreterRegistry.findMatch()` busca un interpreter en código que matchee. Si lo encuentra → constraint deterministic. Si no → suggestion-loop LLM-backed con verificación empírica contra el registry.
- **PolicyEnforcementService** (MVP): `evaluate(companyId, ctx)` corre cada interpreter.apply() contra un schedule propuesto y devuelve violations agrupadas por severidad (hard / soft / llm-only). `formatForPrompt(companyId)` rendea el bloque NL para el prompt del LLM.
- **Integración con el solver activo: pendiente de Phase 14**. Los hooks están listos pero `WeekScheduleBuilder` aún no los invoca.

Conversational Engine

- processes audio/text directly via the active LLM provider (Qwen/Gemini/Local per ACTIVE_AI_PROVIDER)
- maps intents directly to CQRS Commands without NLP intermediate pipelines
- **Sprint 2026-04-27**: nuevos intents `create_policy` y `create_policy_clarification`. MessageRouter implementa el suggestion-loop por mensaje (lista numerada → respuesta "1"/"2"/"3"). Permission gate via `WhatsappPolicyPermissionService`.

Auto-Repair Incident Engine (Scenario 5)

- OCR text extraction via Google Vision API
- structured data extraction via the active LLM provider per `ACTIVE_AI_PROVIDER`
- detects affected shifts and automatically finds replacements

Error Mapping (sprint 2026-04-27)

- `PostgresExceptionFilter` global captura cualquier error no-HTTP y lo traduce a `HttpException` con un `errorCode` estable (`EMPLOYEE_PHONE_DUPLICATE`, `MEMBERSHIP_DUPLICATE`, `SKILL_DUPLICATE`, `POLICY_INTERPRETER_DUPLICATE`, `UNIQUE_VIOLATION`, `NOT_NULL_VIOLATION`, `FOREIGN_KEY_VIOLATION`, `CHECK_VIOLATION`, `INTERNAL_ERROR`).
- El frontend resuelve cada `errorCode` vía i18n (EN/ES) — mensajes user-friendly sin filtrar info sensible.

---

# EXTERNAL SERVICES

WhatsApp Messaging: Twilio API
Voice Processing: active LLM provider (Qwen Conversational default; Gemini available; Whisper pipeline for non-multimodal runtimes)
Document Analysis: Google Vision API + active LLM provider for structured extraction (Scenario 5)
Async Task Queueing: Redis Streams (BullMQ explicitly forbidden)

---

# HTTP API SURFACE (controllers actuales)

Cada controller tiene DTO con class-validator (rollout completo 2026-04-27).
Ver `interfaces.module.ts` para la lista completa.

| Resource | Verbs | Notes |
|---|---|---|
| `/employees` | GET / GET:id / POST / PATCH / DELETE | `external_id` opcional, partial UNIQUE. `RegisterEmployeeDto` con class-validator. |
| `/shift-templates` | GET / POST / PATCH / DELETE | `dayOfWeek` nullable (null = todos los días). `requiredSkillId` opcional. |
| `/shift-memberships` | GET / GET:id / POST / DELETE | Sin PATCH (recrear para cambiar). Partial UNIQUE `(employee, template, effective_from)`. |
| `/company-skills` | GET / GET:id / POST / DELETE | Catálogo del tenant (referencia global skill via `skill_id`). Repo tiene revive logic para soft-deleted. |
| `/company-policies` | GET / GET:id / POST / PATCH / DELETE | Subsistema 2026-04-27. POST devuelve discriminated union `{ status: 'created' \| 'needs_clarification' }`. |
| `/rules/semantic` | GET / GET:id / POST / PATCH metadata / PATCH text / DELETE | Suggestion-loop al complex (POST puede devolver `suggestions[]`). PATCH text re-corre embedding + structure (caro). |
| `/incidents` | GET / GET:id / POST / POST:reject / POST:resolve | Estado machine; CQRS via CommandBus. |
| `/shift-swap-requests` | GET / GET:id / POST / POST:approve / POST:reject | |
| `/absence-reports` | GET / GET:id / POST | Read-only en frontend; los crea el bot. |
| `/day-off-requests` | GET / GET:id / POST / POST:approve / POST:reject | |
| `/employees/:id/working-time-policy` | GET | Política por empleado (legacy, reemplazará `CompanyPolicy` cuando se integre al solver). |
| `/fairness-history` | GET / GET:employeeId | |
| `/schedules` | GET / POST:generate / POST:generate/hybrid | Generación deterministic + híbrida. |
| `/webhooks/whatsapp` | POST `@Public()` | Twilio webhook. Firma HMAC validada (skip en dev/test). |
| `/webhooks/whatsapp/incident` | POST `@Public()` | Twilio webhook con media (foto/PDF para OCR). |

---

# REQUEST LIFECYCLE

```
HTTP request
  ↓
[helmet]                   ← network headers seguros
  ↓
[express.urlencoded]       ← Twilio webhooks vienen form-encoded
  ↓
[CORS]                     ← origin: ALLOWED_ORIGIN || (dev?'*':false)
  ↓
[Auth Guard]               ← SupabaseAuthGuard valida JWT (o salta si DEV_AUTH_BYPASS+X-Company-Id)
  ↓
[TenantMiddleware]         ← extrae companyId (jwt.user > X-Company-Id), inyecta TenantContext
  ↓
[ValidationPipe]           ← class-validator + whitelist + forbidNonWhitelisted
  ↓
[Controller]               ← maneja DTO, llama CommandBus/QueryBus o Service
  ↓
[Domain logic]             ← agregados, value objects, services
  ↓
[Repository]               ← Supabase JS SDK (parametrizado, sin SQL crudo)
  ↓
[PostgresExceptionFilter]  ← captura Errors, mapea a errorCode estable + status HTTP
  ↓
HTTP response (JSON)
```

---

# ERROR HANDLING (sprint 2026-04-27)

`PostgresExceptionFilter` (global, registrado en `main.ts`):

- **HttpException**: forwardea sin tocar (incluye errores de ValidationPipe).
- **Postgres unique_violation (23505)**: regex match contra constraint name → mapeo a `errorCode` estable. Si no hay mapping específico → `UNIQUE_VIOLATION` genérico con el constraint name.
- **not_null_violation (23502)**: extrae columna → `NOT_NULL_VIOLATION` con `field`.
- **foreign_key_violation (23503)**: → `FOREIGN_KEY_VIOLATION`.
- **check_violation (23514)**: → `CHECK_VIOLATION`.
- **Cualquier otro Error**: → `INTERNAL_ERROR` con stack en logs server-side, mensaje genérico al cliente.

Mapeo activo de constraints → errorCodes:

| Constraint | ErrorCode |
|---|---|
| `employees_phone_company_idx` | `EMPLOYEE_PHONE_DUPLICATE` |
| `employees_external_id_per_company` | `EMPLOYEE_EXTERNAL_ID_DUPLICATE` |
| `shift_memberships_unique_active_per_emp_tpl_from` | `MEMBERSHIP_DUPLICATE` |
| `company_skills_unique_active_per_company_skill` | `SKILL_DUPLICATE` |
| `company_policies_unique_active_per_interpreter` | `POLICY_INTERPRETER_DUPLICATE` |

> Para agregar mapeo nuevo: editar `CONSTRAINT_ERROR_CODES` en `src/infrastructure/filters/postgres-exception.filter.ts` + sumar la clave i18n al frontend en `src/lib/i18n.ts`.

---

# SUGGESTION-LOOP PATTERN (sprint 2026-04-27)

Patrón abstracto que aparece en 4 superficies:

```
1. User submits free-text
   ↓
2. System tries deterministic match (interpreter / matcher schema)
   ↓
3a. Matched → persist + reply success
3b. No match → ask LLM for 2-3 reformulations targeting available patterns
   ↓
4. Verify suggestions empirically (descarta hallucinations)
   ↓
5a. Suggestions valid → return to user as picker (NO persiste)
5b. No valid suggestions → fallback (LLM-only persist, o reject según subsystem)
   ↓
6. User picks → re-submit with chosen text → loop possibly repeats
```

Implementaciones:
| Superficie | Patrón disponible | Verificación |
|---|---|---|
| Web `/company-policies` | `PolicyInterpreterRegistry.findMatch` | `LlmRuleRephraseService` corre `findMatch` contra cada sugerencia |
| Web `/rules/semantic` | `RuleStructureExtractor` (LLM) | `LlmSemanticRuleRephraseService` NO pre-verifica (costaría 3 LLM extra); confía y verifica al re-submit |
| WhatsApp `create_policy` | misma + permission check | misma |
| WhatsApp `create_rule` | misma + permission check | misma |

Estado en WhatsApp se persiste en `whatsapp_pending_clarifications`. Lookup `(employee_id, created_at DESC) WHERE resolved_at IS NULL`. TTL default 10 min.

---

# SECURITY

> Detalle completo: `docs/SECURITY-ARCHITECTURE.md`.

Authentication:
- `SupabaseAuthGuard` valida Bearer JWT.
- 🔴 **Deuda HIGH**: `DEV_AUTH_BYPASS=true` + header `X-Company-Id` → salta JWT. Es el modo actual de operación. Defensa-en-profundidad: RLS Postgres (cuando se accede con anon_key) + middleware (cuando se accede con service-role).

Tenant Isolation:
- Roles: Admin, Manager, Employee (consumido por `WhatsappPolicyPermissionService` para permisos configurables del bot).
- Row Level Security: cada tabla tiene `company_id` + RLS policy.
- TenantMiddleware: lee `request.user.company_id` (JWT) > `X-Company-Id` header (fallback).

Input Validation:
- ValidationPipe global + class-validator en TODOS los controllers (rollout completo 2026-04-27).
- Convenciones: `@IsString @IsNotEmpty` para IDs (la seed data usa UUID-shape no estricto RFC 4122 — `@IsUUID` los rechazaría); `@Matches /^\d{4}-\d{2}-\d{2}$/` para fechas; `@Matches HH:MM` para times.

Webhooks externos:
- Twilio firma HMAC-SHA1 validada en `WhatsAppController` (skip en dev/test).
- Endpoints `@Public()` whitelisted en TenantMiddleware exclude list.

Phone linking:
- UUID handshake (`HandshakeToken`).

Secrets management:
- `.env*` en `.gitignore` (excepto `.env.example` template).
- 🔴 **Incidente histórico (2026-04-27)**: `.env.test` y `.env.test.twilio` estuvieron tracked desde el initial commit con secrets reales (Supabase service-role, Twilio token, Qwen API key). Pusheados a GitHub público. Acción pendiente: rotar credenciales.

---

# SCALABILITY

Stateless API servers
Horizontal scaling
Separate event consumers for:
- AI scheduling
- OCR processing (Vision Consumer)
- Auto-Repair
