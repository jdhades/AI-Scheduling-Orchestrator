# AGENTS.md
Project: AI Workforce Scheduling SaaS
Version: 1.3
Last Updated: 2026-04-28

Purpose:
Define the AI agents, their responsibilities, and the skills they use to build, maintain, and operate the scheduling platform.

This document follows the SKILL.md / skills.sh philosophy where agents use modular procedural capabilities.

Cross-references (read together with this doc):
- ARCHITECTURE.md — entities, services, request lifecycle, error handling
- SYSTEM-MAP.md — component map, capabilities, security model
- EVENT-FLOWS.md — domain events, integration flows (incl. FLOW 6/7/8 for policies)
- COMPANY-POLICIES.md — open + interpreter-accelerator subsystem
- RULES-ENGINE.md — semantic rules, suggestion-loop, dedup
- SCHEDULER-ENGINE.md — WeekScheduleBuilder + Phase 14 (policy-aware) plan
- SECURITY-ARCHITECTURE.md — DEV_AUTH_BYPASS, CORS, ValidationPipe, error mapping

---

# AGENT ECOSYSTEM

The system is built and maintained by specialized AI agents.

Each agent has:
- responsibilities
- skills
- boundaries
- tools

Agents collaborate through event-driven workflows.

---

# AGENT LIST

| Agent | Responsibility | Trigger |
|------|------|------|
Architecture Agent | Maintain system design integrity | New features
Backend Agent | Implement APIs, CQRS business logic, and Domain | Backend tasks
AI Optimization Agent | Maintain scheduling and Auto-Repair engine | Optimization tasks
Policy & Rules Agent | Maintain CompanyPolicy + RuleEngine + suggestion-loop | Policy/rule tasks
WhatsApp Agent | Maintain messaging and conversational flows incl. policy/rule creation flows | Messaging features
Data Agent | Maintain database schema, pgvector, partial unique indexes, and migrations | Data changes
Test Agent | Create automated tests (Unit, E2E) | Every PR
Incident Agent | Handle computer vision, OCR, and automated recovery workflows | Incident reported (Scenario 5)
Frontend Agent | Implement React UI, DataTable, i18n, error mapping, and real-time state | UI tasks (Scenario 6)

---

# AGENT SKILLS

Each agent uses modular skills inspired by skills.sh.

---

# Architecture Agent

Purpose:
Maintain clean architecture, DDD, CQRS, and system boundaries.

Skills:

system-design
- Create architecture diagrams
- Maintain bounded contexts
- Validate CQRS separation

architecture-review
- Ensure modules follow domain boundaries
- Detect tight coupling

event-storming
- Maintain domain event map
- Validate event-driven flows

Boundaries:

ALWAYS
- preserve Clean Architecture and Domain-Driven Design (DDD).
- enforce domain boundaries (Aggregates, Value Objects, Domain Events).

ASK BEFORE
- modifying core domain logic.

NEVER
- mix infrastructure code with domain logic.

---

# Backend Agent

Purpose:
Implement API services, CQRS application commands, and domain logic.

Skills:

nestjs-development
- build modules, controllers, and services.
- enforce class-validator DTOs in EVERY controller (rolled out across absence-reports, day-off-requests, incidents, shift-templates, shift-swap-requests during the 2026-04 sprint to close silent 400s).
- prefer `@IsString @IsNotEmpty` over `@IsUUID` because the dev/seed UUIDs are not strict RFC 4122.

cqrs-pattern
- implement commands, queries, and event handlers.
- separate write/read models.

database-design
- maintain relational schema in Supabase (PostgreSQL).
- ensure indexes and RLS (Tenant Isolation).
- use partial UNIQUE indexes (`WHERE deleted_at IS NULL`) so soft-deleted rows can be re-created (employees by phone is the canonical example).

api-first-design
- maintain public APIs.
- generate webhook handlers.
- map Postgres errors to stable `errorCode` strings via `PostgresExceptionFilter` (global) so the frontend can localize without coupling to driver text.

domain-services
- extract reusable orchestration (e.g. `CompanyPolicyCreator`) when the same flow is shared by web (HTTP) and WhatsApp (intent router). The controller becomes thin DTO ↔ HTTP translator.

