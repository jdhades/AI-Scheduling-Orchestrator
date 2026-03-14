# SKILLS-CATALOG.md

Project: AI Workforce Scheduling SaaS

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
1. Send raw text and strict system prompt to Gemini 1.5 Pro.
2. Demand exclusively JSON format output.
3. Extract critical entities (`patient_name`, `issue_date`, `rest_days`, `doctor_name`).
4. Validate JSON integrity.

### Tools
- Gemini 1.5 Pro

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

### Best Practices
- Avoid large joins.
- Strict isolation using RLS is mandatory for SaaS architecture.

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
2. Forward exact Base64 payload + instructions to Gemini 1.5 Pro Multimodal.
3. Detect intent and extract entities into a JSON representation.
4. Map JSON directly to CQRS Command (via CommandMapperService).
5. Trigger action in Domain without manual intervention.

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
Build robust, reusable UI components using TailwindCSS and Shadcn UI.

### Inputs
- component_name
- feature_requirements
- mock_data

### Steps
1. Define strict TypeScript interfaces for props.
2. Structure component splitting logic from presentation.
3. Apply Tailwind classes and Shadcn primitives.
4. Ensure responsive design and accessibility.

### Tools
- React / Next.js
- TailwindCSS
- Shadcn UI

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
1. Use React Query to fetch raw schedule/incident data and cache it.
2. Invalidate queries optimistically upon mutations (e.g., Swapping shifts).
3. Subscribe to WebSockets `ScheduleGenerated` or `IncidentCreated` events.
4. Bridge real-time updates directly into the active React Query cache.
5. Store volatile view constraints (like active filters) in Zustand.

### Tools
- React Query (TanStack Query)
- Zustand
- WebSockets
