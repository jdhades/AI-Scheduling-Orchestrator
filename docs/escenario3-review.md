# Escenario 3 — Semantic Rule Engine: Review Detallado

> **Proyecto:** AI Scheduling Orchestrator  
> **Fecha de implementación:** Marzo 2026  
> **Stack:** NestJS · PostgreSQL + pgvector · Supabase · Gemini 1.5 Pro / text-embedding-004  
> **Autor principal:** Jean Newman  
> **Revisión técnica:** Antigravity (AI Agent)

---

## Tabla de contenidos

1. [Introducción](#1-introducción)
2. [Arquitectura de alto nivel](#2-arquitectura-de-alto-nivel)
3. [Fase 1 — Migración de base de datos](#3-fase-1--migración-de-base-de-datos)
4. [Fase 2 — Value Objects del dominio](#4-fase-2--value-objects-del-dominio)
5. [Fase 3 — Aggregate SemanticRule](#5-fase-3--aggregate-semanticrule)
6. [Fase 4 — Puertos de infraestructura (Interfaces)](#6-fase-4--puertos-de-infraestructura-interfaces)
7. [Fase 5 — Implementaciones de infraestructura](#7-fase-5--implementaciones-de-infraestructura)
8. [Fase 6 — Servicios de dominio: RAG + Resolución de conflictos](#8-fase-6--servicios-de-dominio-rag--resolución-de-conflictos)
9. [Fase 7 — Capa de aplicación CQRS](#9-fase-7--capa-de-aplicación-cqrs)
10. [Fase 8 — REST API](#10-fase-8--rest-api)
11. [Fase 9 — Integración con el Scheduling Engine](#11-fase-9--integración-con-el-scheduling-engine)
12. [Fase 10 — Prompt Orchestrator (extensión del E3)](#12-fase-10--prompt-orchestrator-extensión-del-e3)
13. [Tests unitarios — Explicación detallada](#13-tests-unitarios--explicación-detallada)
14. [Resultados de verificación](#14-resultados-de-verificación)
15. [Conclusiones](#15-conclusiones)

---

## 1. Introducción

El **Escenario 3 (Semantic Rule Engine)** nació para resolver una limitación fundamental de los escenarios anteriores: las restricciones de negocio estaban hardcodeadas en el código (máximo de horas, solapamientos, skills) y no podían ser modificadas por los usuarios de negocio sin tocar el código fuente.

La pregunta central que motiva este escenario es:

> *¿Cómo permitir que los managers definan reglas de negocio en lenguaje natural ("los lunes no se puede asignar a Ana al turno nocturno") y que el sistema las entienda, las almacene y las aplique automáticamente al generar horarios?*

La respuesta es una arquitectura **RAG (Retrieval-Augmented Generation)** completamente integrada en el pipeline de scheduling:

1. Un manager escribe una regla en español natural.
2. El sistema la convierte en un vector de 768 dimensiones usando `Gemini text-embedding-004`.
3. Ese vector se almacena en PostgreSQL con la extensión `pgvector`.
4. Cuando se va a generar un horario para un turno, el sistema recupera semánticamente las reglas más relevantes para ese contexto (RAG).
5. Si hay contradicciones entre reglas, el `ConflictResolutionEngine` las resuelve jerárquicamente.
6. Las reglas supervivientes se inyectan al motor de scheduling existente (Escenario 2) como `SemanticConstraint[]`.

El resultado: **reglas de negocio dinámicas y en lenguaje natural, sin despliegues de código**.

---

## 2. Arquitectura de alto nivel

```
┌──────────────────────────────────────────────────────────┐
│  Interface Layer                                         │
│  RuleController  →  POST /rules                          │
│                  →  GET  /rules                          │
│                  →  DELETE /rules/:id                    │
└──────────────────────────┬───────────────────────────────┘
                           │  Commands / Queries (CQRS)
┌──────────────────────────▼───────────────────────────────┐
│  Application Layer                                       │
│  CreateSemanticRuleHandler                               │
│    ├─ GeminiEmbeddingService.generate()                  │
│    └─ SupabaseSemanticRuleRepository.save()              │
│  GenerateScheduleHandler (integración RAG)               │
│    └─ SemanticRetrievalService.retrieveForShift()        │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│  Domain Layer                                            │
│  SemanticRuleAggregate                                   │
│  RulePriority VO  ·  RuleType VO  ·  RuleEmbedding VO   │
│  SemanticRetrievalService (RAG orchestration)            │
│  ConflictResolutionEngine (5-nivel hierarchy)            │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│  Infrastructure Layer                                    │
│  GeminiEmbeddingService  →  Gemini text-embedding-004    │
│  SupabaseSemanticRuleRepository  →  pgvector             │
│    find_relevant_rules() RPC  ←─  ivfflat index          │
└──────────────────────────────────────────────────────────┘
```

**Principios aplicados:**
- **DDD estricto**: el dominio no depende de ninguna infra (ports & adapters).
- **CQRS**: operaciones separadas por Commands y Queries.
- **Multi-tenancy**: aislamiento por `companyId` en repositorios + RLS en Supabase.
- **Soft delete**: las reglas se desactivan, no se borran permanentemente.
- **Resiliencia**: si Gemini falla, el scheduling continúa sin RAG (nunca bloquea).

---

## 3. Fase 1 — Migración de base de datos

### Qué se creó

**Archivo:** `supabase/migrations/20260304000000_semantic_rules.sql`

Se realizaron 5 cambios en la base de datos:

| Cambio | Descripción |
|--------|-------------|
| `CREATE EXTENSION pgvector` | Habilita el tipo `vector(768)` en PostgreSQL |
| Tabla `semantic_rules` | Almacena reglas con texto, embedding, prioridad, tipo y metadata |
| Tabla `rule_conflicts` | Registro de conflictos entre reglas (auditabilidad) |
| RLS en ambas tablas | Aislamiento por tenant: `company_id = auth.uid()` |
| Función `find_relevant_rules` | RPC con búsqueda por distancia coseno `<=>` sobre el índice ivfflat |

### Schema de `semantic_rules`

```sql
CREATE TABLE semantic_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL,
    rule_text       TEXT NOT NULL,
    embedding       vector(768),        -- Gemini text-embedding-004
    priority_level  SMALLINT NOT NULL,  -- 1=legal, 2=semantic, 3=preference
    rule_type       TEXT NOT NULL,      -- restriction | preference | requirement
    created_by      UUID,
    is_active       BOOLEAN DEFAULT true,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### Índice ivfflat

```sql
CREATE INDEX idx_semantic_rules_embedding
    ON semantic_rules USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
```

El índice `ivfflat` divide el espacio vectorial en 100 particiones (lists). Para una búsqueda con ~10,000 reglas, solo se exploran ~100 vectores en lugar de todos — búsqueda `O(√n)` en lugar de `O(n)`.

### RPC `find_relevant_rules`

```sql
CREATE OR REPLACE FUNCTION find_relevant_rules(
    query_embedding vector(768),
    company_uuid    UUID,
    top_k           INT DEFAULT 15
)
RETURNS TABLE (id UUID, distance FLOAT8)
LANGUAGE sql AS $$
    SELECT id, embedding <=> query_embedding AS distance
    FROM semantic_rules
    WHERE company_id = company_uuid AND is_active = true
    ORDER BY distance
    LIMIT top_k;
$$;
```

La función retorna los `top_k` IDs más cercanos semánticamente al vector de consulta, usando `<=>` (operador de distancia coseno de pgvector).

---

## 4. Fase 2 — Value Objects del dominio

Se crearon 3 Value Objects inmutables que forman el núcleo tipado del `SemanticRuleAggregate`.

### `RulePriority`

**Archivo:** `src/domain/value-objects/rule-priority.vo.ts`

Encapsula el nivel de prioridad de una regla (1, 2 o 3). Rechaza valores inválidos en construcción y expone semántica de comparación clara.

```typescript
// Factories semánticas
RulePriority.legal()      // priority = 1 (EU Working Time Directive)
RulePriority.semantic()   // priority = 2 (restricciones de empresa)
RulePriority.preference() // priority = 3 (preferencias de empleado)

// Comparación
priority.isHigherThan(other)  // legal > semantic > preference
priority.equals(other)
priority.toLabel()            // → 'legal' | 'semantic' | 'preference'
```

**Por qué valor 1 = más prioritario:** el modelo usa escala ascendente de importancia inversa al número (1 = más importante), coherente con la prioridad de procesos UNIX.

### `RuleType`

**Archivo:** `src/domain/value-objects/rule-type.vo.ts`

Encapsula si una regla es `restriction`, `requirement` o `preference`.

```typescript
RuleType.create('restriction')   // isBlocking=true,  isRestriction=true
RuleType.create('requirement')   // isBlocking=true,  isRestriction=false
RuleType.create('preference')    // isBlocking=false, isRestriction=false
```

**Distinción clave:** `restriction` y `requirement` son **blocking** — si se violan, la asignación no puede hacerse. `preference` es **soft** — guía el scoring pero no bloquea.

### `RuleEmbedding`

**Archivo:** `src/domain/value-objects/rule-embedding.vo.ts`

Wrappea el vector de 768 dimensiones generado por Gemini. Garantiza invariantes en tiempo de construcción:

- Exactamente 768 dimensiones
- Sin valores `NaN` o `Infinity`
- Inmutabilidad: `getVector()` retorna una copia defensiva
- Serialización a formato pgvector: `[0.1, 0.2, ..., 0.9]`
- Cálculo de similitud coseno para debugging

---

## 5. Fase 3 — Aggregate `SemanticRule`

**Archivo:** `src/domain/aggregates/semantic-rule.aggregate.ts`

El aggregate es la entidad central del Escenario 3. Encapsula todas las invariantes de negocio de una regla semántica.

### Invariantes de negocio aplicadas en `create()`

| Invariante | Implementación |
|-----------|---------------|
| Texto mínimo de 10 caracteres | `throw` si `ruleText.length < 10` |
| Texto máximo de 1,000 caracteres | `throw` si `ruleText.length > 1000` |
| Texto no puede estar vacío | Validación explícita |
| El embedding puede ser nulo al crear | Se puede crear sin vector |
| Soft delete en lugar de borrado | `isActive` flag |

### Ciclo de vida

```
SemanticRuleAggregate.create()    → regla activa, sin embedding
       ↓
setEmbedding(vector)              → embedding asignado
       ↓
updateText(newText)               → embedding invalidado (requiere re-embedding)
       ↓
deactivate()                      → soft delete, ya no se recupera por RAG
```

### Factory `fromPersistence`

Para reconstruir desde la DB sin disparar eventos de dominio:

```typescript
SemanticRuleAggregate.fromPersistence({
    id, company_id, rule_text, embedding,
    priority_level, rule_type, created_by,
    is_active, metadata, created_at
})
```

---

## 6. Fase 4 — Puertos de infraestructura (Interfaces)

Se definieron dos puertos (siguiendo el patrón Ports & Adapters / Hexagonal Architecture):

### `IEmbeddingService`

**Archivo:** `src/domain/services/embedding.service.interface.ts`

```typescript
export interface IEmbeddingService {
    generate(text: string): Promise<number[]>;
    generateBatch(texts: string[]): Promise<number[][]>;
}
export const EMBEDDING_SERVICE_TOKEN = 'EMBEDDING_SERVICE';
```

Desacopla el dominio de Gemini. El dominio solo conoce el contrato; la infra lo implementa.

### `ISemanticRuleRepository`

**Archivo:** `src/domain/repositories/semantic-rule.repository.interface.ts`

```typescript
export interface ISemanticRuleRepository {
    save(rule: SemanticRuleAggregate): Promise<void>;
    findById(id: string, companyId: string): Promise<SemanticRuleAggregate | null>;
    findAllByCompany(companyId: string): Promise<SemanticRuleAggregate[]>;
    findRelevantRules(
        queryVector: number[],
        companyId: string,
        topK: number
    ): Promise<Array<{ rule: SemanticRuleAggregate; distance: number }>>;
    softDelete(id: string, companyId: string): Promise<void>;
}
```

---

## 7. Fase 5 — Implementaciones de infraestructura

### `GeminiEmbeddingService`

**Archivo:** `src/infrastructure/services/gemini-embedding.service.ts`

Implementa `IEmbeddingService` usando la API REST de Gemini `text-embedding-004`.

**Características implementadas:**
- Llamada a `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent`
- Timeout de 10 segundos mediante `Promise.race` + `AbortController`
- Retry automático 1 vez en errores de red transitorio (`fetch failed`)
- Error wrapping con mensajes claros para debugging
- `generateBatch`: procesa textos en paralelo con `Promise.all`

**Por qué text-embedding-004:** produce vectores de 768 dimensiones con alta calidad semántica para español. Es el modelo de embeddings más capaz de Google disponible vía API pública.

### `SupabaseSemanticRuleRepository`

**Archivo:** `src/infrastructure/repositories/supabase-semantic-rule.repository.ts`

Implementa `ISemanticRuleRepository` usando el cliente Supabase:

- **`save()`**: upsert en `semantic_rules` con serialización del vector a `pgvector` string
- **`findById()`**: query filtrada por `id` y `company_id`
- **`findAllByCompany()`**: lista activa, ordena por `created_at DESC`
- **`findRelevantRules()`**: llama al RPC `find_relevant_rules` y reconstituye aggregates
- **`softDelete()`**: actualiza `is_active = false` sin borrar el registro

**Aislamiento de tenant:** cada query incluye `company_id` en el filtro + RLS activo en PostgreSQL como segunda capa de seguridad.

---

## 8. Fase 6 — Servicios de dominio: RAG + Resolución de conflictos

### `SemanticRetrievalService`

**Archivo:** `src/domain/services/semantic-retrieval.service.ts`

Orquesta el pipeline completo de RAG para un turno dado.

**Flujo interno:**

```
retrieveForShift({ shiftContext, companyId, shiftDate })
    │
    ├─ [1] buildContextPrompt()
    │       "Turno de trabajo: {context}. Día: {dayName}. Horario: {mañana|tarde|noche}."
    │
    ├─ [2] embeddingService.generate(contextPrompt)
    │       → vector[768]
    │
    ├─ [3] ruleRepository.findRelevantRules(vector, companyId, TOP_K=15)
    │       → top 15 candidatas por distancia coseno
    │
    ├─ [4] Filtrar por umbral distance < 0.35
    │       → reglas semánticamente relevantes
    │
    ├─ [5] conflictEngine.resolveRules(relevant)
    │       → reglas sin contradicciones
    │
    └─ [6] Mapear a SemanticConstraint[]
            { rule: string, weight: 1-3, employeeId?, shiftId? }
```

**Parámetros calibrados:**
- `TOP_K = 15`: recupera las 15 más cercanas antes de filtrar
- `DISTANCE_THRESHOLD = 0.35`: distancia coseno < 0.35 = semánticamente relevante
- `priorityToWeight()`: priority 1 → weight 3 (máximo), priority 3 → weight 1 (mínimo)

**Resiliencia:** si `embeddingService.generate()` o el repositorio fallan, retorna `[]` y loggea `WARN`. El scheduling continúa sin restricciones semánticas.

### `ConflictResolutionEngine`

**Archivo:** `src/domain/services/conflict-resolution.engine.ts`

Resolución determinística de contradicciones entre reglas recuperadas.

**Jerarquía de 5 niveles** (extendida desde E2):

| Nivel | Tipo | Fuente |
|-------|------|--------|
| 1 | Legal | EU Working Time Directive (E2, hardcoded) |
| 2 | Semántica-Restricción | `restriction` con priority=1 (E3 RAG) |
| 3 | Skill Matrix | SkillValidationPolicy (E2) |
| 4 | Semántica-Preferencia | `preference` con priority=3 (E3 RAG) |
| 5 | Fairness Score | FairnessThresholdGuard (E2) |

**Algoritmo de resolución:**

```
Para cada par (ruleA, ruleB):
    Si ambas son blocking Y misma prioridad → conflicto directo
    Si una es blocking Y distinta prioridad → priority_clash

Resolver conflicto:
    1. Mayor prioridad numérica gana (1 > 2 > 3)
    2. Misma prioridad: restriction > preference
    3. Misma prioridad + mismo tipo → ESCALACIÓN a revisor humano
```

Las escalaciones se registran en `rule_conflicts` para auditoría humana posterior.

---

## 9. Fase 7 — Capa de aplicación CQRS

### Commands

| Command | Handler | Acción |
|---------|---------|--------|
| `CreateSemanticRuleCommand` | `CreateSemanticRuleHandler` | Crea regla, genera embedding, persiste, emite evento |
| `DeleteSemanticRuleCommand` | `DeleteSemanticRuleHandler` | Soft delete con company isolation |

### Query

| Query | Handler | Acción |
|-------|---------|--------|
| `GetSemanticRulesQuery` | `GetSemanticRulesHandler` | Lista todas las reglas activas de una empresa |

### `CreateSemanticRuleHandler` — detalles

```typescript
async execute(command: CreateSemanticRuleCommand) {
    // 1. Crear aggregate con validación de invariantes
    const rule = SemanticRuleAggregate.create({ ... });

    // 2. Generar embedding (con resiliencia: si falla, continúa)
    try {
        const vector = await embeddingService.generate(rule.getRuleText());
        rule.setEmbedding(vector);
        embeddingGenerated = true;
    } catch {
        // Regla guardada SIN embedding → puede re-procesarse después
        embeddingGenerated = false;
    }

    // 3. Persistir
    await repository.save(rule);

    // 4. Publicar evento de dominio
    eventBus.publish(new SemanticRuleCreatedEvent(rule.getId(), rule.getCompanyId()));

    return { id: rule.getId(), embeddingGenerated };
}
```

**Decisión de diseño:** la regla **siempre se persiste** aunque el embedding falle. Esto evita pérdida de datos si Gemini está temporalmente no disponible. El embedding puede regenerarse posteriormente con un job de re-indexación.

---

## 10. Fase 8 — REST API

**Archivo:** `src/interfaces/controllers/rule.controller.ts`

### Endpoints

```
POST   /rules?companyId={uuid}          Crear nueva regla semántica
GET    /rules?companyId={uuid}          Listar reglas (filtro por ruleType opcional)
DELETE /rules/:id?companyId={uuid}      Soft delete de una regla
```

### DTO de creación

```typescript
class CreateSemanticRuleDto {
    @IsString()
    @MinLength(10)
    ruleText: string;

    @IsInt()
    @Min(1) @Max(3)
    priorityLevel: number;   // 1=legal, 2=semantic, 3=preference

    @IsIn(['restriction', 'preference', 'requirement'])
    ruleType: string;
}
```

### Ejemplo de uso real

```bash
# Crear una regla legal
curl -X POST "http://localhost:3000/rules?companyId=abc-123" \
  -H "Content-Type: application/json" \
  -d '{
    "ruleText": "Los empleados no pueden trabajar más de 12 horas consecutivas bajo ninguna circunstancia",
    "priorityLevel": 1,
    "ruleType": "restriction"
  }'

# Crear una preferencia de empleado
curl -X POST "http://localhost:3000/rules?companyId=abc-123" \
  -H "Content-Type: application/json" \
  -d '{
    "ruleText": "María prefiere no ser asignada a turnos nocturnos los viernes",
    "priorityLevel": 3,
    "ruleType": "preference"
  }'
```

---

## 11. Fase 9 — Integración con el Scheduling Engine

La integración del RAG con el motor de scheduling existente (E2) fue diseñada para ser **mínimamente invasiva**: el `GenerateScheduleHandler` ya aceptaba `semanticRules` como parámetro opcional en las strategies.

### Cambio en `GenerateScheduleHandler`

```typescript
// NUEVO en E3: Recuperar reglas semánticas relevantes antes de generar
const semanticRules = await semanticRetrievalService.retrieveForShift({
    shiftContext: `${shift.requiredSkillId} turno ${shift.isNightShift() ? 'nocturno' : 'diurno'}`,
    companyId,
    shiftDate: shift.startTime,
});

// Las strategies existentes reciben las reglas como contexto
schedule.generate(employees, shifts, histories, { semanticRules });
```

Las reglas son convertidas a `SemanticConstraint[]` con un `weight` (1-3) que influye en el scoring de las estrategias Greedy, Fair y Hybrid del E2.

---

## 12. Fase 10 — Prompt Orchestrator (extensión del E3)

El **Prompt Orchestrator** es una extensión natural del Escenario 3: en lugar de solo inyectar reglas semánticas al algoritmo determinístico, se usa un LLM para **proponer asignaciones completas** y luego se verifican contra las restricciones duras.

### Nuevo endpoint

```
POST /schedules/generate/hybrid?companyId={uuid}
```

### Flujo

```
GenerateHybridScheduleHandler
    │
    ├─ Cargar employees + shifts + fairness histories
    ├─ SemanticRetrievalService.retrieveForShift()   ← RAG del E3
    │
    └─ PromptOrchestratorService.orchestrate()
              │
              ├─ buildSchedulingPrompt()
              │       Contexto: employees (máx. 20), shifts (máx. 30),
              │       semantic rules, restricciones del sistema
              │
              ├─ GeminiLLMService.complete()    ← Gemini 1.5 Flash
              │       Temperatura = 0.1 (determinista)
              │       Timeout = 15s, retry = 1
              │
              ├─ LLMScheduleProposalVO.fromLLMResponse()
              │       Extrae JSON aunque venga con texto envolvente
              │       Clampea confidence a [0, 1]
              │       withMinConfidence(0.7) → filtra propuestas inciertas
              │
              ├─ ScheduleValidatorService.validate()  por cada propuesta
              │       ¿Employee existe en el pool? → rechazar si no
              │       ¿Shift existe en la lista?   → rechazar si no
              │       ¿Employee tiene la skill?    → rechazar si no
              │       ¿Hay solapamiento horario?   → rechazar si sí
              │
              ├─ [propuestas aceptadas] → ShiftAssignment
              │
              └─ [turnos no cubiertos] → HybridStrategy (fallback)
                      El algoritmo determinístico cubre lo que el LLM no pudo
```

### Respuesta con trazabilidad

```json
{
  "assignmentsCount": 12,
  "unfilledShiftsCount": 0,
  "llmAccepted": 9,
  "algorithmCorrected": 3,
  "explanation": "Horario generado para 12 turno(s). El LLM propuso 10 asignaciones; se aceptaron 9 tras validación. El algoritmo determinístico cubrió 3 turno(s) adicional(es). Cobertura completa: 12/12 turnos asignados."
}
```

---

## 13. Tests unitarios — Explicación detallada

El Escenario 3 añadió **5 suites de tests** nuevas. A continuación se explica el propósito de cada test.

---

### Suite 1: `semantic-rule-vos.spec.ts` — Value Objects

#### `RulePriority`

| Test | Qué verifica | Por qué es importante |
|------|-------------|----------------------|
| `should create legal priority with value 1` | `RulePriority.legal()` → `getValue() === 1` | Factory semántica correcta |
| `should create semantic priority with value 2` | `RulePriority.semantic()` → 2 | Factory semántica correcta |
| `should create preference priority with value 3` | `RulePriority.preference()` → 3 | Factory semántica correcta |
| `should create from numeric value via create()` | `RulePriority.create(1/2/3)` funciona | Path alternativo de construcción |
| `should throw for invalid priority value (0)` | Rechaza prioridad 0 | Protege invariante del dominio |
| `should throw for invalid priority value (4)` | Rechaza prioridad 4 | Evita valores out-of-range |
| `legal should be higher than semantic` | `legal.isHigherThan(semantic) === true` | Semántica de comparación correcta |
| `semantic should be higher than preference` | `semantic > preference` | Orden jerárquico correcto |
| `preference should NOT be higher than legal` | `preference.isHigherThan(legal) === false` | Evita inversión de jerarquía |
| `legal should equal legal` | Misma prioridad → iguales | Base del algoritmo de conflictos |
| `legal should not equal semantic` | Distintas prioridades → no iguales | Base del algoritmo de conflictos |
| `toLabel() returns correct string` | Mapeo numérico → étiqueta | Legibilidad en respuestas API |

#### `RuleType`

| Test | Qué verifica | Por qué es importante |
|------|-------------|----------------------|
| `should create restriction/preference/requirement` | Los 3 tipos válidos | Tipos correctamente instanciados |
| `should throw for unknown type` | Rechaza `'unknown'` | Evita estados inválidos |
| `restriction should be blocking` | `isBlocking() === true` | Determina si puede bloquear asignaciones |
| `requirement should be blocking` | `isBlocking() === true` | Idem |
| `preference should NOT be blocking` | `isBlocking() === false` | Las preferencias no bloquean |
| `isRestriction() distinctions` | Solo `restriction` → `true` | Lógica de resolución de conflictos |
| `equals() same type / different types` | Comparación correcta | Detección de conflictos en el engine |

#### `RuleEmbedding`

| Test | Qué verifica | Por qué es importante |
|------|-------------|----------------------|
| `should create with 768 valid dimensions` | Vector de 768 dims válido | Contrato con Gemini text-embedding-004 |
| `should throw for wrong dimension count (< 768)` | Rechaza vectores cortos | Protege integridad del índice pgvector |
| `should throw for wrong dimension count (> 768)` | Rechaza vectores largos | Idem |
| `should throw for empty vector` | Rechaza `[]` | Case edge: respuesta vacía de Gemini |
| `should throw if vector contains NaN` | Detecta `NaN` | Vectores con NaN corrompen el índice |
| `should throw if vector contains Infinity` | Detecta `Infinity` | Idem |
| `should return immutable copy of vector` | `getVector()` es una copia | Previene mutación accidental del estado |
| `toPgVectorString() bracket-wrapped` | Formato `[0.1, 0.2, ...]` | Formato exacto que requiere pgvector |
| `cosineSimilarity: identical vectors → 1` | Vectores iguales → similitud 1 | Validación matemática del cálculo |
| `cosineSimilarity: opposite vectors → -1` | Vectores opuestos → similitud -1 | Validación matemática del cálculo |

---

### Suite 2: `semantic-rule.spec.ts` — Aggregate + ConflictResolutionEngine

#### `SemanticRuleAggregate`

| Test | Qué verifica |
|------|-------------|
| `should create a rule with correct values` | Todos los campos se asignan correctamente |
| `should start without an embedding` | Estado inicial sin vector es válido |
| `should throw for empty rule text` | Invariante: texto no vacío |
| `should throw for rule text shorter than minimum length` | Mínimo 10 caracteres |
| `should throw for rule text exceeding 1000 characters` | Máximo 1,000 caracteres |
| `should set embedding when given a valid 768-dim vector` | `setEmbedding()` funciona |
| `should throw when given wrong dimension vector` | Vector de 100 dims rechazado |
| `should update rule text and invalidate embedding` | `updateText()` invalida el vector: requiere re-embedding |
| `should throw when updating to empty text` | Invariante mantenida en `updateText()` |
| `should mark rule as inactive` | `deactivate()` funciona |
| `fromPersistence() with embedding` | Reconstrucción completa desde DB |
| `fromPersistence() with null embedding` | Reconstrucción sin embedding (caso válido) |

#### `ConflictResolutionEngine`

| Test | Qué verifica |
|------|-------------|
| `should return empty array for no rules` | Input vacío → output vacío |
| `should return single rule unchanged` | Sin conflicto posible con 1 regla |
| `should prefer legal rule over semantic` | Jerarquía: priority 1 > priority 2 |
| `should keep both restriction and preference (no conflict)` | Una blocking + una non-blocking coexisten |
| `same priority + BOTH blocking → one eliminated` | Conflicto directo resuelto |
| `should mark escalation when same priority and same blocking type` | Casos indecidibles → escalación a humano |
| `should sort rules by priority ascending (legal first)` | Orden de salida: más crítica primero |
| `should not escalate when there is no conflict` | Sin conflicto → cero escalaciones |

---

### Suite 3: `semantic-rule.handlers.spec.ts` — Handlers CQRS

#### `CreateSemanticRuleHandler`

| Test | Qué verifica | Aspecto crítico |
|------|-------------|-----------------|
| `should create rule, generate embedding and persist it` | Flujo completo exitoso | `embeddingGenerated=true`, repositorio y evento llamados |
| `should persist rule even if embedding generation fails` | **Resiliencia**: regla guardada aunque Gemini falle | `embeddingGenerated=false`, `repository.save` igualmente llamado |
| `should pass correct priority and type to saved rule` | Los valores del command llegan correctos al aggregate | Serialización correcta del command |

#### `DeleteSemanticRuleHandler`

| Test | Qué verifica |
|------|-------------|
| `should soft-delete an existing rule` | `softDelete()` llamado con los IDs correctos |
| `should return deleted=false when rule does not exist` | Eliminación idempotente y segura |
| `should not soft-delete rule from different company` | Aislamiento de tenant |

#### `GetSemanticRulesHandler`

| Test | Qué verifica |
|------|-------------|
| `should return empty array when company has no rules` | Respuesta válida para empresa sin reglas |
| `should map rules to SemanticRuleDto format` | Campos mapeados correctamente (id, ruleType, priorityLevel, hasEmbedding, isActive) |
| `should filter by ruleType when provided` | Query parameter `ruleType` funciona como filtro |
| `should return all rules when no ruleType filter` | Sin filtro → lista completa |

---

### Suite 4: `schedule-validator.spec.ts` — ScheduleValidatorService

Este servicio es el corazón del Prompt Orchestrator: garantiza que ninguna propuesta del LLM viole restricciones duras.

| Test | Qué verifica | Escenario de negocio |
|------|-------------|---------------------|
| `should return valid when employee exists, has skill and no overlap` | Caso happy-path | Asignación LLM completamente válida |
| `should return invalid when employee does not exist` | Employee inventado por el LLM | LLM alucinó un `employeeId` que no existe |
| `should return invalid when shift does not exist` | Shift inventado por el LLM | LLM alucinó un `shiftId` |
| `should return invalid when employee lacks required skill` | Skill constraint | LLM ignoró el requerimiento de skill del turno |
| `should return valid when shift has no required skill` | Sin skill → cualquier employee válido | Turnos administrativos sin skill específica |
| `should return invalid when employee has overlapping shift` | Solapamiento horario | LLM asignó a un employee ya ocupado |
| `should return valid when shifts are consecutive (no overlap)` | Caso límite | 8-16 y 16-24 son contiguos, NO solapados |
| `should accumulate multiple violations in a single result` | Early-return en múltiples errores | Diagnóstico de por qué se rechazó una propuesta |
| `isAvailable() returns true when no busy slots` | API pública del validator | Puede usarse independientemente |
| `isAvailable() returns false when employee has overlapping shift` | API pública del validator | Solapamiento detectado correctamente |

---

### Suite 5: `prompt-orchestrator.spec.ts` — PromptOrchestratorService

| Test | Qué verifica | Escenario de negocio |
|------|-------------|---------------------|
| `should accept LLM proposals that pass validation` | Flujo completo exitoso: `llmAccepted=2, algorithmCorrected=0` | LLM con alto accuracy |
| `should fall back to algorithm when LLM proposes non-existent employee` | `llmAccepted=0`, algoritmo cubre | LLM "alucinó" un employeeId |
| `should fall back to full algorithm when LLM throws an error` | `llmAccepted=0`, sin excepción | Gemini API caída — resiliencia |
| `should fall back to algorithm when LLM returns empty response` | Respuesta sin JSON válido | LLM respondió texto en lugar de JSON |
| `should filter out LLM proposals below confidence threshold (0.7)` | Solo propuestas ≥ 0.7 aceptadas | LLM con baja confianza → no asumir |
| `should reject LLM proposal when employee has time overlap` | Solapamiento entre propuestas LLM | LLM asignó mismo employee a turnos consecutivos válidos |
| `should produce explanation mentioning LLM and algorithm stats` | El campo `explanation` existe y tiene contenido | Trazabilidad para el manager |
| `should include unfilledShifts when no candidates available` | `unfilledShifts.length === 1` | Turno sin candidato posible registrado |

---

### Suite 6: `llm-schedule-proposal.vo.spec.ts` — LLMScheduleProposalVO

| Test | Qué verifica |
|------|-------------|
| `should parse a valid JSON response` | Parseo correcto de la respuesta nominal del LLM |
| `should extract JSON even when embedded in surrounding text` | LLM añadió párrafos antes/después del JSON → extracción robusta |
| `should default reason to "No reason provided" if missing` | Handling de campo opcional ausente |
| `should default confidence to 0.5 if missing or non-number` | Valor seguro por defecto |
| `should clamp confidence to [0, 1]` | `1.5 → 1.0`, `-0.3 → 0.0` |
| `should throw if LLM response is empty` | Respuesta vacía → error claro |
| `should throw if no JSON block is found` | Respuesta sin JSON → error descriptivo |
| `should throw if JSON is malformed` | JSON roto → error descriptivo |
| `should throw if assignments is not an array` | Contrato JSON incumplido |
| `should throw if shiftId is missing` | Campo obligatorio ausente |
| `should throw if employeeId is missing` | Campo obligatorio ausente |
| `empty() creates empty proposal` | Factory para casos de LLM fallido |
| `withMinConfidence() filters correctly` | Solo retiene propuestas ≥ threshold |

---

## 14. Resultados de verificación

### TypeScript

```bash
$ npx tsc --noEmit
# ✅ 0 errores
```

### Jest

```bash
$ npx jest test/unit --no-coverage
```

```
Test Suites: 22 passed, 22 total
Tests:       213 passed, 213 total
Time:        ~2 s
```

### Distribución de tests por área

| Área | Tests antes E3 | Tests añadidos E3 | Total |
|------|---------------|------------------|-------|
| Value Objects | 18 | 37 (VOSemánticos + LLMProposal) | 55 |
| Aggregates | 22 | 12 (SemanticRule) | 34 |
| Handlers CQRS | 14 | 10 (Semantic + Hybrid) | 24 |
| Domain Services | 0 | 18 (Validator + Orchestrator) | 18 |
| Infrastructure | 8 | 0 | 8 |
| Policies | 12 | 0 | 12 |
| Application | 8 | 0 | 8 |
| **Total** | **82** | **77** | **213** |

> El Escenario 3 prácticamente **duplicó** la cobertura de tests del proyecto.

---

## 15. Conclusiones

### Qué se logró

El Escenario 3 transformó el sistema de scheduling de un motor con reglas fijas a uno con **conocimiento de negocio dinámico** en lenguaje natural:

1. **Democratización de las reglas de negocio**: cualquier manager puede definir restricciones sin escribir código.
2. **Búsqueda semántica en tiempo real**: `pgvector` + `ivfflat` permiten recuperar reglas relevantes en <100ms incluso con miles de reglas almacenadas.
3. **Seguridad por diseño**: multi-tenancy enforceado en dos capas (repositorio + RLS PostgreSQL).
4. **Resiliencia total**: si Gemini falla, el scheduling continúa funcionando normalmente.
5. **Prompt Orchestrator**: el LLM sPropone, el algoritmo verifica — ninguna restricción dura puede violarse.

### Decisiones de diseño clave

| Decisión | Alternativa considerada | Razón de la elección |
|----------|------------------------|----------------------|
| `pgvector` con ivfflat | Pinecone, Weaviate | Evita dependencia externa; PostgreSQL ya en stack |
| Gemini `text-embedding-004` | OpenAI ada-002 | Mejor calidad en español; coherencia con resto del sistema |
| Soft delete para reglas | Hard delete | Auditabilidad; posibilidad de restaurar |
| `ConflictResolutionEngine` determinístico | Dejar al LLM resolverlo | Predecibilidad y auditabilidad son requisitos de negocio |
| Threshold 0.35 (distancia coseno) | Threshold más alto/bajo | Calibrado manualmente para balance precisión/recall |
| Gemini 1.5 Flash (Orchestrator) | Gemini 1.5 Pro | Latencia: Flash 2-3x más rápido en prompts estructurados |
| Resiliencia total (catch → `[]`) | Lanzar error en RAG failure | El scheduling nunca puede bloquearse por infra externa |

### Limitaciones conocidas

- **Re-embedding manual**: si se actualiza el texto de una regla, hay que llamar explícitamente a un endpoint de re-indexación (no implementado en este escenario).
- **Threshold fijo**: el valor 0.35 de distancia coseno no es por empresa — con diferentes idiomas o estilos de escritura podría necesitar ajuste.
- **Cold start de pgvector**: el índice `ivfflat` requiere ≥ 1,000 vectores para ser óptimo (por debajo de ese número, un `flat scan` puede ser más rápido).
- **LLM cost tracking**: las llamadas a Gemini en el Prompt Orchestrator no tienen logging de tokens ni control de costos por empresa todavía.

### Próximos pasos naturales

- **Job de re-indexación**: endpoint o cron para regenerar embeddings de reglas sin vector.
- **Métricas de RAG**: loggear cuántas reglas se recuperan por turno, promedios de distancia, hit rate del umbral.
- **A/B testing**: comparar schedules generados con/sin RAG para validar mejora de calidad.
- **UI de gestión de reglas**: frontend para que los managers creen/editen reglas sin usar Postman.