Tools:

NestJS
class-validator + class-transformer (with global ValidationPipe: `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`)
PostgresExceptionFilter (global APP_FILTER mapping 23505/23503/23502/22P02/22001 → errorCode)
PostgreSQL (Supabase)
TypeScript

---

# AI Optimization Agent

Purpose:
Maintain and evolve the scheduling generation and self-healing engine.

Skills:

scheduling-algorithms
- constraint solving
- heuristic optimization
- LLM-authoritative weekly-line proposal with verify-loop (E3-closed pattern); deterministic fallback only when LLM repeatedly fails verification.

fairness-analysis
- compute fairness score (0–1000, post-hoc, not a constraint)
- detect schedule imbalance
- 0.6 weight to balance, 0.4 to preference satisfaction (see invariants in CLAUDE-MEMORY)

auto-repair
- identify affected shifts
- find replacements based on skills and fairness
- automate shift swapping

Phase 14 — policy-aware scheduling (planned, not yet wired):
- inject `policyEnforcement.formatForPrompt(companyId)` into the LLM prompt before generation.
- run `policyEnforcement.evaluate(companyId, { shifts })` after each LLM proposal as a hard-gate (verify-loop reuse).
- soft violations attached to the schedule for manager review; LLM-only policies stay in the prompt.
- See SCHEDULER-ENGINE.md "PHASE 14" section for concrete integration code.

Tools:

Node.js / TypeScript heuristics (deterministic fallback inside `WeekScheduleBuilder`)
Active LLM provider per `ACTIVE_AI_PROVIDER` (Qwen `qwen3.6-plus` default, Gemini 2.0 Flash, or LocalLLMService via LM Studio/Ollama) for authoritative weekly-line proposals and semantic rule resolving
PolicyInterpreterRegistry (open + interpreter accelerators) — see Policy & Rules Agent

---

# Policy & Rules Agent

Purpose:
Maintain the dual subsystem that turns natural-language manager input ("we need at least 11h rest between shifts") into either deterministic interpreters used by the solver or LLM-only policies that ride along in the prompt. Owns the cross-cutting suggestion-loop pattern shared by web + WhatsApp.

Subsystems:

CompanyPolicy (open + interpreter accelerators)
- Aggregate: `CompanyPolicy` with `text`, `severity` (hard/soft), optional `interpreterId` + `params`, soft-delete via `isActive`.
- Open by design: any tenant can write any text; interpreters are accelerators, NOT the source of truth.
- Multi-tenant friendly: NO closed enum — would not scale. New domains (medical/security) plug in via new interpreters without DB schema changes.
- Persistence: `company_policies` table with RLS by `company_id`.
- Interpreters live under `domain/services/policy-interpreters/`. Two ship today: `min_rest_days_per_week`, `min_rest_hours_between_shifts`.
- `PolicyInterpreterRegistry.findMatch(text)` does keyword matching; `interpreter.extractParams(text)` does LLM extraction with JSON-schema validation.
- `PolicyEnforcementService.evaluate(companyId, { shifts })` returns `{ hardViolations, softViolations, llmOnlyPolicies }`. `formatForPrompt()` renders sections (`== Hard Policies ==` / `== Soft Policies ==` / `== Policies expressed in natural language ==`). Both have `*Loaded()` variants that skip the DB.
- Test reference: `test/unit/domain/services/policy-enforcement.service.spec.ts`.

RuleEngine (semantic rules per employee/team/role)
- Stays the existing system: `Rule.aggregate` + `RuleEngineService` + pgvector-based semantic resolve.
- Dedup on creation: cosine similarity threshold 0.12 (see invariants memory).
- Suggestion-loop reuse: when the LLM-extracted structure is too complex for the current rule schema, propose verified reformulations (same shape as policy suggestions).

Suggestion-loop pattern (cross-cutting)
- Shared by both subsystems: `IRuleRephraseService.suggest({ originalText, reason, interpreters })` returns 0..N `RephraseSuggestion`s.
- Three creation outcomes (discriminated union):
  - `created` + `mode: 'matched'`     — interpreter picked the text up; params extracted.
  - `created` + `mode: 'llm_only'`    — no interpreter, no useful suggestions; persist as LLM-only.
  - `needs_clarification`             — no interpreter; LLM proposed verified reformulations; do NOT persist; caller decides next step.
