# SKILLS-CATALOG.md

Project: AI Workforce Scheduling SaaS
Version: 1.2
Last Updated: 2026-04-28

Purpose:
Define reusable procedural skills available to system agents.

Inspired by:
https://skills.sh/

Skills are modular capabilities that agents can invoke when performing tasks.

Each skill includes:
- purpose
- inputs
- outputs
- execution steps
- best practices

Cross-references: AGENTS.md, ARCHITECTURE.md, COMPANY-POLICIES.md, RULES-ENGINE.md, SCHEDULER-ENGINE.md, SECURITY-ARCHITECTURE.md.

---

# CORE ENGINEERING SKILLS

---

## Skill: nestjs-module-creation

### Purpose
Create a new feature module in NestJS following Domain-Driven Design and Clean Architecture.

### Inputs
- module_name
- domain aggregates and entities
- commands
- queries

### Outputs
- Folder structure with DDD constraints (domain, application, infrastructure, interfaces)
- Controllers/Webhooks
- Application Services (Handlers)
- DTOs / Value Objects
- Unit tests (.spec.ts)

### Execution Steps
1. Create module directory using `src/modules/[module_name]`.
2. Define Domain layer (Aggregates, Value Objects, Domain Events).
3. Implement Application layer (Command and Query handlers).
4. Create Infrastructure interfaces and ports.
5. Define interfaces layer (REST Controllers / Webhooks).
6. Register the new module in the root `AppModule`.

### Best Practices
- Keep controllers thin. They should only validate HTTP logic and delegate to Commands or Queries.
- Business logic MUST live strictly inside the Domain Layer (Aggregates, Domain Services, Value Objects).
- Dependencies point inward (Interfaces -> Application -> Domain).

---

## Skill: cqrs-command-handler

### Purpose
Implement command handlers for write operations in the system.

### Inputs
- command
- domain_aggregate

### Steps
1. Define the Command object (`[Action]Command`).
2. Create Command Handler (`[Action]Handler`).
3. Inject Repositories via dependency injection tokens.
4. Retrieve or instantiate Domain Aggregate.
5. Call Domain Aggregate methods to enforce business rules.
6. Commit changes to Repository.
7. Dispatch Domain Events via EventBus.

### Outputs
- Command handler class implementation implementing `ICommandHandler`.

### Best Practices
- Commands MUST NOT return domain data, only success signals or IDs if strictly necessary.
- A Command should modify exactly one Aggregate Root per transaction.

---

## Skill: cqrs-query-handler

### Purpose
Handle read operations separately from writes (CQRS segregation).

### Inputs
- query_name
- filters/parameters

### Steps
1. Define the Query object (`[Action]Query`).
2. Implement Query Handler (`[Action]Handler`).
3. Query the Database directly, bypassing rich domain models (read models).
4. Return an optimized, shallow response (DTO or raw data).

### Best Practices
- Queries must be fast.
- Never contain business logic or state changes within a query.

---

## Skill: dto-validation-rollout

### Purpose
Add or audit `class-validator` DTOs on every controller so silent 400s are eliminated and ValidationPipe (`whitelist: true, forbidNonWhitelisted: true, transform: true`) can do its job.

### Inputs
- controller_name and the existing endpoint signatures
- existing DB seed values (UUID-shape but not strict RFC 4122)

### Steps
1. Inventory every `@Body`, `@Query`, `@Param` argument.
2. Replace plain typed args with DTO classes annotated with `@IsString`, `@IsNotEmpty`, `@IsIn`, `@IsBoolean`, `@IsObject`, `@IsOptional`, `@MinLength`, `@ValidateIf`.
3. PREFER `@IsString @IsNotEmpty` over `@IsUUID`; the existing seed UUIDs are not strict RFC 4122 and `@IsUUID` will reject them.
4. For nullable fields use `@IsOptional + @ValidateIf((_o, v) => v !== null) + @IsString @IsNotEmpty` (see ShiftSwapRequest `assignmentId`).
5. Add unit/spec coverage for each new DTO failure mode.

