# SYSTEM-MAP.md

Project:
AI Workforce Scheduling SaaS

Version:
1.3 (Sprint Company Policies — 2026-04-27)

Purpose:
Provide a unified map of the entire system architecture, documentation, and AI components.

This document is the primary entry point for both developers and AI agents interacting with the project.

---

# SYSTEM OVERVIEW

The platform is an AI-driven workforce scheduling system that:

- generates optimized schedules
- manages shifts via WhatsApp
- processes incidents automatically
- ensures fair workload distribution
- enforces tenant-wide policies via configurable interpreters with LLM fallback

Core capabilities:

AI Schedule Generation (Hybrid Logic, LLM-authoritative + verify-loop + deterministic fallback)
Semantic Rule Engine (RAG, pgvector, structure extraction)
Company Policies subsystem (open + interpreter accelerators) ← sprint 2026-04-27
Suggestion-loop LLM-backed para policies y rules complex ← sprint 2026-04-27
Skill-based Shift Assignment + skill→template requirement
Voice/Text Interaction via WhatsApp (intents: swap_shift, report_absence, check_schedule, request_day_off, generate_schedule, create_rule, create_policy)
Automated Incident Processing (Auto-Repair, OCR pipeline)
Real-time Visual Analytics (Heatmaps & Live Dashboards via WebSocket)
Multi-language UI con suggestion-loop (EN/ES via i18next)
Error mapping con errorCodes estables resueltos via i18n en frontend

---

# CORE SYSTEM COMPONENTS

The system is composed of the following major subsystems.

1. **Scheduling Engine** — `WeekScheduleBuilder` LLM-authoritative + `LLMLineProposerService` + verify-loop + deterministic fallback
2. **Semantic Rule Engine** — RAG con pgvector + `RuleStructureExtractor` + suggestion-loop al complex
3. **Company Policies Engine** (NEW 2026-04-27) — `PolicyInterpreterRegistry` + `CompanyPolicyCreator` + `LlmRuleRephraseService` + `PolicyEnforcementService` (MVP)
4. **Workforce Management System** — Employees con `external_id`, ShiftTemplates con skill requirement, ShiftMemberships con effective dates
5. **Messaging & Voice Interface** (Twilio + Qwen/Gemini conversational) con `MessageRouter` + `WhatsappPendingClarification` state machine
6. **Incident Processing System** (Google Vision/Redis Streams)
7. **Data Platform** (Supabase pgvector + RLS multi-tenant)
8. **API Integration Layer** (NestJS CQRS + `PostgresExceptionFilter` con errorCodes estables)
9. **Frontend Admin Dashboard** (Vite + React 19 + TanStack Table + i18next bilingüe)

---

# DOCUMENTATION MAP

This project contains several architecture documents located in `.agents/`.

Each document serves a specific purpose.

---

## AGENTS

File:
agents.md

Purpose:
Define AI agents responsible for development and operations.

Includes:
agent roles  
agent responsibilities  
agent skills  
agent boundaries  

Used by:
AI coding assistants  
automation systems

---

## ARCHITECTURE

File:
architecture.md

Purpose:
Describe system architecture and infrastructure using DDD and CQRS.

Includes:
system layers  
database design  
AI components  
external services  

Used by:
backend engineers  
platform engineers

---

## EVENT FLOWS

File:
event-flows.md

Purpose:
Define event-driven workflows across the platform.

Includes:
core domain events (NestJS EventBus)  
workflow pipelines  
automation triggers (Redis Streams)

Used by:
backend engineers  
integration developers

---

## SKILLS CATALOG

File:
skills-catalog.md

Purpose:
Define reusable procedural skills for AI agents.

Inspired by:
skills.sh

Includes:
engineering skills  
AI modeling skills  
database skills  
messaging skills (Voice/Text)  
testing skills (TDD)
Computer vision & text extraction (Scenario 5)

Used by:
AI development agents

---

## RULES ENGINE

File:
rules-engine.md