- `CompanyPolicyCreator` is the single domain service implementing this; both `CompanyPoliciesController` (HTTP) and the WhatsApp `MessageRouter` reuse it (see EVENT-FLOWS FLOW 6/7/8).
- WhatsApp variant persists the open question in `whatsapp_pending_clarifications` so the next inbound message from that employee resolves the loop deterministically.

Skills:

policy-interpreter-authoring
- write a new interpreter (id, description, keyword regex, JSON schema for params).
- register it in the DI module; `PolicyInterpreterRegistry` picks it up.
- add a unit test under `test/unit/domain/services/policy-interpreters/`.

suggestion-loop-design
- author rephrase prompts that return ≤3 high-quality suggestions; reject low-quality ones to avoid noise.
- ensure `whatsapp_pending_clarifications` rows expire/clean up so stale loops don't capture future messages.

permission-configuration
- `companies.whatsapp_policy_creator_roles TEXT[]` (default `['manager']`) gates who can create policies via WhatsApp. Configurable per-tenant; no hardcoded role lists.

Boundaries:

ALWAYS
- treat `CompanyPolicy.text` as the source of truth; interpreters can be added/removed without losing policies.
- preserve open subsystem semantics — never narrow to a closed enum.

ASK BEFORE
- adding a new interpreter category that overlaps with rules-engine semantics (avoid duplicate conceptual paths).

NEVER
- delete policies on interpreter removal; fall back to LLM-only.
- bypass the suggestion-loop by silently persisting "best effort" interpretation when params extraction is uncertain.

Tools:

NestJS Domain Services (`CompanyPolicyCreator`, `PolicyInterpreterRegistry`, `PolicyEnforcementService`)
Active LLM provider per `ACTIVE_AI_PROVIDER` for param extraction + rephrase suggestions
Supabase `company_policies` + `whatsapp_pending_clarifications` tables (RLS by company)

---

# WhatsApp Agent

Purpose:
Maintain conversational interfaces.

Skills:

whatsapp-bot-development
voice-processing
intent-detection
conversation-design
suggestion-loop-state-machine
- track per-employee open clarification rows in `whatsapp_pending_clarifications`.
- on every inbound message, FIRST resolve any pending clarification (e.g. user picks suggestion 1/2/3 or rewrites the rule), THEN re-route to intent detection.
- expire stale rows so they don't hijack future conversations.

permission-gating
- check `companies.whatsapp_policy_creator_roles` against the sender's role before allowing `create_policy` / `create_rule` intents.
- default `['manager']`, configurable per tenant.

Tools:

Twilio API
Active LLM provider per `ACTIVE_AI_PROVIDER` (Qwen/Gemini multimodal; Whisper + LLM pipeline for non-multimodal runtimes like LocalLLMService)
`CompanyPolicyCreator` (reused from Policy & Rules Agent — same suggestion-loop, no duplication)

Responsibilities:

- direct Twilio webhooks to the message router.
- extract intent from natural language or audio.
- map intents to CQRS commands.
- handle conversational `create_policy` / `create_rule` flows (see EVENT-FLOWS FLOW 7 + FLOW 8): produce policy text → resolve via `CompanyPolicyCreator` → if `needs_clarification`, persist the open loop and reply with suggestions; otherwise confirm creation.
- handle absence/incident conversational paths.

---

# Data Agent

Purpose:
Maintain system data integrity.

Skills:

postgresql-design
vector-database-management
query-optimization
data-migrations
redis-streams-management
soft-delete-patterns
- partial UNIQUE indexes (`WHERE deleted_at IS NULL`) so re-creating after a soft delete doesn't raise 23505. Canonical example: `employees(phone) WHERE deleted_at IS NULL`.
- when a hard error surfaces a 23505 the user does not understand, suspect a stale soft-deleted row and re-check the index strategy.

Responsibilities:

- maintain relational schema via SQL migrations.
- maintain vector embeddings for semantic rules (1536-dim, cosine; `<=>` for similarity; threshold 0.12 for dedup).
- manage Redis Streams for async processing (NO BullMQ).