### Best Practices
- `whitelist + forbidNonWhitelisted` — never accept unknown keys; surface payload mismatches loudly.
- Reuse a single `ValidationPipe` declared globally in `main.ts`; don't decorate at the controller level.
- During the 2026-04 sprint this rolled out across `absence-reports`, `day-off-requests`, `incidents`, `shift-templates`, `shift-swap-requests`, `company-policies`.

---

## Skill: postgres-error-mapping

### Purpose
Translate Postgres driver errors into stable, frontend-localizable `errorCode` strings so the UI never shows raw 500s or driver text.

### Inputs
- caught QueryFailedError (or pg-equivalent)

### Steps
1. Implement a global `PostgresExceptionFilter` (NestJS `APP_FILTER`).
2. Map error code → response shape:
   - `23505` (unique_violation)        → `errorCode: 'unique_violation'` (HTTP 409)
   - `23503` (foreign_key_violation)   → `errorCode: 'foreign_key_violation'` (HTTP 409)
   - `23502` (not_null_violation)      → `errorCode: 'not_null_violation'` (HTTP 400)
   - `22P02` (invalid_text_representation) → `errorCode: 'invalid_input'` (HTTP 400)
   - `22001` (string_data_right_truncation) → `errorCode: 'value_too_long'` (HTTP 400)
3. Include `field` / `constraint` hints when extractable from the driver message.
4. Frontend resolves the `errorCode` via `describeApiError(...)` (i18n EN/ES).

### Best Practices
- Never let raw Postgres text reach the user.
- Pair this with partial UNIQUE indexes (`WHERE deleted_at IS NULL`) so re-creation after soft delete doesn't surface as `23505`.
- See SECURITY-ARCHITECTURE.md "Error mapping" for the canonical list.

---

# AI ENGINE SKILLS

---

## Skill: constraint-modeling

### Purpose
Model scheduling constraints mathematically for the Auto-Repair and Scheduling engines.

### Inputs
- employees
- shifts
- semantic rules (loaded from pgvector)

### Outputs
- Constraint model configurations

### Steps
1. Define decision variables.
2. Define hard/soft constraints (overlapping shifts, required skills).
3. Define objective functions (minimize costs, maximize fairness).
4. Run heuristic solver or constraint algorithm.

### Tools
- TypeScript Heuristics / Constraint solvers.

---

## Skill: fairness-calculation

### Purpose
Compute fairness distribution across employees.

### Inputs
- schedule_history

### Outputs
- fairness_score (Value Object)

### Metrics
- night_shift_distribution
- weekend_shift_balance
- total_hours_balance
- holiday_assignments

---

## Skill: demand-forecasting

### Purpose
Predict workforce demand.

### Inputs
- historical_workload

### Outputs
- predicted_staffing

### Methods
- Time series.
- Regression models.

---

## Skill: policy-interpreter-authoring

### Purpose
Add a new deterministic accelerator to `PolicyInterpreterRegistry` so the solver can enforce the policy without the LLM, while keeping the open subsystem semantics (text remains source of truth).

### Inputs
- policy text patterns (e.g. "min N hours rest", "no más de N horas consecutivas")
- params JSON schema (typed, with bounds)
- evaluator function `(shifts, params) => Violation[]`

### Steps
1. Implement the interpreter under `src/domain/services/policy-interpreters/<id>.interpreter.ts` exposing `id`, `description`, `matches(text)`, `extractParams(text)`, `evaluate(shifts, params)`.
2. Use the LLM (active provider) inside `extractParams` with a JSON-schema-validated response.
3. Register in the DI module (provider list); `PolicyInterpreterRegistry` auto-discovers via constructor injection.
4. Add unit tests under `test/unit/domain/services/policy-interpreters/<id>.interpreter.spec.ts` covering: matches/no-matches, param extraction edge cases, evaluation with violations and without.
5. If the new interpreter overlaps with existing rule-engine behavior, escalate to Architecture Agent (avoid duplicate paths).

### Best Practices
- Interpreters are accelerators, not gatekeepers. Removing one MUST NOT delete policies — the runtime falls back to LLM-only.
- Don't introduce closed enums of policy categories — the system is open by design (multi-tenant, multi-domain).
- Keep keyword matching tight; loose regex causes false positives that mis-attach params.

