# SCHEDULER-ENGINE.md

System Component
AI Schedule Generation Engine

Purpose
Automatically generate optimal workforce schedules.

Goals
- maximize coverage
- maximize fairness
- respect constraints (semantic and legal)
- minimize cost

---

# PROBLEM TYPE

The scheduling problem is a Constraint Optimization Problem.

Variables:
Employee assignments to shifts.

Constraints:
- skills
- availability
- legal limits
- semantic rules (from RAG/Gemini)

Objective:
maximize operational efficiency.

---

# INPUT DATA

Employees
- id
- skills (ExperienceLevel)
- availability
- contract hours

Shifts
- id
- start_time
- end_time
- required_skills

Rules
- semantic rules (pgvector)
- legal constraints
- preferences

Historical Data
- previous schedules
- fairness metrics

---

# DECISION VARIABLES

Binary variable
X[e,s]

Meaning
Employee `e` assigned to shift `s`

Value
1 = assigned
0 = not assigned

---

# HARD CONSTRAINTS

Must always be satisfied.
- Employee must have required skill.
- Employee must be available (no overlapping assignments).
- Employee cannot exceed legal hours (contract).
- Minimum rest between shifts.
- Any Semantic Rule injected as a Level 1/Level 2 priority via the ConflictResolver.

---

# SOFT CONSTRAINTS

Preferred but not mandatory.
- Employee preferences.
- Fair distribution of weekends.
- Balanced night shifts.

---

# OBJECTIVE FUNCTION

Multi-objective optimization.

Maximize
- coverage score
- fairness score

Minimize
- labor cost
- preference violations

---

# OPTIMIZATION APPROACH

Hybrid Strategy: Logica Dura + AI LLM Heuristics

Phase 1: Constraint Solver
Uses dynamic heuristic programming (Node.js engine) mapping rule embeddings.
Filters out strictly impossible assignments based on hard constraints.

Phase 2: LLM Validation & Refinement
Uses Gemini 1.5 Pro to evaluate edge-cases or nuanced semantic rules that integer programming struggles with.
Purpose: improve fairness distribution and handle NLP constraints.

---

# FAIRNESS ENGINE

Compute fairness metrics.

Metrics:
- weekend distribution
- night shift distribution
- hours balance

Fairness score example:
0–100 scale encapsulated in the `FairnessScore` Value Object.

---

# DEMAND FORECASTING

Predict staffing needs.

Inputs:
- historical workload
- seasonality

Outputs:
- required employees per shift.

---

# GENERATION PIPELINE

Step 1: Manager dispatches `GenerateHybridScheduleCommand`.
Step 2: Load employees.
Step 3: Load shifts.
Step 4: Load semantic rules (Retrieve via pgvector).
Step 5: Compile constraints via ConflictResolutionEngine.
Step 6: Run optimization solver (ScheduleGenerator Domain Service).
Step 7: Apply fairness adjustments via LLM evaluation.
Step 8: Validate final schedule.
Step 9: Emit `ScheduleGenerated` event to the EventBus.

---

# PERFORMANCE TARGETS

Small business schedule
generation time < 2 seconds.

Enterprise schedule
generation time < 30 seconds.

---

# EDGE CASES

- Employee shortage.
- Skill shortage.
- Conflicting semantic rules.
System must generate the best possible partial schedule and flag `needs_replacement` or suggest Overtime assignments.

---

# TEST STRATEGY

Unit Tests:
- constraint validation (e.g. overlapping shift logic inside `ShiftAggregate`).
- RuleResolver hierarchy.

Integration Tests:
- complete schedule generation workflow through CQRS.

---

# FUTURE IMPROVEMENTS

- Direct OR-Tools (Python/C++) integration if dataset grows beyond heuristic bounds.
- Real-time schedule adaptation (Scenario 5 Auto-Repair integration).
- Autonomous workforce balancing metrics.
