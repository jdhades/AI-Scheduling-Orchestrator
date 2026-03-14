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

- Admin Web App / Manager Dashboard (React, Next.js, TailwindCSS)
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
ShiftAggregate
SemanticRuleAggregate
IncidentAggregate (Scenario 5)

Value Objects:

FairnessScore
ExperienceLevel
ConversationIntentVO
OCRConfidence
MedicalLeavePeriod

Domain Services:

ScheduleGenerator
FairnessCalculator
ConflictResolutionEngine
SemanticRetrievalService
AutoRepairEngine

---

Infrastructure Layer

External services.

Components:

PostgreSQL (Supabase)
Vector Database (pgvector)
Redis Streams (Async Jobs)
WebSockets Server (Real-time Frontend sync)
Twilio API (WhatsApp)
Gemini 1.5 Pro (Multimodal AI & Embeddings)
Google Vision API (OCR)

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
skills
shift_assignments
schedules
semantic_rules
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

Schedule Optimization Engine

- constraint solver + heuristic optimizer
- fairness optimizer

Conversational Engine

- processes audio/text directly via Gemini 1.5 Pro Multimodal
- maps intents directly to CQRS Commands without NLP intermediate pipelines

Auto-Repair Incident Engine (Scenario 5)

- OCR text extraction via Google Vision API
- structured data extraction via Gemini 1.5 Pro
- detects affected shifts and automatically finds replacements

---

# EXTERNAL SERVICES

WhatsApp Messaging: Twilio API
Voice Processing: Gemini 1.5 Pro (Native Multimodal Base64)
Document Analysis: Google Vision API & Gemini 1.5 Pro
Async Task Queueing: Redis Streams (BullMQ explicitly forbidden)

---

# SECURITY

Authentication:
JWT / Supabase Auth

Authorization:
Roles: Admin, Manager, Employee
Row Level Security (RLS): Tenant Isolation by `companyId`

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
