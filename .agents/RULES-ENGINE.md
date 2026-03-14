# RULES-ENGINE.md

System Component:
Semantic Rule Engine

Purpose

Allow administrators to define scheduling rules using natural language.

Example:

"Students cannot close the store on Fridays"

The engine converts this into machine-readable constraints.

---

# ARCHITECTURE

The rule engine uses:

Natural Language Processing
Vector Database (pgvector)
Rule Interpreter (Prompt Orchestrator / Gemini)

Components

Rule Input Layer (Command CQRS)
Embedding Engine (Gemini `text-embedding-004`)
Vector Search (Supabase RPC)
Conflict Resolution Engine (Domain Service)
Constraint Generator (Application Service)

---

# RULE TYPES

---

## Legal Rules

Highest priority rules.

Examples

maximum weekly hours
mandatory rest periods
labor laws

Priority Level

1

---

## Semantic Rules

Rules written by managers.

Examples

students cannot close on Friday
managers must open on Monday

Priority Level

2

---

## Preference Rules

Employee preferences.

Examples

prefer morning shifts
avoid weekends

Priority Level

3

---

# RULE PROCESSING PIPELINE

Step 1

Admin submits rule in natural language.

Step 2

Rule converted to embedding using external LLM.

Step 3

Stored in vector database.

Step 4

During schedule generation, rules are retrieved contextually (RAG).

Step 5

Rule interpreter (Gemini acting dynamically within the Generation prompt) converts rule into a constraint or heuristic logic to guide the algorithm.

Example

Rule

"Students cannot close Fridays"

Constraint mapped by the intelligence:

IF employee_type = student
AND shift_type = closing
AND day = Friday
THEN assignment = forbidden

---

# CONFLICT RESOLUTION

When rules conflict, the RuleResolver (ConflictResolutionEngine) hierarchy applies.

Priority Order

Legal Rules
Semantic Rules
Preferences

Example Conflict

Rule A
John must rest Friday

Rule B
John closes Friday

Resolution

Rule A wins (Legal > Preference/Semantic).

---

# VECTOR DATABASE STRUCTURE

Table

semantic_rules

Columns

id
company_id
rule_text
rule_embedding
rule_type
priority
is_active
created_at

---

# PERFORMANCE OPTIMIZATION

Use similarity search to retrieve relevant rules via Supabase RPC functions (`find_relevant_rules`).

Limit to top K (e.g., 5-10) most semantically similar rules during generation to fit into context windows.

Embeddings are cached and soft-deleted to avoid re-calculating NLP vectors for the same strings.

---

# FUTURE IMPROVEMENTS

Rule explanation system.

Example

"John cannot be scheduled Friday because of rule #23" (Handled partially by Gemini reasoning).

Rule simulation before activation.

Impact analysis on fairness distribution when enforcing a specific constraint.