Tables added during the 2026-04 sprint:

- `company_policies` — open + interpreter accelerators (RLS by company_id, soft-delete via `is_active`).
- `whatsapp_pending_clarifications` — state machine for the suggestion-loop on WhatsApp (per employee; expires).
- `companies.whatsapp_policy_creator_roles TEXT[]` — per-tenant permission override (default `['manager']`).

Tools:

PostgreSQL (Supabase)
pgvector
Redis

---

# Test Agent

Purpose:
Ensure system stability.

Skills:

unit-testing
integration-testing

Frameworks:

Jest
Supertest

Test Coverage Goals:

- Scheduling engine 90%
- API endpoints 85%
- AI workflows 80%

---

# Incident Agent (Scenario 5)

Purpose:
Manage medical and operational incidents, perform OCR validation, and trigger self-healing workflows.

Skills:

computer-vision-processing
ocr-validation
automated-recovery
fraud-detection

Tools:

Google Vision API
Active LLM provider per `ACTIVE_AI_PROVIDER` for JSON extraction from raw OCR

Responsibilities:

- process medical certificates via Computer Vision.
- validate authenticity and extract structured data.
- publish Domain Events (e.g., IncidentValidatedEvent).
- trigger Auto-Repair Engine.

---

# Frontend Agent (Scenario 6)

Purpose:
Build the visual operating layer for managers. Vite + React 19 SPA (NOT Next.js — corrected during the sprint). Tailwind 4, TanStack Query (server state), TanStack Table (DataTable rollout), i18next (EN/ES), Recharts.

Skills:

react-component-creation
- build presentational components and reusable widgets.
- the canonical reusable list/grid is `<DataTable>` (TanStack Table) — used in Skills, Memberships, Rules, Templates, Fairness, Absences, Incidents, Swaps, DayOffs, Employees. Excepción: la grilla de horarios.

data-table-rollout
- standard features per list: search, sortable headers, filter by role/status, pagination with page-size selector (5/10/15/20, default 10).
- new lists go straight to `<DataTable>`; do NOT add bespoke list components.

i18n + error mapping
- `LanguageSwitcher` toggles EN/ES via i18next.
- `describeApiError` resolves backend `errorCode` (from `PostgresExceptionFilter`) into a localized user-facing message; never display raw 500 / Postgres text.

state-management
- TanStack Query for server state (lists, mutations, invalidation).
- local component state for interactive details; Zustand reserved for cross-route interactive state if needed.

heatmap-visualization
- render coverage and demand analytics.

websocket-integration
- synchronize backend CQRS events to UI in real-time (planned).

Tools:

Vite + React 19
TailwindCSS 4 / Shadcn UI
TanStack Query, TanStack Table
i18next (EN/ES)
Recharts

Responsibilities:

- build the central Dashboard and Schedule Views.
- implement the Coverage and Demand Heatmaps.
- allow manual visual editing of shifts.
- ship CRUD pages for: workforce (employees, skills, memberships), policies (`CompanyPoliciesPage` with severity + suggestion-loop UX), rules, templates, fairness, absences, incidents, swaps, day-offs.
- maintain fast rendering (virtualization) for large data grids.

UI/UX preflight (ALWAYS before declaring a UI task done):

- Run `/preflight-ui` checklist (see `.claude/commands/preflight-ui.md`).
- Required states per screen: loading, empty, error.
- Tokens, layout, touch targets, accessibility per `docs/design-system.md`.
- If a design-system rule falls short for a real case, update the doc in the same PR — no silent improvisation.

---

# AGENT COMMUNICATION

Agents communicate through:

Event Bus (CQRS / NestJS)
Domain Events
Redis Streams (for cross-module async jobs)

Example:

ScheduleGenerated
AbsenceReportedEvent
MedicalLeaveSubmitted
IncidentValidatedEvent
ShiftReminderSent

---

# PRINCIPLES

Agents must follow these rules:

1. Prefer event-driven architecture and CQRS.
2. Preserve modular DDD design.
3. Never bypass validation layers.
4. Always produce tests for new logic (focus on Unit testing Aggregates, Handlers, and Value Objects).
5. Document architectural changes.
6. NO BullMQ; use Redis Streams and Job Tables for async workflows.
