# SYSTEM-MAP.md

Project:
AI Workforce Scheduling SaaS

Version:
1.0

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

React / Next.js Admin Dashboard  
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
ShiftAggregate  
SemanticRuleAggregate  
IncidentAggregate

Domain Services:

ScheduleGenerator  
ConflictResolutionEngine  
FairnessCalculator  
AutoRepairEngine

---

## Infrastructure Layer

External integrations.

Components:

PostgreSQL database (Supabase)  
pgvector database  
Redis Streams (background jobs)  
WhatsApp API (Twilio) 
Gemini 1.5 Pro (JSON validation, Speech-to-Text)  
Google Vision API (OCR extraction)  

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
→ Rule Engine loads rules (pgvector)  
→ Scheduler Engine runs constraint solver  
→ Fairness optimization  
→ ScheduleGenerated Event  
→ Notifications sent via Twilio  

---

## Voice Command Flow

Employee sends voice note via WhatsApp.

Flow:
Voice Message (.ogg payload)  
→ MessageRouterService  
→ Gemini 1.5 Pro (Multimodal conversion to ConversationIntentVO)  
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
→ Gemini parsing validates data  
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
constraint optimization, heuristic programming, LLM validation

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
Gemini 1.5 Pro native Multimodal

---

## Computer Vision & Auto-Repair AI

Purpose:
Extract text from medical certificates and parse cleanly into structured JSON.

Technologies:
Google Vision API, Gemini 1.5 Pro Text Validation

---

# DATABASE SYSTEM

Primary Database: Supabase PostgreSQL

Stores:
employees  
shift_assignments  
schedules  
semantic_rules  
shift_swap_requests  
incidents  
incident_events  

Vector Database: pgvector

Stores:
semantic_rules (rule_embedding array)  

---

# SECURITY MODEL

Authentication
JWT tokens via Supabase Auth

Authorization Roles
Admin  
Manager  
Employee  

Multi-tenancy
Row Level Security (RLS) policies by `companyId`

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
