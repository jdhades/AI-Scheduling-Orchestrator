# RULES-ENGINE.md

System Component:
Semantic Rule Engine (Phase 3.5 — LLM-authoritative)

Purpose

Allow administrators to define scheduling rules using natural language and
have them applied at generation time either as hard-enforced constraints or
as free-text instructions to the LLM that proposes weekly lines.

Example:

"Students cannot close the store on Fridays"

The engine classifies each rule into one of three buckets and feeds each
bucket into the generation pipeline via the path appropriate for it.

---

# ARCHITECTURE

The rule engine uses:

- Embedding Engine (`text-embedding-004`, 768-dim)
- Vector Database (pgvector on Supabase)
- Structure Extractor (`RuleStructureExtractor` — LLM-at-ingestion)
- Structured Rule Resolver (`StructuredRuleResolver` — matches structure to
  the week's employees + slots)
- Line Proposer + Rule Translator (`LLMLineProposerService`)
- Verifier (`WeekScheduleBuilder.verify()`)

Components

- Rule Input Layer (Command CQRS): `CreateSemanticRuleCommand`
- Embedding Engine (Gemini `text-embedding-004`)
- Vector Search (Supabase RPC `find_relevant_rules`)
- Semantic Retrieval Service (top-K + threshold 0.35)
- Structure Extractor at ingestion (stores `structure` JSON on the rule row)
- Structured Rule Resolver at generation
- Verify + Feedback Loop inside `WeekScheduleBuilder`

---

# RULE PRIORITIES

| Priority | Type | Effect |
|---|---|---|
| 1 | Legal / hard block | Enforced via `verify()` as hard violation |
| 2 | Semantic hard block | Enforced via `verify()` as hard violation (holiday, specific absence) |
| 3 | Preference / soft | Not enforced in `verify()`; passed to LLM as free text |

Priority maps to the `weight` stored on each constraint (inverse: priority 1
→ weight 3, priority 2 → weight 2, priority 3 → weight 1).

`SEMANTIC_BLOCKED_ALL = '*'` on `employeeId` means the whole shift/day is
blocked for everyone (used for holidays).

---

# RULE CLASSIFICATION AT INGESTION

When a manager writes a rule, `RuleStructureExtractor` (LLM call at creation
time) attempts to produce a `structure` JSON with:

- `employeeMatchers`
- `dateMatchers`
- `shiftNameMatchers`
- `hourRangeMatchers`

Three possible outcomes after resolution at generation time:

| Bucket | Condition | Downstream path |
|---|---|---|
| **structured** | Structure is present AND resolves to ≥1 concrete (employee,shift,date) tuple | Emits `SemanticConstraint[]`; enforced by `verify()` |
| **complex** | Structure is present but would block 100% of the week's slots | Reclassified by `StructuredRuleResolver` as complex; passed as raw text to the LLM prompt only |
| **unstructured** | Structure extraction failed or returned null | Passed as raw text to the LLM prompt only |

Complex + unstructured rules flow through the handler as `rawRuleTexts[]`
into `LLMLineProposerService.proposeLines()`.

---

# RULE PROCESSING PIPELINE (INGESTION)

```
1. Manager submits rule in natural language
2. RuleStructureExtractor (LLM) produces `structure` JSON (or null)
3. Embedding generated via Gemini `text-embedding-004`
4. Deduplication check: cosine distance < 0.12 ⇒ reject as duplicate
5. Row persisted in `semantic_rules` with priority, rule_type, structure
```

---

# RULE PROCESSING PIPELINE (GENERATION)

```
1. SemanticRetrievalService.retrieveAllForCompany(companyId)
     ↓ top-K relevant rules (cosine < 0.35 threshold)

2. StructuredRuleResolver.resolve(rules, employees, slots, weekStart)
     ↓ splits into:
         constraints[]         → structured, enforceable
         unstructuredRules[]   → free text
         complexRules[]        → free text
         multiShiftPermits[]   → per-employee exceptions for same-day shifts

3. Handler passes:
     semanticRules  = constraints
     rawRuleTexts   = [...unstructuredRules.ruleText, ...complexRules.ruleText]
     multiShiftPermits = permits
   to WeekScheduleBuilder.buildWithRetries()

4. LLMLineProposerService.proposeLines()
     ├─ translateRulesToEnglish(semanticRules.map(r=>r.rule) ∪ rawRuleTexts)
     │    (cached in-service per identical text set — skips re-translation on retry)
     ├─ buildPrompt() — rules appear deduped under `## Specific rules for this week`
     └─ LLM produces JSON + optional reasoning

5. WeekScheduleBuilder.verify(lines)
     ├─ holiday-worked         — from SEMANTIC_BLOCKED_ALL constraints
     ├─ employee-blocked       — from priority-1/2 constraints
     ├─ skill-mismatch         — from template.requiredSkills
     ├─ two-shifts-same-day    — unless covered by multiShiftPermits
     ├─ unknown-employee       — LLM returned a name that didn't resolve
     └─ unknown-template       — LLM returned a shift that didn't resolve

6. If violations → feedback prompt → attempt 2
7. If still invalid → deterministic fallback (`build()`)
```

---

# CONFLICT RESOLUTION

When multiple constraints touch the same (employee, shift, date) tuple, the
highest weight wins. All weight≥2 constraints are non-negotiable and go into
`verify()`. Weight-1 constraints are currently only visible to the LLM via
the prompt.

Example:

Rule A  (weight 3): John blocked Friday (legal)
Rule B  (weight 1): John prefers Friday (preference)

Resolution: Rule A wins — Rule B is ignored at hard-enforcement level but
the LLM still sees both in the prompt.

---

# RULE TRANSLATION (to English)

The proposer prompt is fully English. Rule texts authored in Spanish by the
manager are translated to English once per request via a preliminary LLM
call (`LLMLineProposerService.translateRulesToEnglish`), keyed by the
concatenated input. On retries within the same generation the cache hits
and no re-translation occurs.

If the translation call fails (timeout, bad JSON, shape mismatch), the
original texts are used verbatim and a warning is logged.

---

# VECTOR DATABASE STRUCTURE

Table: `semantic_rules`

Columns:
- `id`
- `company_id`
- `rule_text`
- `embedding` (vector(768))
- `priority_level`
- `rule_type`
- `structure` (jsonb — nullable)
- `created_by`
- `is_active`
- `metadata`
- `created_at`

`structure` holds the output of `RuleStructureExtractor` at ingestion.

---

# PERFORMANCE OPTIMIZATION

- Top-K similarity search (Supabase RPC `find_relevant_rules`) — threshold
  cosine distance < 0.35.
- Embeddings are cached (soft-delete to avoid regenerating).
- Rule translation is cached per-request in the proposer (AsyncLocalStorage-
  adjacent: instance-scoped `translationCache: Map<string, string[]>`).
- Deduplication threshold cosine distance < 0.12 at ingestion.

---

# FUTURE IMPROVEMENTS

- Rule explanation system: surface which constraint caused a specific
  assignment decision ("John was blocked by rule #23").
- Rule simulation before activation: preview the impact on the current week.
- Enforce currently-soft rules (like "max N off per day", rotation rules)
  as hard violations in `verify()` when they have structural matchers.
- Surface in the UI which rules were structured vs passed as free text —
  the manager can see where enforcement is guaranteed vs. LLM-best-effort.
