# Company Policies — Subsistema

> Last update: 2026-04-27 — capturado al cerrar el sprint del 26-27/04.
>
> Convive con `RULES-ENGINE.md` (semantic rules). Misma infraestructura
> LLM, distinto bounded context.

---

## 1. ¿Qué resuelve?

**SemanticRule** maneja casos particulares: "Pablo no trabaja los lunes",
"el 22 de abril es feriado". Se persisten en `semantic_rules` y se
mezclan en el prompt de schedule generation.

**CompanyPolicy** maneja invariantes **tenant-wide** que aplican a todos
los empleados: "11h descanso entre turnos", "2 días libres por semana
sin contar feriados", "máximo 40h semanales". Antes vivían como
constantes en código (ej. `MIN_REST_HOURS = 11` en
`ConflictResolutionService`); ahora son configurables por tenant.

| | SemanticRule | CompanyPolicy |
|---|---|---|
| Alcance | Caso particular | Tenant-wide |
| Sujeto | Empleado/grupo específico | Implícito: todos |
| Schema | 4 matchers (employee/date/hour/shift) | Open + interpreter accelerators |
| Persistencia | `semantic_rules` table + pgvector | `company_policies` table |
| LLM al crear | `RuleStructureExtractor` | `PolicyInterpreterRegistry.findMatch()` |
| Aplicación | Prompt LLM en schedule generation | Interpreter `apply()` deterministic + prompt para LLM-only |

---

## 2. Diseño: open + interpreter accelerators

**Decisión confirmada (2026-04-26)**: NO se usa enum cerrado de
`policyType`. Sería incompatible con multi-tenancy — cada empresa puede
querer reglas que el catálogo no contemple.

En cambio:
- La policy es **texto libre + params + interpreterId opcional**.
- Hay un **registry de `PolicyInterpreter`s en código**. Si alguno
  matchea el texto → se enchufa al solver deterministicamente. Si no →
  la policy queda LLM-only y solo se pasa al prompt en schedule
  generation.
- **Manager UX uniforme**: escribe en NL. El backend decide si la puede
  aplicar por código o vía LLM.

```
Manager submits: "Cada empleado descansa 11h entre turnos"
                       ↓
PolicyInterpreterRegistry.findMatch(text)
                       ↓
   ┌────── Matched ─────┐    ┌────── No match ───────┐
   │ MinRestHoursBetween│    │ RuleRephraseService    │
   │ Shifts.extractParams│    │ pide al LLM 2-3        │
   │   → { hours: 11 }  │    │ reformulaciones que SÍ │
   │                    │    │ matcheen un interpreter│
   │ persiste con       │    │                        │
   │ interpreterId=     │    │ Si suggestions ≠ []:    │
   │ 'min_rest_hours_   │    │   NO persiste,         │
   │  between_shifts'   │    │   devuelve picker.     │
   │                    │    │                        │
   │ status: 'created', │    │ Si LLM falla:          │
   │ mode: 'matched'    │    │   persiste como LLM-   │
   │                    │    │   only, status: 'created',│
   │                    │    │   mode: 'llm_only'.    │
   └────────────────────┘    └────────────────────────┘
```

---

## 3. Componentes

### Domain (`src/domain/`)
| Archivo | Rol |
|---|---|
| `aggregates/company-policy.aggregate.ts` | Aggregate root. `create()` / `fromPersistence()` / `attachInterpreter()` / `detachInterpreter()` / `replaceText()` / `setActive()`. `replaceText` limpia el interpreter (re-evaluación obligatoria). |
| `value-objects/policy-severity.vo.ts` | `'hard'` (constraint inviolable) o `'soft'` (preferencia). |
| `repositories/company-policy.repository.ts` | Port + Symbol `COMPANY_POLICY_REPOSITORY`. |
| `services/policy-interpreter.interface.ts` | Contract `PolicyInterpreter<TParams>` con `matches(text)` + `extractParams(text)` + `apply(ctx, params)` + `format(params)`. |
| `services/policy-interpreter-registry.ts` | Mantiene los interpreters; `findMatch(text)` recorre en orden de registro. |
| `services/policy-interpreters/min-rest-days-per-week.interpreter.ts` | "N días libres por semana, opcionalmente sin contar feriados". |
| `services/policy-interpreters/min-rest-hours-between-shifts.interpreter.ts` | "N horas de descanso entre turnos consecutivos". Reemplaza el hardcode 11h. |
| `services/policy-interpreters/iso-week.util.ts` | Helpers ISO-8601 inlined. |
| `services/company-policy-creator.service.ts` | Encapsula el flow `findMatch → extractParams → save` o `rephrase → suggestions`. Usado por el controller HTTP y por el MessageRouter de WhatsApp. |
| `services/rule-rephrase.service.interface.ts` | Token `RULE_REPHRASE_SERVICE` + tipos `RephraseSuggestion`. |
| `services/llm-rule-rephrase.service.ts` | Implementación: pide reformulaciones al LLM y **verifica** cada una contra el registry (filtra hallucinations). |
| `services/policy-enforcement.service.ts` | **MVP ready-to-plug**: `evaluate(companyId, ctx)` corre interpreters contra un schedule y devuelve violations agrupadas; `formatForPrompt(companyId)` rendea el bloque NL para el LLM. NO está aún wireado al `WeekScheduleBuilder`. |

