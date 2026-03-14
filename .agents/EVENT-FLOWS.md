# EVENT-FLOWS.md

Purpose:
Define the event-driven workflows inside the scheduling system.

Events are emitted whenever domain actions occur. The system strictly utilizes CQRS EventBus and Redis Streams for inter-module async communication.

---

# CORE EVENTS

EmployeeRegistered
SemanticRuleCreated
ScheduleGenerationRequested
ScheduleGenerated
ShiftSwapRequested
AbsenceReportedEvent
MedicalLeaveSubmitted
IncidentReportedEvent
IncidentOCRCompletedEvent
IncidentValidatedEvent
ReplacementAssignedEvent
IncidentResolvedEvent

---

# FLOW 1: Generate Schedule

Trigger:
Manager requests schedule generation.

Steps:
1 Manager creates schedule request (GenerateHybridScheduleCommand)
2 Semantic rules retrieved via pgvector (RAG)
3 Constraint solver and heuristic optimizer run
4 Fairness metrics calculated
5 ScheduleGenerated event emitted
6 Notifications sent to employees

---

# FLOW 2: Voice/Text Command via WhatsApp

Trigger:
Employee sends voice note or text to Twilio number.

Steps:
1 Twilio webhook hits WhatsAppController (returns 200 OK immediately, fire-and-forget).
2 MessageRouterService routes the media/text.
3 Media (if audio) fetched, converted to Base64.
4 Gemini 1.5 Pro processes audio+prompt to extract JSON intent (ConversationIntentVO).
5 CommandMapperService translates intent to a CQRS Command (e.g. ReportAbsenceCommand).
6 Command Bus executes Handler.
7 Success or Clarification message sent back via Twilio.

---

# FLOW 3: Medical Incident Processing (Auto-Repair Scenario 5)

Trigger:
Employee sends an image or PDF of a medical certificate via WhatsApp.

Steps:
1 WhatsAppController receives webhook with media URL.
2 CreateIncidentCommand is dispatched.
3 Incident aggregate created (status: pending_ocr), IncidentReportedEvent emitted.
4 Redis Stream (incident_processing_stream) picks up the event.
5 Vision Consumer downloads image and executes Google Vision OCR.
6 Raw text parsed via Gemini LLM into structured data, IncidentOCRCompletedEvent emitted.
7 IncidentValidator validates start/end dates, name matches, and OCR confidence (> 0.65).
8 IncidentValidatedEvent emitted.
9 Auto-Repair Engine detects affected shifts.
10 Replacement search started (Internal, Swap, Overtime).
11 ReplacementAssignedEvent emitted.
12 Manager and Employees notified via Twilio.

---

# FLOW 4: Employee Shift Swap

Trigger:
Employee requests swap via conversational agent.

Steps:
1 SwapShiftCommand executed.
2 Domain validates: Skill compatibility, fairness score, start times.
3 ShiftSwapRequested event.
4 Target employee notified.
5 If accepted, Manager approval required (or auto-approved).
6 Schedule updated, persistence updated.

---

# FLOW 5: Real-Time UI Synchronization (Scenario 6)

Trigger:
Any major Domain Event is emitted by the Backend (e.g., ScheduleGenerated, IncidentCreated, ShiftSwapApproved).

Steps:
1 EventBus publishes the Domain Event natively.
2 A dedicated WebSocket Gateway intercepts the event.
3 The Gateway broadcasts a lightweight DTO to subscribed Frontend clients.
4 React Query invalidates cached queries or updates cached state optimistically.
5 The UI (Heatmaps, Schedule Grid, Dashboard) re-renders live without manual refresh.

---

# EVENT BUS & ASYNC JOBS

All synchronous domain events published to NestJS CQRS `@nestjs/cqrs` EventBus.

For asynchronous, fault-tolerant processing (e.g., OCR, Image Downloading), the system uses **Redis Streams** and **Job Tables** (Outbox pattern). 
**BullMQ is explicitly restricted.**

Consumers:
Notification Service
Vision Processing Consumer
Auto-Repair Engine
Audit Log (incident_events table)