Purpose:
Describe the semantic rule processing system.

Includes:
natural language rules  
vector embeddings (text-embedding-004)  
constraint generation  
rule conflict resolution (RuleResolver / Priorities)

Used by:
AI engine developers

---

## SCHEDULER ENGINE

File:
scheduler-engine.md

Purpose:
Define the optimization engine responsible for generating schedules.

Includes:
constraint modeling  
optimization algorithms (Domain constraints + Heuristics)  
fairness metrics  
LLM logic validation

Used by:
AI optimization engineers

---

# SYSTEM LAYERS

The platform follows Clean Architecture.

---

## Presentation Layer

Interfaces:

Vite + React 19 Admin Dashboard (SPA — NOT Next.js)
Interactive Schedule Grid
Coverage & Demand Heatmaps
Employee WhatsApp Interface

Responsibilities:

user interaction & manual shift editing  
command submission (REST APIs)  
real-time schedule and fairness visualization (WebSockets)  

---

## Application Layer

Coordinates use cases.

Modules:

Schedule Generation  
Shift Management  
Employee Management  
Incident Processing (Self-Healing)  
Conversational Routing  

Responsibilities:

CQRS command and query orchestration  
event delegation  

---

## Domain Layer

Core business logic. Pure TypeScript, agnostic of frameworks.

Aggregates:

EmployeeAggregate
ShiftTemplateAggregate
ShiftMembershipAggregate (Phase 13)
ShiftAssignmentAggregate (single persisted scheduling output)
SemanticRuleAggregate (with `structure` JSONB)
IncidentAggregate
CompanyAggregate / CompanySkillAggregate
WhatsAppHandshakeAggregate

Domain Services:

WeekScheduleBuilder (employee-first, LLM-authoritative + verify-loop + deterministic fallback)
LLMLineProposerService (builds EN prompt, translates rules, parses JSON)
ShiftSlotGeneratorService (materializes VirtualShiftSlot on-demand)
StructuredRuleResolver / RuleStructureExtractor
FairnessCalculatorService
ConflictResolverService
SemanticRetrievalService
AutoRepairEngine / ConflictResolutionEngine (Scenario 5)

---

## Infrastructure Layer

External integrations.

Components:

PostgreSQL database (Supabase + RLS)
pgvector extension (vector search)
Redis Streams (background jobs; BullMQ forbidden)
WhatsApp API (Twilio)
LLM providers (selected via `ACTIVE_AI_PROVIDER`):
  - QwenLLMService (default, `qwen3.6-plus` on DashScope)
  - GeminiLLMService (Gemini 2.0 Flash)
  - LocalLLMService (LM Studio / Ollama / llama.cpp via OpenAI-compat)
Embeddings: Gemini `text-embedding-004` (768-dim)
LLMUsageTracker (AsyncLocalStorage token accumulator per generation)
Google Vision API (OCR extraction, Scenario 5)

Responsibilities:

data persistence  
external communication  
async processing  

---

# DATA FLOW MAP

The following describes the major data flows.

---

## Schedule Generation Flow

Trigger:
Manager requests schedule generation.

Flow:
Manager Request
→ GenerateHybridScheduleCommand
→ Handler loads employees + templates + memberships + histories
→ ShiftSlotGeneratorService materializes VirtualShiftSlot[] on-demand
→ SemanticRetrievalService loads rules (pgvector, top-K, cosine < 0.35)
→ StructuredRuleResolver splits into {constraints, unstructured, complex, permits}
→ WeekScheduleBuilder.buildWithRetries()
   • LLMLineProposerService proposes weekly lines (EN prompt, chain-of-thought)
   • verify() checks 6 hard-violation kinds
   • up to 2 LLM attempts, then deterministic fallback
→ ShiftAssignment[] persisted + fairness histories updated
→ LLMUsageTracker emits consolidated token-usage log
→ ScheduleGenerated event
→ WebSocket broadcast + WhatsApp notification