---

## Skill: suggestion-loop-orchestration

### Purpose
Drive the cross-cutting flow that turns "I tried to create a policy/rule and the system can't structure it" into "here are 1..3 reformulations you can pick or adapt".

### Inputs
- raw text from manager (web body or WhatsApp message)
- registry of available interpreters (with `id` + `description`)

### Steps
1. Try `registry.findMatch(text)` first.
2. If no match, call `IRuleRephraseService.suggest({ originalText, reason: 'no_interpreter_matched', interpreters })` — the LLM returns ≤3 verified suggestions or an empty array.
3. If suggestions array is non-empty → return `needs_clarification` (do NOT persist).
4. If empty → persist as LLM-only (`mode: 'llm_only'`), so the manager isn't blocked.
5. WhatsApp variant: also persist a `whatsapp_pending_clarifications` row keyed by employee phone so the next inbound message resolves the loop.

### Best Practices
- Use the same `CompanyPolicyCreator` from both HTTP and WhatsApp paths — duplication = drift.
- Set TTL/cleanup on `whatsapp_pending_clarifications` so abandoned loops don't capture future messages.
- Return `RephraseSuggestion[]` not raw text; the structured shape lets the frontend render selectable cards.

---

# SCENARIO 5 (AUTO-REPAIR) SKILLS

---

## Skill: computer-vision-processing

### Purpose
Extract raw text and visual validation from images/PDFs.

### Inputs
- image_url or pdf_url
- MIME type

### Steps
1. Download media stream from source URL (e.g. WhatsApp / Twilio).
2. Execute Google Vision API for OCR processing.
3. Handle failure modes (blurry image, invalid format).
4. Return raw extracted text and overall confidence score.

### Tools
- Google Vision API

---

## Skill: structure-extraction-llm

### Purpose
Transform raw OCR unstructured text into a validated domain object.

### Inputs
- raw_ocr_text
- extraction_schema_prompt

### Steps
1. Send raw text and strict system prompt to the active LLM provider (`ILLMService`) — Qwen/Gemini/Local chosen via `ACTIVE_AI_PROVIDER`.
2. Demand exclusively JSON format output.
3. Extract critical entities (`patient_name`, `issue_date`, `rest_days`, `doctor_name`).
4. Validate JSON integrity.

### Tools
- Active LLM provider via `ILLMService` (Qwen default; Gemini / Local alternatives)

---

# DATA SKILLS

---

## Skill: postgres-schema-design

### Purpose
Create scalable relational schemas for Supabase PostgreSQL.

### Steps
1. Define entities.
2. Normalize tables.
3. Define foreign key constraints and cascades.
4. Establish indices (B-tree on IDs/timestamps, GIN for text).
5. Enforce Row Level Security (RLS) for tenant isolation (`company_id`).
6. For uniqueness on soft-deletable columns, use a partial UNIQUE index `WHERE deleted_at IS NULL` so re-creation after soft-delete doesn't raise `23505`. Canonical example:
   `CREATE UNIQUE INDEX employees_phone_active_uidx ON employees(phone) WHERE deleted_at IS NULL;`

### Best Practices
- Avoid large joins.
- Strict isolation using RLS is mandatory for SaaS architecture.
- When a 23505 surfaces in a flow that "should be allowed" (e.g. recreate employee with the same phone), suspect a stale soft-deleted row and fix the index, NOT the application code.

---

## Skill: vector-embedding-storage

### Purpose
Store semantic rules in vector database for retrieval-augmented generation (RAG).

### Steps
1. Generate embeddings using Google AI (`text-embedding-004`).
2. Store embeddings alongside metadata in pgvector.
3. Enable similarity search via RPC functions (`ivfflat` or `hnsw` indexes).

---

## Skill: redis-stream-management

### Purpose
Provide fault-tolerant async job processing WITHOUT using BullMQ.

### Steps
1. Define Redis Stream keys.
2. Construct robust publisher services (`XADD`).
3. Build independent Consumer modules connecting with Consumer Groups (`XREADGROUP`).
4. Handle ACK flows for successful tasks.

