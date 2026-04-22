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

EmployeeAggregate
ShiftTemplateAggregate
ShiftMembershipAggregate (Phase 13)
ShiftAssignmentAggregate (single persisted scheduling output)
SemanticRuleAggregate (carries `structure` JSON produced at ingestion)
IncidentAggregate (Scenario 5)
CompanyAggregate / CompanySkillAggregate
WhatsAppHandshakeAggregate

Value Objects:

FairnessHistoryVO
VirtualShiftSlot (materialized on-demand from ShiftTemplate × date)
WorkingTimePolicyVO
ConversationIntentVO
OCRConfidence
MedicalLeavePeriod

Domain Services:

WeekScheduleBuilder — employee-first, LLM-authoritative with verify-loop + deterministic fallback (Phase 3.5)
LLMLineProposerService — builds the English prompt, translates rule texts, parses JSON
ShiftSlotGeneratorService — materializes VirtualShiftSlot[] on-demand
StructuredRuleResolver / RuleStructureExtractor — splits rules into structured vs free-text buckets
FairnessCalculatorService
ConflictResolverService
SemanticRetrievalService
AutoRepairEngine / ConflictResolutionEngine (Scenario 5)

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

employees
company_skills
shift_templates (logical definition)
shift_memberships (Phase 13 — employee ↔ template with effective dates)
shift_assignments (single persisted scheduling output; has its own UUID PK + actualStartTime/actualEndTime)
shifts (legacy — deprecated in Phase 13, not written by new code paths)
semantic_rules (carries `structure` JSONB from ingestion-time LLM)
shift_swap_requests
absence_reports
day_off_requests
incidents (Scenario 5)
incident_events (Scenario 5 - Audit Table)

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

Schedule Generation (LLM-authoritative, Phase 3.5)

- LLMLineProposerService proposes one weekly line per employee (English prompt, chain-of-thought allowed, names instead of UUIDs)
- WeekScheduleBuilder.verify() audits for 6 hard-violation kinds
- Up to 2 LLM attempts (second with feedback on violations)
- Deterministic fallback if the LLM cannot converge
- LLMUsageTracker emits per-generation token totals

Conversational Engine

- processes audio/text directly via the active LLM provider (Qwen/Gemini/Local per ACTIVE_AI_PROVIDER)
- maps intents directly to CQRS Commands without NLP intermediate pipelines

Auto-Repair Incident Engine (Scenario 5)

- OCR text extraction via Google Vision API
- structured data extraction via the active LLM provider per `ACTIVE_AI_PROVIDER`
- detects affected shifts and automatically finds replacements

---

# EXTERNAL SERVICES

WhatsApp Messaging: Twilio API
Voice Processing: active LLM provider (Qwen Conversational default; Gemini available; Whisper pipeline for non-multimodal runtimes)
Document Analysis: Google Vision API + active LLM provider for structured extraction (Scenario 5)
Async Task Queueing: Redis Streams (BullMQ explicitly forbidden)

---

# SECURITY

Authentication:
Header-based `X-Company-Id` tenant header (JWT/Bearer auth is HIGH security debt — not yet implemented).

Authorization:
Roles: Admin, Manager, Employee
Row Level Security (RLS): Tenant Isolation by `companyId` via `TenantMiddleware` → `current_tenant_id()` Postgres session variable

Phone linking:
UUID handshake (HandshakeToken)

---

# SCALABILITY

Stateless API servers
Horizontal scaling
Separate event consumers for:
- AI scheduling
- OCR processing (Vision Consumer)
- Auto-Repair