### Infrastructure (`src/infrastructure/`)
| Archivo | Rol |
|---|---|
| `repositories/supabase-company-policy.repository.ts` | Implementación Supabase. Soft-delete via `deleted_at`. |

### Interfaces HTTP (`src/interfaces/`)
| Archivo | Rol |
|---|---|
| `controllers/company-policies.controller.ts` | CRUD `/company-policies`. POST devuelve discriminated union `'created' \| 'needs_clarification'`. |

### Application (CQRS / WhatsApp)
| Archivo | Rol |
|---|---|
| `application/conversational/message-router.service.ts` | Maneja intents `create_policy` y `create_policy_clarification` con el suggestion-loop por mensaje. |

### DB
| Migración | Crea |
|---|---|
| `20260427000000_company_policies.sql` | Tabla `company_policies` + partial UNIQUE `(company_id, interpreter_id) WHERE deleted_at IS NULL` + seed inicial de la regla "2 días descanso aparte del feriado". |
| `20260427000001_migrate_rest_days_rule_to_policy.sql` | Soft-delete de la `semantic_rule` equivalente (migración de datos). |
| `20260427000002_seed_min_rest_hours_policy.sql` | Seed `min_rest_hours_between_shifts { hours: 11 }` por tenant. |
| `20260427000003_whatsapp_pending_clarifications.sql` | Tabla para state machine del suggestion-loop por WhatsApp + `companies.whatsapp_policy_creator_roles`. |

---

## 4. Suggestion-loop

El patrón aparece en 4 lugares con la misma forma:

1. **Web — POST `/company-policies`**: si ningún interpreter matchea,
   responde `{ status: 'needs_clarification', suggestions: [...] }`. El
   frontend muestra picker en `CompanyPolicyFormDialog`.

2. **Web — POST `/rules/semantic`**: si el extractor LLM marca
   `intent='complex'`, el handler llama a `LlmSemanticRuleRephraseService`
   y devuelve `suggestions`. El frontend lo maneja en `CreateRuleDialog`.

3. **WhatsApp — `create_policy` intent**: `MessageRouter` llama al
   `CompanyPolicyCreator`. Si recibe `needs_clarification`, persiste una
   `WhatsappPendingClarification` (target_kind='policy') y replica con
   lista numerada. La respuesta numerada del manager dispara el handler
   `_handlePolicyClarificationResponse`.

4. **WhatsApp — `create_rule` intent**: mismo patrón pero
   target_kind='rule'.

### State machine (WhatsApp)

```
[user]: "los empleados descansen 2 días aparte del feriado"
         ↓ classifier → intent=create_policy
         ↓ permission check (whatsapp_policy_creator_roles)
         ↓ CompanyPolicyCreator.create()
         ↓ → status: 'needs_clarification' + suggestions
[bot]: "⚠️ Tu política es ambigua. Elegí una versión:
       1. Cada empleado descansa al menos 2 días por semana, sin contar feriados.
       2. ...
       3. ...
       Respondé con el número."
         ↓ persist WhatsappPendingClarification
         ↓ session.pendingAction = 'create_policy_clarification'
[user]: "1"
         ↓ matchea pendingAction → _handlePolicyClarificationResponse
         ↓ findActiveByEmployee → pickByNumber(1) → markResolved
         ↓ CompanyPolicyCreator.create() con texto elegido
         ↓ → status: 'created', mode: 'matched'
[bot]: "✅ Política creada: ..."
```

