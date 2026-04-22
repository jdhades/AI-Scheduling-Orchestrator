# SYSTEM-MAP.md

Project:
AI Workforce Scheduling SaaS

Version:
1.1 (Phase 3.5 — 2026-04-20)

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

Core capabilities:

AI Schedule Generation (Hybrid Logic)  
Semantic Rule Engine (RAG)  
Skill-based Shift Assignment  
Voice Interaction via WhatsApp (Multimodal Audio)  
Automated Incident Processing (Auto-Repair)  
Real-time Visual Analytics (Heatmaps & Live Dashboards)

---

# CORE SYSTEM COMPONENTS

The system is composed of the following major subsystems.

1 Scheduling Engine
2 Semantic Rule Engine
3 Workforce Management System
4 Messaging & Voice Interface (Twilio/Gemini)
5 Incident Processing System (Google Vision/Redis Streams)
6 Data Platform (Supabase pgvector)
7 API Integration Layer (NestJS CQRS)

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

# DATABASE SYSTEM

Primary Database: Supabase PostgreSQL

Stores:
employees
company_skills
shift_templates (logical definitions)
shift_memberships (Phase 13 — employee ↔ template with effective dates)
shift_assignments (single persisted scheduling output; `actualStartTime`/`actualEndTime` required)
shifts (legacy — deprecated in Phase 13)
semantic_rules (with `structure` JSONB)
shift_swap_requests
absence_reports
day_off_requests
incidents
incident_events

Vector Database: pgvector

Stores:
semantic_rules (rule_embedding array)  

---

# SECURITY MODEL

Authentication
Header-based `X-Company-Id` tenant header.
🔴 JWT/Bearer auth is HIGH security debt — not yet implemented.

Authorization Roles
Admin
Manager
Employee

Multi-tenancy
Row Level Security (RLS) policies by `company_id`. `TenantMiddleware` sets the Postgres session variable read by `current_tenant_id()`.

Phone linking
UUID handshake verification (HandshakeToken)

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