### Best Practices
- Never block the main Node.js event loop handling HTTP requests.
- Ensure messages aren't lost through `XACK` / outbox patterns.

---

# MESSAGING SKILLS

---

## Skill: whatsapp-command-processing

### Purpose
Process conversational commands received from end-users.

### Inputs
- voice (base64) or text payload
- user_phone_number

### Steps
1. Identify employee by phone lookup.
2. BEFORE intent detection: check for an open `whatsapp_pending_clarifications` row for that phone. If one exists, route to the suggestion-loop resolver (user may answer with "1", "2", "3", or a rewritten rule).
3. Forward exact Base64 payload + instructions to the active LLM provider (Qwen/Gemini multimodal; or Whisper + LLM pipeline for non-multimodal providers like LocalLLMService).
4. Detect intent and extract entities into a JSON representation.
5. Gate sensitive intents (`create_policy`, `create_rule`) by `companies.whatsapp_policy_creator_roles` (default `['manager']`).
6. Map JSON directly to CQRS Command (via CommandMapperService) — for policy/rule creation, delegate to `CompanyPolicyCreator` which returns one of `created+matched`, `created+llm_only`, or `needs_clarification`.
7. If `needs_clarification`, persist the open loop and reply with the suggestions; otherwise confirm.

---

# TESTING SKILLS

---

## Skill: scheduling-engine-testing

### Purpose
Test scheduling optimization and event-driven logic.

### Tests
- Constraint satisfaction (no overlapping shifts).
- Fairness balance limits.
- Edge cases and isolated state transitions.

### Tools
- Jest.
- Property testing.
- Fake timers for temporal edge cases.

### Best Practices
- Always mock the Repositories, NEVER the Aggregate logic.
- Mock Date/Time dependent handlers precisely.

---

# SCENARIO 6 (FRONTEND & VISUALIZATION) SKILLS

---

## Skill: react-component-creation

### Purpose
Build robust, reusable UI components in the Vite + React 19 SPA (NOT Next.js).

### Inputs
- component_name
- feature_requirements
- mock_data

### Steps
1. Define strict TypeScript interfaces for props.
2. Structure component splitting logic from presentation.
3. Apply Tailwind 4 classes and Shadcn UI primitives.
4. Ensure responsive design, touch targets, and accessibility per `docs/design-system.md`.
5. Always implement loading, empty, and error states (mandatory).
6. Run `/preflight-ui` before declaring the task done.

### Tools
- Vite + React 19
- TailwindCSS 4
- Shadcn UI

---

## Skill: data-table-rollout

### Purpose
Provide a single reusable `<DataTable>` (TanStack Table) so every list page in the app shares search, sortable headers, role/status filters, and pagination with page-size selector — without bespoke components per screen.

### Inputs
- columns definition (TanStack column defs)
- query result (array of rows)
- optional filter inputs (role, status, custom)

### Steps
1. Use `@tanstack/react-table` as the engine; expose a single `<DataTable>` component in the design-system folder.
2. Provide built-ins: search box (text), header sort toggle, role/status filter dropdowns, pagination footer with page-size selector (5/10/15/20, default 10).
3. New list screens MUST use `<DataTable>`. Excepción documentada: la grilla de horarios (no es lista).
4. Surface backend errors via `describeApiError` (i18n), not raw text.

### Coverage (2026-04 sprint rollout)
- Workforce: Employees, Skills, Memberships
- Scheduling: Templates, Fairness, Rules
- Operations: Absences, Incidents, Swaps, DayOffs

### Best Practices
- Reuse the same column-definition helpers across screens (sort comparators, formatters).
- Keep table state (pagination, sort, filter) inside the component; only expose query state through TanStack Query.

---

## Skill: i18n-and-error-mapping

### Purpose
Render a localized UI (EN/ES) and map backend `errorCode` strings to user-facing messages without coupling to driver text.

### Inputs
- i18next resource files for EN + ES
- `errorCode` returned by `PostgresExceptionFilter` (or thrown by NestJS)

### Steps
1. Configure i18next with EN + ES bundles; provide `<LanguageSwitcher>` in the global header.
2. Implement `describeApiError(error, t)` that:
   - reads `error.response?.data?.errorCode` if present;
   - falls back to known HTTP status mappings;
   - returns a localized string from i18n resources;
   - never displays raw 500 / Postgres text.
