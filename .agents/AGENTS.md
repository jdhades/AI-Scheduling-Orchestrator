# AGENTS.md
Project: AI Workforce Scheduling SaaS
Version: 1.0
Last Updated: 2026

Purpose:
Define the AI agents, their responsibilities, and the skills they use to build, maintain, and operate the scheduling platform.

This document follows the SKILL.md / skills.sh philosophy where agents use modular procedural capabilities.

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
WhatsApp Agent | Maintain messaging and conversational flows | Messaging features
Data Agent | Maintain database schema, pgvector, and migrations | Data changes
Test Agent | Create automated tests (Unit, E2E) | Every PR
Incident Agent | Handle computer vision, OCR, and automated recovery workflows | Incident reported (Scenario 5)
Frontend Agent | Implement React UI, Heatmaps, and real-time state | UI tasks (Scenario 6)

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

cqrs-pattern
- implement commands, queries, and event handlers.
- separate write/read models.

database-design
- maintain relational schema in Supabase (PostgreSQL).
- ensure indexes and RLS (Tenant Isolation).

api-first-design
- maintain public APIs.
- generate webhook handlers.

Tools:

NestJS
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

fairness-analysis
- compute fairness score
- detect schedule imbalance

auto-repair
- identify affected shifts
- find replacements based on skills and fairness
- automate shift swapping

Tools:

Node.js / TypeScript heuristics (deterministic fallback inside `WeekScheduleBuilder`)
Active LLM provider per `ACTIVE_AI_PROVIDER` (Qwen `qwen3.6-plus` default, Gemini 2.0 Flash, or LocalLLMService via LM Studio/Ollama) for authoritative weekly-line proposals and semantic rule resolving

---

# WhatsApp Agent

Purpose:
Maintain conversational interfaces.

Skills:

whatsapp-bot-development
voice-processing
intent-detection
conversation-design

Tools:

Twilio API
Active LLM provider per `ACTIVE_AI_PROVIDER` (Qwen/Gemini multimodal; Whisper + LLM pipeline for non-multimodal runtimes like LocalLLMService)

Responsibilities:

- direct Twilio webhooks to the message router.
- extract intent from natural language or audio.
- map intents to CQRS commands.

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

Responsibilities:

- maintain relational schema via SQL migrations.
- maintain vector embeddings for semantic rules.
- manage Redis Streams for async processing (NO BullMQ).

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
Build the visual operating layer for managers using React, Next.js, and visual analytics tools.

Skills:

react-component-creation
- build Shadcn UI components
- layout interactive schedule grids

heatmap-visualization
- render coverage and demand analytics

state-management
- integrate React Query for server state
- configure Zustand for local interactive state

websocket-integration
- synchronize backend CQRS events to UI in real-time

Tools:

React / Next.js
TailwindCSS / Shadcn UI
Recharts
React Query / Zustand

Responsibilities:

- build the central Dashboard and Schedule Views.
- implement the Coverage and Demand Heatmaps.
- allow manual visual editing of shifts.
- maintain fast rendering (virtualization) for large data grids.

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
