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

CompanyPolicyCreated (sprint 2026-04-27 — emitido cuando el manager crea una policy via web o WhatsApp)
CompanyPolicyDeactivated (sprint 2026-04-27)
WhatsappClarificationPending (sprint 2026-04-27 — opcional, para tracking de loops)

---

# FLOW 1: Generate Schedule (LLM-authoritative, Phase 3.5)

Trigger:
Manager requests schedule generation.

Steps:
1  Manager creates schedule request (GenerateHybridScheduleCommand)
2  Handler loads employees, templates, memberships, fairness histories
3  ShiftSlotGeneratorService materializes VirtualShiftSlot[] (in-memory) for the week
4  SemanticRetrievalService retrieves relevant rules via pgvector (RAG, top-K, cosine < 0.35)
5  StructuredRuleResolver splits rules into { constraints, unstructuredRules, complexRules, multiShiftPermits }
6  Handler opens LLMUsageTracker scope and calls WeekScheduleBuilder.buildWithRetries()
   6a LLMLineProposerService.translateRulesToEnglish() — cached LLM call
   6b LLMLineProposerService.proposeLines() — LLM emits one weekly line per employee (name-based JSON)
   6c WeekScheduleBuilder.verify() — checks 6 hard violation kinds
   6d On violations → formatFeedback → retry (max 2 LLM attempts total)
   6e If still invalid → deterministic fallback (build())
7  ShiftAssignment[] persisted (single source of truth)
8  FairnessHistoryVO updated per employee
9  LLMUsageTracker emits `📊 Hybrid schedule LLM usage — calls=N prompt=P completion=C total=T`
10 ScheduleGenerated event emitted
11 WebSocket broadcast + WhatsApp notifications sent

---

# FLOW 2: Voice/Text Command via WhatsApp

Trigger:
Employee sends voice note or text to Twilio number.

Steps:
1 Twilio webhook hits WhatsAppController (returns 200 OK immediately, fire-and-forget).
2 MessageRouterService routes the media/text.
3 Media (if audio) fetched, converted to Base64.
4 Active LLM provider (default: Qwen `qwen3.6-plus`; fallback Gemini 2.0 Flash or LocalLLMService per `ACTIVE_AI_PROVIDER`) processes audio+prompt to extract JSON intent (ConversationIntentVO).
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

# FLOW 6: Create Company Policy via Web (sprint 2026-04-27)

Trigger:
Manager creates a tenant-wide policy from `/policies` page.

Steps:
1 POST `/company-policies` with `{ text, severity, effectiveFrom?, createdBy? }`.
2 Controller delegates to `CompanyPolicyCreator.create()`.
3 `PolicyInterpreterRegistry.findMatch(text)`.
4a If interpreter found → `interpreter.extractParams(text)` + persist policy with `interpreterId` populated. Reply `{ status: 'created', mode: 'matched', policy }`.
4b If no interpreter → `LlmRuleRephraseService.suggest(...)` con catalog de interpreters disponibles como hint.
   • Service rendera prompt + obtiene 2-3 reformulaciones del LLM.
   • Service VERIFICA cada sugerencia: `registry.findMatch(suggestion.text)` — descarta hallucinations.
   • Si quedan suggestions verificadas → reply `{ status: 'needs_clarification', suggestions }` (NO persiste).
   • Si LLM falla / cero suggestions → persist as LLM-only, reply `{ status: 'created', mode: 'llm_only', policy }`.
5 Frontend (`CompanyPolicyFormDialog`):
   • `created/matched` → cierra dialog silencioso, lista refresca.
   • `needs_clarification` → renderea picker. Click → re-submit con texto elegido (loop).
   • `created/llm_only` → muestra warning "policy guardada pero el solver no la aplica directo".

---

# FLOW 7: Create Policy via WhatsApp (sprint 2026-04-27)

Trigger:
Manager dicta una policy por mensaje de WhatsApp.

Steps:
1 Twilio webhook → `WhatsAppController` → `MessageRouterService.route()`.
2 LLM clasifica intent. Si reconoce `create_policy`:
   2.1 Permission check: `WhatsappPolicyPermissionService.canCreatePolicy({ employeeRole, companyId })` consulta `companies.whatsapp_policy_creator_roles[]`.
   2.2 Si denegado → reply "no tenés permisos" + clearSession. END.
3 Extracción de texto: `ruleText` entity del LLM (o rawText si no la extrajo).
4 `CompanyPolicyCreator.create({ text, severity: 'hard', createdBy: employeeId })`.
5a `created/matched` → reply ✓ y limpia sesión. END.
5b `created/llm_only` → reply con warning honesto (LLM-only, no determinístico). END.
5c `needs_clarification`:
   5.c.1 Persistir `WhatsappPendingClarification` (target_kind='policy', suggestions JSONB, expires_at NOW+10min).
   5.c.2 `session.pendingAction = 'create_policy_clarification'`. Memoriza severity para reconstruir el comando.
   5.c.3 Bot manda lista numerada con sugerencias.
6 Manager responde:
   6a Número en rango (1/2/3/...): `findActiveByEmployee` → `pickByNumber(n)` → `markResolved` → re-execute `CompanyPolicyCreator.create()` con texto elegido. Si vuelve `needs_clarification`, persist nuevo pending y vuelta al loop.
   6b Número fuera de rango: reply "fuera de rango", session sigue.
   6c Texto libre (NaN al parsear): markResolved del pending + clearSession + dejar que el flow normal procese el nuevo texto como create fresh.
   6d Sin pending o expirado: reply "expiró".

---

# FLOW 8: Create Rule via WhatsApp con Suggestion-Loop al Complex (sprint 2026-04-27)

Trigger:
Manager dicta una regla particular (caso particular) por WhatsApp.

Steps:
1 Same as FLOW 2 (intent classification → `create_rule`).
2 `CommandMapperService` mapea a `CreateSemanticRuleCommand`.
3 `CommandBus.execute()` → `CreateSemanticRuleHandler`:
   3.1 Crea aggregate.
   3.2 Genera embedding via `IEmbeddingService`.
   3.3 Dedup check via pgvector (cosine < 0.12).
   3.4 `RuleStructureExtractor.extract()` → `structure JSON` con intent.
   3.5 Si `structure.intent === 'complex'`:
       • `LlmSemanticRuleRephraseService.suggest({ originalText, complexReason })`.
       • Si suggestions.length > 0 → return result con suggestions, NO persiste.
4 Si handler devolvió suggestions:
   4.1 `MessageRouter` intercepta el `result` de `_execute(CreateSemanticRuleCommand)`.
   4.2 Persist `WhatsappPendingClarification` (target_kind='rule', suggestions, meta con priority/ruleType para reconstruir).
   4.3 `session.pendingAction = 'create_rule_clarification'`.
   4.4 Bot manda lista numerada.
5 Manager responde: same loop as FLOW 7 step 6.

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
WhatsApp Clarification Resolver (cleanup de pending entries expiradas — TODO, hoy se filtra en query time)