---

## Voice Command Flow

Employee sends voice note via WhatsApp.

Flow:
Voice Message (.ogg payload)
→ MessageRouterService
→ Active LLM provider converts audio+prompt to ConversationIntentVO (Qwen/Gemini multimodal, or Whisper→LLM for non-multimodal runtimes)
→ CommandMapperService (translates JSON intent to Application Command)
→ Command Handler (e.g. SwapShiftHandler)
→ WhatsApp Response via NotificationService

---

## Create-Policy / Create-Rule Flow via WhatsApp (sprint 2026-04-27)

Manager dicta una regla/política por mensaje.

Flow:
Text/voice → ConversationIntentVO (intent='create_policy' o 'create_rule')
→ MessageRouterService
→ permission check via WhatsappPolicyPermissionService (consulta companies.whatsapp_policy_creator_roles[])
→ Policy: CompanyPolicyCreator.create() — registry.findMatch() o LlmRuleRephraseService
   Rule: CommandBus → CreateSemanticRuleHandler — RuleStructureExtractor + LlmSemanticRuleRephraseService si complex
→ Si necesita clarification:
   · WhatsappPendingClarification persistida (target_kind='policy' o 'rule', suggestions JSONB, expires_at NOW+10min)
   · session.pendingAction = 'create_policy_clarification' o 'create_rule_clarification'
   · Bot responde con lista numerada
→ User responde "1"/"2"/"3" o texto libre:
   · MessageRouter detecta pendingAction, busca pending entry
   · pickByNumber(n) → markResolved → re-execute con texto elegido
   · Loop posiblemente repite si la elección también dispara complex
→ Resultado final: policy/rule persistida + reply ✓ al manager

---

## Suggestion-Loop Pattern (cross-cutting)

Patrón abstracto que aparece en 4 superficies distintas.

```
1. User submits free-text (NL)
2. System tries deterministic match
   · Policies: PolicyInterpreterRegistry.findMatch(text)
   · Rules:   RuleStructureExtractor.extract(text) → intent
3a. Matched / non-complex → persist + reply success
3b. No match / intent='complex' → ask LLM (RuleRephrase service correspondiente)
4. Verify suggestions empirically (descarta hallucinations)
   · Policies: corre findMatch contra cada sugerencia
   · Rules: NO pre-verifica (costaría 3 LLM extra); verifica al re-submit
5a. Suggestions valid → return picker (NO persiste)
5b. No valid suggestions → fallback (LLM-only persist o reject)
6. User picks → re-submit → loop possibly repeats
```

---

## Incident Processing Flow (Scenario 5 Auto-Repair)

Employee submits medical certificate via WhatsApp.

Flow:
Image Upload  
→ WhatsAppController  
→ CreateIncidentCommand  
→ Incident processing stream (Redis)  
→ Vision Consumer runs Google Vision OCR
→ Active LLM provider parses OCR text into structured data
→ IncidentValidation rules applied  
→ IncidentValidatedEvent  
→ Auto-Repair Engine detects broken shifts and searches replacements  
→ Shift/Schedule Update  

---

# EVENT SYSTEM

The system uses domain events dispatched through NestJS CQRS `@nestjs/cqrs`.

Key events:

EmployeeCreated  
ScheduleGenerationRequested  
ScheduleGenerated  
ShiftSwapRequested  
IncidentReportedEvent  
MedicalLeaveSubmitted  
IncidentValidatedEvent  

Events are consumed by:

notification service  
analytics service  
AI Auto-Repair engine  
Vision Consumer Worker  

---

# AI SYSTEM MAP

The platform includes several AI modules.

---

## Schedule Optimization AI

Purpose:
Generate optimal workforce schedules.

Technologies:
LLM-authoritative proposer (Qwen/Gemini/Local), verify-loop with feedback, deterministic fallback

Documentation:
scheduler-engine.md

---

## Semantic Rule AI

Purpose:
Convert natural language rules into embeddings and constraints.

