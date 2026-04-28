# SCHEDULER-ENGINE.md

System Component
AI Schedule Generation Engine

Purpose
Automatically generate optimal weekly schedules per employee.

Goals
- respect hard constraints (legal, skills, semantic hard blocks)
- distribute coverage across elastic slots
- keep fairness over multiple generations (rolling history)
- apply free-text "soft" rules from the manager via LLM interpretation

Architecture (Phase 3.5)
LLM-authoritative with verify-loop + deterministic fallback. Constraint
solving happens post-hoc in `verify()`; the LLM proposes, the builder
audits, retries with feedback, and only falls back to a deterministic
employee-first engine if the LLM cannot converge in 2 attempts.

> Sprint 2026-04-27: el subsistema **Company Policies** está listo
> (`PolicyEnforcementService.evaluate()` + `formatForPrompt()`) pero el
> WeekScheduleBuilder NO lo invoca aún. La integración queda planificada
> para **Phase 14**. Ver sección "Future Improvements" al final.

---

# DATA MODEL SHIFT (Phase 13)

The legacy `shifts` table (daily instances) is deprecated.

Current model:

- `shift_templates` — logical definitions (recurrence, skill, required_employees
  nullable).
- `shift_memberships` — stable employee ↔ template bond with effective dates.
- `VirtualShiftSlot` — in-memory value object. Materialized on-demand from
  template × week-dates by `ShiftSlotGeneratorService`. NOT persisted.
- `ShiftAssignment` — the only persisted scheduling output. PK is its own UUID;
  domain-unique by `(templateId, date, origin, empId)`; requires
  `actualStartTime` and `actualEndTime`.

`required_employees = null` on a template ⇒ **elastic slot** (receives leftover
employees after exact-target slots are filled).

---

# INPUT DATA

Employees
- id, name, skills, availability, contract hours

Shift Templates
- id, name, start/end time, recurrence, required_skills, required_employees
  (`null` ⇒ elastic)

Shift Memberships
- employeeId ↔ templateId with effective date range

Rules
- semantic rules (pgvector, structured) — caso particular ("Pablo no trabaja los lunes")
- raw rule texts (unstructured + complex, passed as free text to the LLM)
- multi-shift permits
- holidays / vacation blocks (SEMANTIC_BLOCKED_ALL)

Policies (sprint 2026-04-27 — listas pero NO consumidas todavía por el solver)
- CompanyPolicy[] tenant-wide ("11h descanso entre turnos", "2 días libres por semana")
- Cada policy con interpreter persiste params estructurados extraídos del NL.
- Policies LLM-only (sin interpreter) viajarían al prompt como contexto.
- Cuando se integre: `PolicyEnforcementService.evaluate()` post-generation para hard policies; `formatForPrompt()` rendea bloque NL para soft + LLM-only.

Historical Data
- previous assignments per employee
- fairness histories

---

# HARD CONSTRAINTS (enforced by `verify()`)

Must always be satisfied. Detected by `WeekScheduleBuilder.verify()` and
converted into `VerifyViolation` entries. The LLM is asked to fix these
on retry.

Violation kinds:
- `holiday-worked` — assignment on a blocked day
- `employee-blocked` — weight≥2 semantic constraint for that employee×shift
- `skill-mismatch` — template requires a skill the employee lacks
- `two-shifts-same-day` — same employee assigned to 2 shifts on the same
  date (unless a `multiShiftPermit` covers it)
- `unknown-employee` / `unknown-template` — LLM returned a name that doesn't
  resolve

NOT enforced by verify (therefore free for the LLM to handle via prompt):
- fairness / balance across weeks
- rotation rules like "one day off per employee per week"
- distribution evenness (ceil/floor across elastic slots)

---

# SOFT CONSTRAINTS (LLM prompt only)

Passed to the LLM as free text in the `## Specific rules for this week`
section, plus the fixed `## General rules` section:
- one shift per employee per day
- spread rest days; don't concentrate rests
- alternate shift types (avoid an employee doing only one type)

The LLM may or may not comply; there is no automatic enforcement for these
rules beyond the prompt itself.