Tabla `whatsapp_pending_clarifications`:
- `target_kind` ∈ {'policy', 'rule'}
- `suggestions JSONB` (array con `id`, `suggestedText`, `meta`).
- `expires_at` TIMESTAMPTZ (default 10 min).
- `resolved_at` TIMESTAMPTZ NULL = pending.
- Index parcial: `(employee_id, created_at DESC) WHERE resolved_at IS NULL`.

---

## 5. Permisos por WhatsApp

`companies.whatsapp_policy_creator_roles TEXT[] DEFAULT ARRAY['manager']`.

`WhatsappPolicyPermissionService.canCreatePolicy({ employeeRole, companyId })`
consulta esa columna. Si el role del empleado está en la lista,
permite. Default conservador: solo `manager`. Tenant amplía via UPDATE.

---

## 6. Integración con el solver

**Estado actual: PolicyEnforcementService está wireado en DI pero el
`WeekScheduleBuilder` aún NO lo invoca.** El hardcode `MIN_REST_HOURS = 11`
en `ConflictResolutionService` no fue eliminado porque esa clase está
muerta — no la registra ningún módulo y el solver activo no la consume.

Cuando se aborde Phase 14 (scheduler v2 con policies-aware), los puntos
de plug son:

```ts
// Antes de llamar al LLM con el prompt:
const promptBlock = await policyEnforcement.formatForPrompt(companyId);
prompt += '\n\n' + promptBlock;

// Después de generar el schedule:
const result = await policyEnforcement.evaluate(companyId, { shifts });
if (result.hardViolations.length > 0) {
  // rebuild con feedback al LLM, o reject
}
// soft violations: log warning o ignorar
// llmOnlyPolicies: pasarlas al prompt si todavía no se hizo
```

---

## 7. Tests

| Spec | Cubre |
|---|---|
| `test/unit/domain/aggregates/company-policy.aggregate.spec.ts` | Invariantes del aggregate |
| `test/unit/domain/services/min-rest-days-per-week.interpreter.spec.ts` | matches/extract/apply/format |
| `test/unit/domain/services/min-rest-hours-between-shifts.interpreter.spec.ts` | mismo |
| `test/unit/domain/services/policy-interpreter-registry.spec.ts` | findMatch, dedup, optional empty |
| `test/unit/domain/services/llm-rule-rephrase.service.spec.ts` | parse, verify against registry, fallback |
| `test/unit/domain/services/llm-semantic-rule-rephrase.service.spec.ts` | parse + cap MAX_SUGGESTIONS |
| `test/unit/domain/services/company-policy-creator.service.spec.ts` | 3 caminos: matched, llm_only, needs_clarification |
| `test/unit/domain/services/policy-enforcement.service.spec.ts` | evaluate (hard/soft/llm-only) + formatForPrompt |
| `test/unit/domain/aggregates/whatsapp-pending-clarification.aggregate.spec.ts` | TTL, pickByNumber, idempotent resolve |
| `test/unit/domain/services/whatsapp-policy-permission.service.spec.ts` | role check + fail-closed default |

Total: 10 specs nuevos en este sprint.

---

## 8. Cómo agregar un nuevo PolicyInterpreter

1. Crear `src/domain/services/policy-interpreters/<name>.interpreter.ts`
   implementando `PolicyInterpreter<TParams>`.
2. Implementar `matches`, `extractParams`, `apply`, `format`.
3. Registrar en `application.module.ts`:
   - Sumar a `DomainServices`.
   - Sumar al `inject` array del `POLICY_INTERPRETERS_TOKEN` factory.
4. Si querés seedear la policy para tenants existentes: nueva
   migración tipo `<ts>_seed_<interpreter_name>_policy.sql` con
   `INSERT ... NOT EXISTS`.
5. Test: `<name>.interpreter.spec.ts` cubriendo los 4 métodos.

El registry y el rephrase service lo recogen automáticamente.

---

## 9. Frontend

| Archivo | Rol |
|---|---|
| `src/types/company-policy.ts` | TS types matching backend DTOs |
| `src/api/company-policies.api.ts` | Hooks React Query |
| `src/pages/policies/CompanyPoliciesPage.tsx` | Tabla con DataTable; filtros + paginación + actions |
| `src/pages/policies/CompanyPolicyFormDialog.tsx` | State machine: form → suggestions / llm-only-warning |
| `src/components/LanguageSwitcher.tsx` | Toggle EN/ES (i18n via i18next + LanguageDetector) |
| `src/lib/api-error.ts` | `describeApiError(err)` traduce `errorCode` del backend |