3. Use `describeApiError` in every mutation `onError` and every error state in lists/forms.

### Best Practices
- Treat `errorCode` as a stable contract with the backend; coordinate additions in the same PR that adds backend mapping.
- Keep i18n keys flat and topic-scoped (`errors.unique_violation`, `errors.foreign_key_violation`, …).

---

## Skill: heatmap-visualization

### Purpose
Calculate and render data-dense heatmaps for Coverage and Demand.

### Inputs
- time_series_data (e.g., hours vs days)
- threshold_rules (e.g., required staff vs assigned)

### Steps
1. Normalize array data into a 2D matrix suitable for grid rendering.
2. Calculate score ratios (assigned / required).
3. Map ratios to gradient color scales (Green -> Yellow -> Red).
4. Implement interactive tooltips (Hover stats).

### Tools
- Recharts
- D3.js or React Grid primitives

---

## Skill: state-management-sync

### Purpose
Manage and synchronize asynchronous data with the backend API and WebSockets.

### Steps
1. Use TanStack Query to fetch raw schedule/incident data and cache it.
2. Invalidate queries optimistically upon mutations (e.g., Swapping shifts).
3. Subscribe to WebSockets `ScheduleGenerated` or `IncidentCreated` events (planned).
4. Bridge real-time updates directly into the active TanStack Query cache.
5. Store volatile view constraints (like active filters) in component state; reach for Zustand only when state genuinely crosses routes.

### Tools
- TanStack Query
- Zustand (selectively)
- WebSockets (planned)

---

# SECURITY & OPERATIONS SKILLS

---

## Skill: secrets-hygiene

### Purpose
Keep `.env*` files out of git history and ensure `.env.example` is the only template tracked.

### Steps
1. `.gitignore` MUST contain a broad `.env*` pattern with `!.env.example` exception.
2. Audit history with `git log --all --full-history -- .env .env.* '**/.env' '**/.env.*'` and `git ls-files | grep -E '^\.env'`.
3. If a real secret was ever committed, rotate the credential immediately — git history rewriting alone is insufficient (already pushed = already exposed).
4. Provide a self-documenting `.env.example` with EVERY required variable and NO values.

### Best Practices
- The 2026-04 sprint surfaced `.env.test` + `.env.test.twilio` previously tracked with real Twilio creds; remediation = rotate creds + ignore pattern + example file.
- Do NOT add ad-hoc `*.local` patterns; rely on the `.env*` umbrella + the example exception.

---

## Skill: cors-fail-closed-config

### Purpose
Configure CORS so production never silently allows arbitrary origins.

### Steps
1. In `main.ts`, branch on `NODE_ENV`:
   - dev: `origin: '*'` (developer convenience).
   - prod: read `ALLOWED_ORIGIN` (comma-separated list) and pass it to NestJS `enableCors`. If unset → fail closed (do NOT default to `*`).
2. Document the variable in `.env.example` and in SECURITY-ARCHITECTURE.md.
3. Add a smoke test that boots the app in `NODE_ENV=production` without `ALLOWED_ORIGIN` and asserts startup either fails or rejects all origins.

### Best Practices
- Fail closed > fail open. A mis-deployed production should not silently accept every origin.

---

## Skill: dev-auth-bypass-guardrails

### Purpose
Document the existing `DEV_AUTH_BYPASS` env flag (which lets the API trust `X-Company-Id` without JWT) and prevent accidental enablement in prod.

### Steps
1. Treat `DEV_AUTH_BYPASS=true` as deuda HIGH conocida (see SECURITY-ARCHITECTURE.md "Deuda abierta").
2. The flag MUST default to false; production deployments MUST NOT set it.
3. Add a startup log warning if `NODE_ENV=production` AND the flag is true.
4. Track the JWT migration in the security debt list; do NOT mix the migration with feature work.

### Best Practices
- Keep this debt isolated and visible. The user explicitly requested NOT to touch `X-Company-Id` while doing other cleanup — the same applies to anyone else: don't fix it as a side-effect, plan it.