---

# GENERATION PIPELINE (LLM-authoritative)

```
Manager → GenerateHybridScheduleCommand
   │
   ▼
GenerateHybridScheduleHandler
   │
   ├─ Load employees + templates + memberships + fairness histories
   ├─ ShiftSlotGeneratorService.generateSlotsForWeek() → VirtualShiftSlot[]
   ├─ RAG retrieval (SemanticRetrievalService)
   ├─ StructuredRuleResolver.resolve()
   │    ├─ constraints (hard, structured)
   │    ├─ unstructuredRules (free-text)
   │    ├─ complexRules (free-text)
   │    └─ multiShiftPermits
   │
   ▼
WeekScheduleBuilder.buildWithRetries()
   │
   ├─ Attempt 1
   │    ├─ LLMLineProposerService.proposeLines()
   │    │    ├─ translateRulesToEnglish()  (cached LLM call)
   │    │    ├─ buildPrompt()              (EN, employee names, chain-of-thought)
   │    │    └─ parse()                    (name → UUID; tolerates prose before JSON)
   │    ├─ verify(lines) → VerifyViolation[]
   │    └─ if violations.empty → accept
   │
   ├─ Attempt 2 (only if attempt 1 failed)
   │    ├─ buildPrompt(feedback=formatted violations)
   │    ├─ verify(lines)
   │    └─ if violations.empty → accept
   │
   └─ Fallback (only if attempt 2 also failed)
        └─ build() — deterministic employee-first engine
   │
   ▼
Persist ShiftAssignment[]
Update fairness histories
LLMUsageTracker consolidates token usage → emits consolidated log
Publish ScheduleGenerated event + WebSocket notification
```

---

# LLM PROMPT DESIGN (see `LLMLineProposerService`)

The prompt is fully English. Structure:

1. `## Employees` — names + skills (no UUIDs; duplicate-name disambiguation adds
   a 6-char id suffix).
2. `## Shifts (valid every day of the week)` — name, time, capacity label
   (`ELASTIC` or `EXACT TARGET: N people/day`).
3. `## Week` — ISO range + per-date weekday.
4. `## Specific rules for this week` — deduped, LLM-translated-to-EN rule texts
   (structured + raw unstructured/complex).
5. `## General rules` — fixed boilerplate.
6. `## Distribution (deterministic, applied PER DAY)` — ceil/floor split logic
   for elastic slots.
7. `## Output format` — reasoning (3–5 lines) + JSON block.
8. `## Reference example` — 3 employees × 1 shift × 3 days (formatting demo).
9. Optional `## Your previous attempt was invalid` — feedback on retry.
10. `## Your task` — final instruction.

Parser:
- Strips code fences, grabs outermost `{...}`.
- Normalizes names (lowercase, diacritic-insensitive, strips parenthetical
  suffixes) before mapping to UUID.
- Tolerates `rest | libre | holiday | feriado | vacation | vacaciones` for
  rest days.

---

# OBSERVABILITY

`LLMUsageTracker` (AsyncLocalStorage) accumulates every `complete()` call
within a `tracker.run(...)` scope. Each provider (`QwenLLMService`,
`LocalLLMService`, `GeminiLLMService`) emits `tracker.record({prompt, completion, total})`
when the API returns a `usage` block.

The handler wraps the entire `runGeneration()` in the scope and logs:

```
📊 Hybrid schedule LLM usage — calls=N prompt=P completion=C total=T
```

---

# LLM PROVIDER SELECTION

Env var `ACTIVE_AI_PROVIDER`:
- `qwen` (default) — DashScope OpenAI-compat, model `qwen3.6-plus`
- `gemini` — Google Gemini 2.0 Flash
- `local` — `LocalLLMService` against any OpenAI-compat runtime
  (LM Studio, Ollama, llama.cpp server), config via
  `LLM_LOCAL_BASE_URL` + `LLM_LOCAL_MODEL`.

All providers implement `ILLMService.complete(prompt): Promise<string>`
so the proposer and rule-translator are provider-agnostic.

---

# FAIRNESS ENGINE