Technologies:
text-embedding-004, pgvector search, RAG

Documentation:
rules-engine.md

---

## Voice Interaction AI

Purpose:
Interpret audio/text commands directly from WhatsApp without intermediate NLP services.

Technologies:
Active LLM provider per `ACTIVE_AI_PROVIDER` (Qwen / Gemini / Local). For multimodal-incapable providers, a Whisper stage precedes LLM intent extraction.

---

## Computer Vision & Auto-Repair AI

Purpose:
Extract text from medical certificates and parse cleanly into structured JSON.

Technologies:
Google Vision API + active LLM provider (Qwen/Gemini/Local) for structured extraction

---

## Company Policies AI (sprint 2026-04-27)

Purpose:
Permitir al manager describir invariantes tenant-wide en lenguaje natural y aplicarlas determinísticamente cuando es posible, con suggestion-loop LLM-backed cuando el texto es ambiguo.

Pieces:
- `PolicyInterpreterRegistry` — busca interpreters concretos en código que matcheen el texto.
- Interpreters concretos (`MinRestDaysPerWeekInterpreter`, `MinRestHoursBetweenShiftsInterpreter`) — heurísticas regex + LLM para extracción de params.
- `LlmRuleRephraseService` — pide al LLM 2-3 reformulaciones cuando ningún interpreter matchea, las verifica empíricamente contra el registry (filtra hallucinations).
- `CompanyPolicyCreator` — encapsula el flow completo. Reusable por controller HTTP y MessageRouter (WhatsApp).
- `PolicyEnforcementService` — `evaluate(companyId, ctx)` corre interpreters contra schedule + `formatForPrompt(companyId)` rendea bloque NL. **MVP wireado pero no invocado por el solver activo todavía**.

Documentation:
.agents/COMPANY-POLICIES.md (subsistema completo)

---

## Suggestion-Loop AI (sprint 2026-04-27)

Purpose:
Cuando el LLM marca contenido del manager como complex / no-aplicable, en vez de devolver un error, le proponemos reformulaciones que sí encajan en el matcher schema o el interpreter registry.

Surfaces:
- `LlmRuleRephraseService` para CompanyPolicy (con verification contra registry).
- `LlmSemanticRuleRephraseService` para SemanticRule cuando intent='complex' (sin verification — la verificación pasa al re-submit).

UX en frontend:
- Web: dialogs muestran picker con 2-3 opciones + texto explicativo + click para auto-completar.
- WhatsApp: bot manda lista numerada; usuario responde "1"/"2"/"3" o texto libre que reinicia el flow.

---

# DATABASE SYSTEM

Primary Database: Supabase PostgreSQL

Stores:
employees (con `external_id` legajo/payroll, partial UNIQUE per tenant)
companies (con `whatsapp_policy_creator_roles TEXT[]` — permisos configurables del bot)
company_skills (revive logic en repo: si soft-deleted, lo restaura en POST en lugar de fallar)
shift_templates (logical definitions, con requiredSkillId opcional)
shift_memberships (Phase 13 — employee ↔ template con effective dates)
shift_assignments (single persisted scheduling output; `actualStartTime`/`actualEndTime` required)
shifts (legacy — deprecated in Phase 13)
semantic_rules (con `structure` JSONB; intent='complex' triggerea suggestion-loop al crear)
company_policies (sprint 2026-04-27 — invariantes tenant-wide, `interpreter_id` opcional, partial UNIQUE)
whatsapp_pending_clarifications (sprint 2026-04-27 — state machine del bot, target_kind ∈ policy/rule, expires_at)
shift_swap_requests
absence_reports
day_off_requests
incidents
incident_events

Partial UNIQUE indexes (sprint 2026-04-27 — soft-delete safe):
- `employees_phone_company_idx` WHERE deleted_at IS NULL
- `employees_external_id_per_company` WHERE deleted_at IS NULL
- `shift_memberships_unique_active_per_emp_tpl_from`
- `company_skills_unique_active_per_company_skill`
- `company_policies_unique_active_per_interpreter`

Estos previenen que un soft-delete bloquee la re-creación con los mismos valores (antes: 500 unique violation).

Vector Database: pgvector

Stores:
semantic_rules (rule_embedding 768-dim, cosine distance)
Dedup threshold: < 0.12 (paráfrasis directas)
RAG retrieval threshold: < 0.35 (relevancia para scheduling)

---

# SECURITY MODEL

> Detalle completo: `docs/SECURITY-ARCHITECTURE.md`.

Authentication
- `SupabaseAuthGuard` valida Bearer JWT (cuando existe).
- 🔴 **DEV_AUTH_BYPASS=true (deuda HIGH)**: si el flag está activo Y la request trae `X-Company-Id`, el guard salta JWT. Es el modo actual de operación.

Authorization Roles
- Admin (full access)
- Manager (default — único role autorizado por default a crear policies via WhatsApp; configurable en `companies.whatsapp_policy_creator_roles[]`)
- Employee (operaciones propias: swaps, ausencias, días libres)

Multi-tenancy
- Row Level Security (RLS) policies por `company_id`.
- `TenantMiddleware` lee `request.user.company_id` (JWT) > `X-Company-Id` header (fallback). Inyecta `TenantContext` para que repos lo consulten.
- Backend usa `service_role_key` (bypass RLS); el aislamiento efectivo viene del middleware. RLS es defensa-en-profundidad si alguien accede con `anon_key` (frontend SPA, por ejemplo).

Phone linking
- UUID handshake verification (HandshakeToken).

Input Validation (sprint 2026-04-27)
- ValidationPipe global + class-validator en TODOS los controllers.
- Convenciones: `@IsString @IsNotEmpty` para IDs (seed UUID-shape no estricto RFC 4122); `@Matches /^\d{4}-\d{2}-\d{2}$/` fechas; HH:MM regex para times.

CORS (sprint 2026-04-27)
- En dev/test: default `*`.
- En prod sin `ALLOWED_ORIGIN` setado: default `false` (fail-closed).
- `ALLOWED_ORIGIN` puede ser string único o lista comma-separated.

Error Mapping (sprint 2026-04-27)
- `PostgresExceptionFilter` global mapea Postgres errors a HTTP exceptions con `errorCode` estable.
- Frontend resuelve `errorCode` via i18n (EN/ES). Mensajes user-friendly sin filtrar info sensible.

Webhooks
- Twilio firma HMAC-SHA1 validada (skip en dev/test).
- Endpoints `@Public()` en TenantMiddleware exclude list.

Secrets Management (sprint 2026-04-27)
- `.env*` en `.gitignore` (excepto `.env.example` template documentado).
- 🔴 **Incidente histórico**: `.env.test` y `.env.test.twilio` estuvieron tracked desde el initial commit con secrets reales (Supabase service-role, Twilio, Qwen). Pusheados a GitHub público. Acción pendiente: rotar todas las credenciales que aparezcan en historial.

---

# SCALABILITY STRATEGY

Stateless API servers (NestJS App)

Horizontal scaling

Async Resiliency:
Redis Streams (No BullMQ) handling long-living tasks:
- Vision OCR processing
- Auto-Repair matching

Worker Consumers:
- vision-processing.consumer
- notification.consumer

---

# TEST STRATEGY

TDD methodology extensively applied.

Unit Testing:
Testing Aggregates, Event Handlers, and VO logic isolated from infrastructure using Mocks and Jest Fake Timers.

Coverage targets: >80% total.

---

# PROJECT NAVIGATION GUIDE

For new developers or AI agents:

Start with:
SYSTEM-MAP.md

Then read:
architecture.md  
event-flows.md  
scheduler-engine.md  

Finally explore:
skills-catalog.md  
rules-engine.md  
agents.md  

This order ensures full understanding of the system's Domain, CQRS patterns, and AI interactions.