`FairnessHistoryVO` accumulates:
- undesirable shifts (weight 2.0)
- night shifts (weight 1.5)
- weekend shifts (weight 1.2)
- voluntary swaps (weight −0.5)

Score range: 0–1000. Used for rolling fairness but the LLM is not given
fairness weights in the prompt — the builder adjusts on retry via the
`verify()` feedback loop only for hard violations, not for fairness drift.
Post-generation fairness review is the manager's responsibility.

---

# PERFORMANCE TARGETS

Small business (≤20 employees, 7-day week)
- qwen3.6-plus: ~1.5–3 min per generation (most of which is LLM thinking)
- local LM Studio (qwen3.5-9b CPU): minutes; may crash on large prompts
- deterministic fallback: <1s

Token cost (per Phase 3.5 smoke, qwen3.6-plus):
- translation: ~2K tokens
- proposer: ~9K–10K tokens (mostly completion thinking)
- total: ~11K tokens per generation

---

# EDGE CASES

- Employee shortage → builder marks slots as `underfilled` (soft warning,
  not a hard violation).
- LLM returns invalid JSON → parser returns empty Map; attempt 2 is
  prompted with the translation/parse failure description.
- LLM crashes / timeouts (local runtime OOM, Qwen abort) → attempt 2 is
  attempted; if that also fails, deterministic fallback runs.
- Unstructured rule semantics are beyond what `verify()` checks → LLM may
  violate them freely; surface to the manager via inspection.

---

# TEST STRATEGY

Unit tests in `test/unit/services/week-schedule-builder.spec.ts`:
- LLM accepted in attempt 1
- LLM violates feriado, corrects in attempt 2
- LLM keeps violating → falls to deterministic
- Empty LLM response → deterministic
- `multiShiftPermit` allows valid two-shifts-same-day

Unit tests in `test/unit/services/llm-line-proposer.spec.ts`:
- Prompt contains expected sections
- Name ↔ UUID round-trip
- Duplicate name disambiguation
- `extractJson` tolerates prose + fenced JSON

---

# FUTURE IMPROVEMENTS

- Enforce "max N off per day" as a hard violation in `verify()` (currently
  free-for-all via prompt).
- Stream LLM response to reduce perceived latency.
- Per-week prompt cache keyed by `(templateSet, ruleSet, weekStart)` for
  deterministic replay.
- Per-tenant model selection via config, not env var.

# PHASE 14: POLICY-AWARE SCHEDULING (planeado, no implementado)

Sprint 2026-04-27 dejó listo el subsistema CompanyPolicy con
`PolicyEnforcementService` ready-to-plug. El solver actual no lo
invoca todavía. Pasos para integrar:

```ts
// Antes del primer attempt:
const activePolicies = await policyRepo.findAllActiveByCompany(companyId);
const policyContext = policyEnforcement.formatLoaded(activePolicies);

// En LLMLineProposerService.buildPrompt():
prompt += '\n\n' + policyContext; // Hard / Soft / LLM-only sections

// Después de cada attempt, en verify():
const policyResult = policyEnforcement.evaluateLoaded(activePolicies, { shifts });
if (policyResult.hardViolations.length > 0) {
  // Convertir a VerifyViolation[] y pasar al feedback de retry.
}
// Soft violations: log warning. LLM-only: ya están en el prompt.
```

Esto permitiría:
- Eliminar el legacy `ConflictResolutionService` (código muerto con
  `MIN_REST_HOURS = 11` hardcoded; reemplazado por `min_rest_hours_between_shifts`
  interpreter).
- Hacer todas las invariantes legales/empresariales **configurables por
  tenant** sin nuevos despliegues.
- Reusar el mismo `interpreter.format()` para mostrar al manager qué
  reglas le aplicó al schedule generado.

# OBSERVABILIDAD ACTUAL DEL SOLVER

`LLMUsageTracker` mide tokens. No mide:
- Tasa de éxito attempt-1 vs attempt-2 vs fallback
- Tipos de violaciones más frecuentes en attempt-2
- Tiempos de cada fase

Phase 14 sería buen momento para sumar metrics + dashboard.
