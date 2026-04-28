# Escenario 2 — Review Detallado
## AI Scheduling Orchestrator: Scheduling Engine + Strategy Pattern + Fairness Algorithm

> ⚠️ **FROZEN SNAPSHOT (Feb–Mar 2026).**
> El motor descrito aquí (3 estrategias: cost / fairness / hybrid) fue **reworkeado en Phase 13
> (Abr 2026)** y reemplazado por `WeekScheduleBuilder` (employee-first, LLM-authoritative
> con verify-loop + fallback determinístico). La tabla `shifts` (instancias diarias)
> está deprecada en favor de `shift_templates` + `shift_memberships` + `VirtualShiftSlot`
> on-demand. Consultá `docs/00_root_context.md` §4–§6 y `.agents/SCHEDULER-ENGINE.md`
> para la arquitectura vigente.

> **Proyecto:** AI Scheduling Orchestrator  
> **Fecha de implementación:** Febrero–Marzo 2026  
> **Stack:** NestJS · PostgreSQL · Supabase · Strategy Pattern · CQRS  
> **Autor principal:** Jean Newman  
> **Revisión técnica:** Antigravity (AI Agent)

---

## Tabla de contenidos

1. [Introducción](#1-introducción)
2. [Arquitectura del escenario](#2-arquitectura-del-escenario)
3. [Fase 1 — Value Objects del dominio](#3-fase-1--value-objects-del-dominio)
4. [Fase 2 — Aggregates extendidos](#4-fase-2--aggregates-extendidos)
5. [Fase 3 — Strategy Pattern (tres algoritmos)](#5-fase-3--strategy-pattern-tres-algoritmos)
6. [Fase 4 — Policies y servicios de dominio](#6-fase-4--policies-y-servicios-de-dominio)
7. [Fase 5 — Repository Ports](#7-fase-5--repository-ports)
8. [Fase 6 — CQRS: Commands y Queries](#8-fase-6--cqrs-commands-y-queries)
9. [Fase 7 — Infrastructure: Repositorios Supabase](#9-fase-7--infrastructure-repositorios-supabase)
10. [Fase 8 — Interface Layer (REST API)](#10-fase-8--interface-layer-rest-api)
11. [Fase 9 — Migración SQL](#11-fase-9--migración-sql)
12. [Tests unitarios — Explicación detallada](#12-tests-unitarios--explicación-detallada)
13. [Resultados de verificación](#13-resultados-de-verificación)
14. [Conclusiones](#14-conclusiones)

---

## 1. Introducción

El **Escenario 2** representa el **núcleo del sistema de planificación de horarios**. Si el Escenario 1 estableció la base de registro de empleados (identidad, skills, sesiones WhatsApp), el E2 responde a la pregunta central del negocio:

> *¿Cómo asigna el sistema automáticamente a cada empleado un turno de trabajo de forma justa, técnicamente válida y completamente auditable?*

La respuesta se construyó sobre tres pilares:

1. **Strategy Pattern** — tres algoritmos intercambiables de asignación (`cost`, `fairness`, `hybrid`), seleccionable en tiempo de ejecución sin modificar código
2. **Fairness Algorithm** — una fórmula determinística que cuantifica la carga de trabajo de cada empleado en una escala 0–1000, ponderando turnos nocturnos, fines de semana y cargas no deseables
3. **Skill Matrix Validation** — garantía de que cada empleado tiene el skill, nivel de experiencia y certificación vigente requeridos por el turno antes de asignarlo

### Modificaciones para Escalabilidad Industrial (V2)

El motor ha sido actualizado para soportar demandas variables:
- **Elastic Capacity (M:N)**: Los turnos ahora pueden tener capacidad indefinida (`required_employees = null`), permitiendo que el algoritmo llene el turno con tantos empleados como sea necesario para garantizar la cobertura equitativa.
- **Regla Anti-Clopening**: Validación estricta de **11 horas de descanso mínimo** entre turnos consecutivos para el mismo empleado.
- **Garantía de Feriados**: Integración con `ShiftCapacityPlannerService` para detectar feriados en lenguaje natural y limpiar asignaciones existentes mediante `deleteAssignmentsByWeek` si el día se marca con capacidad 0.


El escenario fue diseñado siguiendo **DDD estricto**: la lógica de negocio vive exclusivamente en el dominio, la persistencia es un detalle de infraestructura, y los comandos/queries siguen **CQRS**.

---

## 2. Arquitectura del escenario

```
POST /schedules/generate
         │
    ScheduleController
         │  GenerateScheduleCommand
    CommandBus (NestJS CQRS)
         │
    GenerateScheduleHandler
    ├─ employees    ← IEmployeeRepository
    ├─ shifts       ← IShiftRepository
    ├─ histories    ← IFairnessHistoryRepository
    │
    └─ ScheduleAggregate.generate()
              │
         SchedulingEngine
              │
         Strategy (injected)
         ├─ CostOptimizedStrategy
         ├─ FairnessOptimizedStrategy
         └─ HybridStrategy
                   │
              SkillValidationPolicy
              ConflictResolutionService
              FairnessThresholdGuard
                   │
              ShiftAssignment[]
         │
    GenerateScheduleHandler (continuación)
    ├─ saveAssignments() — paralelo
    ├─ upsertBatch() — actualiza fairness histories
    ├─ ScheduleQualityAnalyzer.analyze() — reporte de calidad
    └─ EventBus.publish(ScheduleGeneratedEvent)

GET /schedules?weekStart=YYYY-MM-DD
         │
    QueryBus → GetCompanyScheduleHandler → IShiftRepository
```

---

## 3. Fase 1 — Value Objects del dominio

Se crearon y extendieron los Value Objects que encapsulan las reglas de negocio más básicas. Los VOs son **inmutables** — no pueden modificarse una vez creados.

### Value Objects creados en E2

| VO | Rango/validación | Factories clave |
|----|-----------------|-----------------|
| `FairnessScore` | 0–1000 (extendido de 0–100 en E1) | `create(n)`, `add(a, b)`, `subtract(a, b)` con clamping |
| `DemandWeight` | 0–10 | `low()`, `medium()`, `high()`, `critical()`, `normalized()` |
| `UndesirableWeight` | 0–10 | `normal()`, `moderate()`, `heavy()`, `extreme()`, `isHeavy()` |
| `FairnessHistoryVO` | — | `computeRawScore()`, `addShift()` (inmutable) |
| `SkillSet` | — | Colección sin duplicados de `CompanySkill` |

**¿Por qué `FairnessScore` cambió a 0–1000?**
El score se acumula semanalmente mediante componentes multiplicados (turnos nocturnos ×1.5, fines de semana ×1.2, no-deseables ×2). El rango 0–100 era demasiado estrecho para acomodar estos valores sin pérdida de precisión.

**¿Por qué `DemandWeight` y `UndesirableWeight` tienen factories semánticos?**
`DemandWeight.critical()` es más expresivo en el código de dominio que `DemandWeight.create(10)`. La intención queda documentada en el código directamente.

---

## 4. Fase 2 — Aggregates extendidos

Los aggregates del E1 fueron extendidos con las propiedades necesarias para el scheduling.

### `Shift` Aggregate — extensión

| Propiedad añadida | Tipo | Propósito |
|-------------------|------|-----------|
| `requiredSkillId` | `string \| null` | Skill necesario para trabajar este turno |
| `requiredSkillLevel` | `'junior' \| 'intermediate' \| 'senior'` | Nivel mínimo requerido |
| `requiredExperienceMonths` | `number` | Experiencia mínima en meses |
| `demandScore: DemandWeight` | VO | Criticidad de cubrir el turno |
| `undesirableWeight: UndesirableWeight` | VO | Qué tan no-deseable es para los empleados |

**Métodos añadidos:**

| Método | Retorno | Descripción |
|--------|---------|-------------|
| `getDuration()` | `number (horas)` | `(endTime - startTime) / 3_600_000` |
| `overlapsWith(other)` | `boolean` | Detecta solapamientos — previene dobles asignaciones |
| `isNightShift()` | `boolean` | `startHour >= 22 \|\| endHour <= 6` |
| `isWeekendShift()` | `boolean` | `day === 0 \|\| day === 6` |
| `fromPersistence()` | `Shift` | Factory de reconstrucción desde DB — sin eventos |

### `CompanySkill` Aggregate — extensión

| Propiedad añadida | Tipo | Propósito |
|-------------------|------|-----------|
| `level` | `'junior' \| 'intermediate' \| 'senior'` | Nivel del skill |
| `requiredExperienceMonths` | `number` | Meses mínimos para el skill |
| `certificationExpiration` | `Date \| null` | Fecha límite de la certificación |

**Método añadido:** `isValidOn(date: Date): boolean` — verifica si la certificación estaba vigente en una fecha específica.

### Nuevos aggregates

**`ShiftAssignment`** — registra una asignación individual:
- `shiftId`, `employeeId`, `companyId`
- `fairnessSnapshot: Record<string, number>` — score de cada empleado en el momento de asignar (auditoría)
- `assignedByStrategy: string` — qué algoritmo tomó la decisión

**`ScheduleAggregate`** — root aggregate que protege las invariantes del horario completo:
- No puede haber solapamientos horarios para un mismo empleado
- Los skills deben cumplirse
- Único punto de creación de `ShiftAssignment`

---

## 5. Fase 3 — Strategy Pattern (tres algoritmos)

La pieza central del Escenario 2. Los tres algoritmos implementan la misma interfaz `SchedulingStrategy`:

```typescript
interface SchedulingStrategy {
    generate(
        employees: Employee[],
        shifts: Shift[],
        histories: Map<string, FairnessHistoryVO>,
        availableSkills: CompanySkill[],
        options?: { semanticRules?: SemanticConstraint[] }, // E3 hook
    ): { assignments: ShiftAssignment[]; unfilledShifts: Shift[] };
}
```

### 🟦 CostOptimizedStrategy

**Objetivo:** Minimizar el costo salarial de la empresa.

**Algoritmo paso a paso:**

1. Ordena los turnos por `demandScore DESC` (cubre los más críticos primero)
2. Para cada turno, busca el candidato de **menor costo** (junior < intermediate < senior)
3. Si el empleado tiene `FairnessScore > 600`, aplica una penalización del **+20%** al costo efectivo para desincentivar su asignación
4. Verifica disponibilidad (sin solapamientos) y skill mediante `SkillValidationPolicy`

**Cuándo usarlo:** Empresas que priorizan el control de costos sobre la equidad de la distribución.

**Tradeoff:** Puede asignar repetidamente a los empleados más baratos, aumentando su carga. La penalización del 20% solo mitiga — no elimina — esta tendencia.

### 🟩 FairnessOptimizedStrategy

**Objetivo:** Distribuir la carga de trabajo lo más equitativamente posible.

**Algoritmo paso a paso:**

1. Ordena los turnos por peso compuesto `(undesirableWeight × 2 + demandScore)` de **mayor a menor** — los turnos más duros se asignan primero para evitar que siempre vayan al mismo empleado
2. Para cada turno, asigna al empleado con el **menor FairnessScore acumulado** hasta ese momento
3. Mantiene un `liveHistory` **en memoria** que se actualiza tras cada asignación, permitiendo decisiones en tiempo real (el score de una asignación influye en la siguiente)
4. El `FairnessThresholdGuard` puede bloquear asignaciones si el score del candidato ya supera el umbral configurado

**Cuándo usarlo:** Empresas que priorizan el bienestar del empleado y la equidad laboral ante el costo.

**Por qué el `liveHistory` es crucial:** Sin él, el algoritmo podría asignar al mismo empleado múltiples turnos en la misma sesión de scheduling porque el score en DB todavía no refleja los turnos ya asignados en esta ejecución.

### 🟨 HybridStrategy

**Objetivo:** Balance configurable entre costo, fairness y demanda.

**Fórmula de scoring compuesto:**

```
score = (costNorm   × costWeight)
      + (fairnessNorm × fairnessWeight)
      + (demandNorm  × demandWeight)

# Pesos por defecto:
costWeight    = 0.3
fairnessWeight = 0.5    ← fairness pesa más por defecto
demandWeight  = 0.2
```

Los pesos son **configurables por request** vía el body del comando. El candidato con **menor score compuesto** gana la asignación.

**Cuándo usarlo:** La mayoría de empresas — el default recomendado. Permite que cada empresa calibre su balance sin cambiar código.

---

## 6. Fase 4 — Policies y servicios de dominio

### `SkillValidationPolicy` — dos responsabilidades

| Método | Cuándo se llama | Qué verifica |
|--------|----------------|-------------|
| `validateEmployee(employee, skill)` | Al asignar un skill a un empleado | Que el skill pertenece a la misma empresa |
| `canWork(employee, shift, skills, date)` | Durante scheduling | Skill requerido ✔ · Certificación vigente ✔ · Experiencia mínima ✔ |

### `FairnessCalculator`

Convierte el historial semanal en un score normalizado 0–1000:

```
rawScore = (undesirableCount × 2.0)
         + (nightShiftCount  × 1.5)
         + (weekendCount     × 1.2)
         - (voluntaryExtraShifts × 0.5)   ← los voluntarios reducen el score

normalized = round((rawScore / THEORETICAL_MAX) × 1000)
```

`THEORETICAL_MAX = 40` — representa al empleado hipotético que trabaja solo turnos no-deseables toda la semana. Sirve de referencia para normalizar.

**También calcula varianza** entre todos los empleados — indicador de qué tan desigual es la distribución actual del equipo.

### `FairnessThresholdGuard`

Protege contra sobrecargas extremas. Si el score de un empleado supera el `maxFairnessDeviation` configurado (default `700` de `1000`), sus asignaciones se bloquean para esa semana.

```typescript
// El threshold es configurable por empresa
const guard = new FairnessThresholdGuard(maxDeviation: 700);
guard.canAssign(employee, currentScore); // false si score > 700
```

### `ConflictResolutionService`

Aplica una jerarquía de validaciones antes de confirmar cualquier asignación:

| Nivel | Validación | Razón |
|-------|-----------|-------|
| 1 | **Legal** — máx 40h semanales, mín 11h descanso entre turnos | EU Working Time Directive |
| 2 | **Skill** — `canWork()` de `SkillValidationPolicy` | Compliance y seguridad laboral |
| 3 | **Fairness** — `FairnessThresholdGuard` | Protección del empleado |
| 4 | **Preferencia** — disponibilidad declarada | Placeholder para E4 |

### `SchedulingEngine`

Orquestador principal. Recibe la estrategia como dependencia inyectada (no la instancia directamente) y delega completamente en ella. Su única responsabilidad es el flow-control, no el algoritmo.

### `ScheduleQualityAnalyzer`

Genera un reporte JSON de auditoría post-generación:

```typescript
interface QualityReport {
    fairnessVariance: number;      // dispersión del score entre empleados
    skillViolations: number;       // asignaciones que violaron skills (debería ser 0)
    demandCoveragePercent: number; // % de turnos cubiertos
    unfilledShiftsCount: number;   // turnos que quedaron sin asignar
    strategyUsed: string;          // 'cost' | 'fairness' | 'hybrid'
    generatedAt: string;           // ISO timestamp
}
```

Permite comparar dos schedules con `compare()` y evaluar si es aceptable con `isAcceptable()`.

---

## 7. Fase 5 — Repository Ports

Se definieron los contratos de persistencia como interfaces de TypeScript (Principio de Inversión de Dependencias). El dominio define **qué** necesita; la infraestructura decide **cómo** lo hace.

### `IShiftRepository`

| Método | Propósito |
|--------|-----------|
| `save(shift)` | Persiste un nuevo turno |
| `findByCompanyAndWeek(companyId, weekStart)` | Carga los turnos de la semana a generar |
| `saveAssignment(assignment)` | Persiste una asignación individual |
| `findAssignmentsByEmployee(empId, compId, from?, to?)` | Calendario personal del empleado |
| `findAssignmentsByCompanyAndWeek(compId, weekStart)` | Schedule completo de la empresa |

### `IFairnessHistoryRepository`

| Método | Propósito |
|--------|-----------|
| `findByWeek(companyId, weekStart)` | Carga todos los historiales para el algoritmo en una query |
| `upsert(history)` | Actualiza o crea el historial de un empleado |
| `upsertBatch(histories)` | **Actualización masiva en una sola query** — ON CONFLICT DO UPDATE |

**Por qué `upsertBatch` es crítico:** Sin él, persistir el historial tras un scheduling con 50 empleados requeriría 50 queries. Con `upsertBatch`, son 1 query con multi-values.

---

## 8. Fase 6 — CQRS: Commands y Queries

### `GenerateScheduleCommand` → `GenerateScheduleHandler`

El handler orquesta todo el flujo de generación en 7 pasos:

```
1. Promise.all([employees, shifts, histories]) — carga paralela
2. Instancia la estrategia según strategyType del comando
3. ScheduleAggregate.generate() — delega en la estrategia
4. Valida invariantes post-generación (sin solapamientos, sin violaciones de skill)
5. Promise.all([...saveAssignment()]) — persiste asignaciones en paralelo
6. upsertBatch(histories) — actualiza fairness de todos los empleados afectados
7. EventBus.publish(ScheduleGeneratedEvent)
```

**Por qué la carga paralela en el paso 1:** employees, shifts y histories son datos independientes. Cargarlos en `Promise.all` los obtiene simultáneamente en lugar de secuencialmente, reduciendo la latencia del endpoint a la latencia del query más lento (no a la suma de todos).

### `GetCompanyScheduleQuery` → `GetCompanyScheduleHandler`

Read side puro — delega directamente en `IShiftRepository.findAssignmentsByCompanyAndWeek()` sin lógica de dominio. La separación de Commands y Queries permite que el read path evite toda la sobrecarga del domain layer.

### `GetEmployeeCalendarQuery` → `GetEmployeeCalendarHandler`

Conectado al repositorio real en E2 (antes era un stub `[]` en E1). Filtra asignaciones por rango de fechas opcional.

---

## 9. Fase 7 — Infrastructure: Repositorios Supabase

### `SupabaseShiftRepository`

- Mapea `Shift` aggregate ↔ tabla `shifts` y `ShiftAssignment` ↔ tabla `shift_assignments`
- Reconstruye VOs (`DemandWeight`, `UndesirableWeight`) al leer desde DB usando `fromPersistence()`
- Filtra por `company_id` en **todas** las queries — multi-tenancy garantizado
- `toDomain()` usa `Shift.fromPersistence()` — no dispara eventos de dominio en lecturas

### `SupabaseFairnessHistoryRepository`

- `upsertBatch` usa `ON CONFLICT (employee_id, week_start) DO UPDATE SET ...` — una sola query vs N queries
- `toDomain()` reconstruye `FairnessHistoryVO` desde la fila de DB con todos sus contadores

---

## 10. Fase 8 — Interface Layer (REST API)

### `ScheduleController`

| Endpoint | Propósito |
|----------|-----------|
| `POST /schedules/generate` | Genera el schedule semanal con la estrategia solicitada |
| `GET /schedules?weekStart=YYYY-MM-DD` | Devuelve todas las asignaciones de la empresa para la semana |

### `GenerateScheduleDto`

```typescript
class GenerateScheduleDto {
    @IsDateString()
    weekStart: string;           // Lunes de la semana (ISO 8601)

    @IsEnum(['cost', 'fairness', 'hybrid'])
    strategy: string;            // Algoritmo a usar

    @IsOptional() @IsNumber() @Min(0) @Max(1000)
    maxFairnessDeviation?: number; // Default 700; umbral de bloqueo por equidad

    @IsOptional() @IsNumber() @Min(0) @Max(1)
    costWeight?: number;         // Solo para strategy 'hybrid'

    @IsOptional() @IsNumber() @Min(0) @Max(1)
    fairnessWeight?: number;     // Solo para strategy 'hybrid'
}
```

### Ejemplo de uso

```bash
# Schedule con estrategia híbrida personalizada
curl -X POST "http://localhost:3000/schedules/generate?companyId=uuid" \
  -H "Content-Type: application/json" \
  -H "X-Company-Id: uuid" \
  -d '{
    "weekStart": "2026-03-09",
    "strategy": "hybrid",
    "maxFairnessDeviation": 600,
    "costWeight": 0.2,
    "fairnessWeight": 0.6
  }'
```

---

## 11. Fase 9 — Migración SQL

**Archivo:** `supabase/migrations/20240302000000_scenario2_scheduling_engine.sql`

### Columnas añadidas a tablas existentes

| Tabla | Columna nueva | Tipo | Propósito |
|-------|--------------|------|-----------|
| `shifts` | `required_skill_level` | TEXT | Nivel mínimo junior/intermediate/senior |
| `shifts` | `required_experience_months` | INT | Meses de experiencia mínima |
| `shift_assignments` | `id` | UUID PK | ID propio para referencias directas |
| `shift_assignments` | `company_id` | UUID | RLS eficiente sin JOIN a shifts |
| `shift_assignments` | `assigned_by_strategy` | TEXT | Trazabilidad del algoritmo |
| `fairness_history` | `hours_worked` | FLOAT | Horas trabajadas en la semana |
| `fairness_history` | `night_shift_count` | INT | Turnos nocturnos acumulados |
| `fairness_history` | `weekend_count` | INT | Turnos de fin de semana |
| `fairness_history` | `voluntary_extra_shifts` | INT | Turnos voluntarios (reducen fairness score) |

### Índices creados

| Índice | Tabla | Columnas | Por qué |
|--------|-------|----------|---------|
| `shifts_company_start_time_idx` | `shifts` | `(company_id, start_time)` | Filtra por empresa + semana eficientemente |
| `fairness_history_company_week_idx` | `fairness_history` | `(company_id, week_start)` | Carga masiva de historiales en un solo scan |
| `shift_assignments_employee_idx` | `shift_assignments` | `(employee_id, company_id)` | Calendario del empleado sin full scan |

---

## 12. Tests unitarios — Explicación detallada

### Suite: `fairness-score.spec.ts` (12 tests)

Verifica el Value Object `FairnessScore` con su nuevo rango extendido 0–1000.

| Test | Input | Resultado | Por qué este test existe |
|------|-------|-----------|-------------------------|
| `create(0)` | 0 | value = 0 | Borde inferior permitido |
| `create(1000)` | 1000 | value = 1000 | Borde superior permitido |
| `create(500)` | 500 | value = 500 | Valor nominal central |
| `create(75.5)` | 75.5 | value = 75.5 | Acepta decimales — necesario para fórmula |
| `create(-1)` | -1 | ❌ throws | Score negativo no tiene semántica |
| `create(1001)` | 1001 | ❌ throws | Fuera de escala definida |
| `create(-9999)` | -9999 | ❌ throws | Negativos extremos |
| `create(9999)` | 9999 | ❌ throws | Positivos extremos |
| `add(100, 200)` | — | 300 | Suma dentro del rango |
| `add(900, 200)` | — | 1000 | **Clamping al máximo** — no puede superar 1000 |
| `subtract(500, 100)` | — | 400 | Resta dentro del rango |
| `subtract(50, 100)` | — | 0 | **Clamping al mínimo** — no puede ser negativo |

**Por qué el clamping es esencial:** Las estrategias suman y restan scores frecuentemente. Sin clamping, un bug podría generar un score inválido que rompería la invariante del VO silenciosamente.

---

### Suite: `shift.spec.ts` (9 tests)

Verifica el aggregate `Shift` con su firma extendida. Todos usan `Shift.fromPersistence()` — el constructor es privado.

| Grupo | Test | Resultado esperado |
|-------|------|-------------------|
| `getDuration()` | Turno de 8h (08:00–16:00) | `8.0` |
| `getDuration()` | `startTime >= endTime` | ❌ throws — invariante de dominio |
| `getDuration()` | Turno de 4.5h | `4.5` — manejo correcto de minutos |
| `getDuration()` | Turno de 12h | `12.0` — turno largo válido |
| `overlapsWith()` | `[08-16]` vs `[12-20]` | `true` — solapamiento parcial |
| `overlapsWith()` | `[08-20]` contiene `[10-14]` | `true` — solapamiento total |
| `overlapsWith()` | `[08-16]` vs `[16-24]` | `false` — **consecutivos NO solapan** (borde exclusivo) |
| `overlapsWith()` | `[08-12]` vs `[14-18]` | `false` — separados |
| `isNightShift()` | Turno 22:00–06:00 | `true` |
| `isNightShift()` | Turno 08:00–16:00 | `false` |

**Por qué el test de `endTime >= startTime`:** Una asignación con duración 0h daría un score de fairness de 0 aunque el empleado "aparentemente" trabajó. Documentar que es una violación de invariante previene futuros bugs de datos.

---

### Suite: `skill-validation-policy.spec.ts` (4 tests — extensión E2)

Verifica el método `validateEmployee()` — nueva responsabilidad del E2 que evita asignar skills de otras empresas.

| Test | Scenario | Resultado |
|------|----------|-----------|
| Misma empresa | Employee y skill pertenecen a `company-A` | ✅ no throws |
| Empresa diferente | Employee en `company-A`, skill en `company-B` | ❌ throws con mensaje descriptivo |
| Mismo skill ID, empresa diferente | ID colisión cross-tenant | ❌ throws — el ID solo no es suficiente |
| Misma empresa, distinto nombre de skill | `companyId` coincide | ✅ no throws — el nombre no es relevante |

**La separación `validateEmployee()` / `canWork()`:** estos son momentos distintos del ciclo de vida. `validateEmployee` ocurre cuando un manager asigna un skill a un empleado (una vez). `canWork` ocurre en cada ejecución del scheduling (frecuente). Separar responsabilidades permite testear cada una independientemente.

---

### Suite: `fairness-policy.spec.ts` (6 tests)

Verifica `FairnessPolicy.isAssignmentFair()` — política de límite de horas semanales.

| Test | Horas acumuladas | Turno propuesto | Límite | Resultado |
|------|-----------------|----------------|--------|-----------|
| Primer turno de la semana | 0h | +8h | 40h | ✅ `true` — 8 ≤ 40 |
| Al límite exacto | 32h | +8h | 40h | ✅ `true` — 40 ≤ 40 (operador `<=` inclusivo) |
| Un turno sobre el límite | 36h | +8h | 40h | ❌ `false` — 44 > 40 |
| Turno solo excede el límite | 0h | +48h | 40h | ❌ `false` — el turno en sí es más largo que el límite |
| Contrato extendido (límite 48h) | 24h | +8h | 48h | ✅ `true` — el límite es configurable |
| Boundary exacto multi-turno | 35h + 4h + 1h | +0h | 40h | ✅ `true` — 40 ≤ 40 |

---

### Suite: `get-employee-calendar.handler.spec.ts` (2 tests)

| Test | Qué verifica | Por qué es especialmente valioso |
|------|-------------|----------------------------------|
| Llamada con fechas → array desde repo | El handler llama a `findAssignmentsByEmployee` con los parámetros correctos | Documenta el **cambio de comportamiento** del E1 (stub `[]`) al E2 (conexión real) |
| Multi-tenant isolation | `companyId` siempre se pasa al repositorio | El tenant no puede "perderse" en el camino |

---

### Tests del Escenario 1 actualizados para compatibilidad de E2

El E2 introdujo constructores privados en varios aggregates. Los tests del E1 fueron actualizados para usar los factories correctos:

| Test suite | Cambio | Razón |
|-----------|--------|-------|
| `employee.spec.ts` | `new CompanySkill()` → `CompanySkill.create({...})` | Constructor privatizado en E2 |
| `company.spec.ts` | `new CompanySkill()` → `CompanySkill.create({...})` | Idem |
| `fairness-policy.spec.ts` | `new Shift()` → `Shift.fromPersistence({...})` | Constructor privatizado en E2 |
| `register-employee.handler.spec.ts` | Añadido `findAllByCompany: jest.fn()` al mock | Nuevo método en la interfaz `IEmployeeRepository` |

---

## 13. Resultados de verificación

┌─────────────────────────────────────────────┐
│  Escenario 2 — Resultados Finales           │
│                                             │
│  TypeScript (tsc)   →    0 errores ✅      │
│  Test Suites        →   45 / 45   ✅      │
│  Tests totales      →  366 / 366  ✅      │
│  Migración SQL      →  Aplicada   ✅      │
│  POST /schedules/generate →   ✅          │
│  GET  /schedules          →   ✅          │
└─────────────────────────────────────────────┘

### Distribución de tests por área

| Área | Tests |
|------|-------|
| Value Objects (FairnessScore + Shift VOs) | 22 |
| Aggregates extendidos (Shift, CompanySkill) | 14 |
| Policies (SkillValidation, Fairness) | 10 |
| Handlers CQRS nuevos | 8 |
| Tests E1 actualizados para compatibilidad | 12 |
| Demás suites acumuladas | 295 |
| **Total Global** | **366** |


---

## 13.5. Garantía de Respeto a Feriados y Elastic Capacity

Se ha implementado una capa de seguridad crítica en el motor de scheduling para garantizar el cumplimiento de días feriados y cierres:

1. **Limpieza Determinística (`deleteAssignmentsByWeek`):** Antes de iniciar cualquier generación híbrida (LLM + Algoritmo), el sistema ejecuta una limpieza total de las asignaciones existentes para la semana solicitada. Esto asegura que si la capacidad de un turno cambió a 0 (ej. por un feriado recién declarado), no queden asignaciones residuales de ejecuciones previas.
2. **Entendimiento de Fechas Humanas:** El `ShiftCapacityPlannerService` ahora reconoce formatos de fecha naturales como "16 de abril" o "día 16", permitiendo que las reglas semánticas de feriados se mapeen correctamente a la capacidad 0.
3. **Persistencia de Omisiones Intencionales:** Al borrar primero, garantizamos que si el LLM decide NO asignar a nadie a un turno (respetando la capacidad 0), el sistema no intente "rellenarlo" erróneamente con datos antiguos.

---


## 14. Conclusiones

### Qué se logró

El Escenario 2 implementa un motor de scheduling **completamente funcional, auditable y multi-estrategia**. A diferencia de la mayoría de sistemas de scheduling que usan algoritmos opacos, cada decisión puede rastrearse hasta:

- El **algoritmo** que la tomó (`strategyUsed` en `ShiftAssignment`)
- El **score de fairness** del empleado en ese momento (`fairnessSnapshot`)
- Las **validaciones** que pasaron (`SkillValidationPolicy`, `ConflictResolutionService`)
- La **calidad del schedule** completo (`ScheduleQualityAnalyzer`)

### Decisiones de diseño clave

| Decisión | Alternativa considerada | Razón de la elección |
|----------|------------------------|----------------------|
| `liveHistory` en memoria dentro de la estrategia | Recargar DB tras cada asignación | Sin liveHistory, el mismo empleado obtiene múltiples turnos en la misma sesión |
| `upsertBatch` con `ON CONFLICT DO UPDATE` | N queries individuales | 1 query vs N — crítico para empresas con muchos empleados |
| `validateEmployee()` separado de `canWork()` | Un solo método con todos los checks | SRP — momentos distintos del ciclo de vida del dato |
| `maxFairnessDeviation` configurable (default 700) | Umbral hardcodeado | Cada empresa calibra su tolerancia a la desigualdad |
| `fairnessSnapshot` en `ShiftAssignment` | No guardar historial de scores | Auditoría: se puede reconstruir por qué se tomó cada decisión |
| `Promise.all` para carga de datos en el handler | Carga secuencial | Paralelismo: tiempo total = max(T1, T2, T3) en vez de T1+T2+T3 |

### Próximos pasos — Escenario 3: RAG Integration

El contrato `SemanticConstraint` ya está definido en la interfaz de estrategias como hook para E3:

```typescript
interface SemanticConstraint {
    rule: string;       // texto de la regla en lenguaje natural
    weight: number;     // 1=preferencia, 2=semántica, 3=legal
    employeeId?: string;
    shiftId?: string;
}
```

El Escenario 3 conecta este contrato con embeddings de `text-embedding-004` de Gemini y búsquedas vectoriales en `pgvector`, permitiendo que managers escriban reglas en lenguaje natural como *"Los viernes por la noche siempre necesitamos a alguien con certificación de primeros auxilios"*.

---

## 15. Actualización Reciente: Enterprise SaaS Architecture (V2)

El motor de scheduling fue refactorizado para soportar jerarquías organizacionales reales y turnos parciales:

1. **Nuevo Modelo de Datos Jerárquico:** Introducidas las entidades `Branch` (Sucursales con zona horaria propia), `Department` y `ShiftTemplate`. Los agregados de `Employee` ahora pertenecen a un departamento específico.
2. **Turnos Parciales (Partial Shift Coverage):** El `ShiftAssignment` fue modificado para rastrear `actual_start_time` y `actual_end_time`. Esto permite que un empleado cubra solo una fracción del bloque de tiempo definido por un `ShiftInstance`.
3. **Validación Duck-Typed:** Las estrategias de programación y el `ScheduleValidatorService` fueron reescritos para utilizar comprobaciones de "duck typing" mediante bounding boxes. Al no depender de hidratar el objeto `Shift` completo de memoria, el algoritmo detecta exactamente las intersecciones precisas en fracciones de turnos sin penalizar la performance.
4. **Protección Anti-Clopening (11h gap):** Se introdujo una regla inquebrantable de separación legal mínima de 11 horas de descanso entre turnos consecutivos evaluados matemáticamente sin fallos.

---

## 16. Delta — Sprint 2026-04 (Engine + Policies)

El motor mismo no cambió en este sprint, pero se cerraron y abrieron piezas a su alrededor.

**Recap de sprints previos (cerrado):**
- **E2 reworkeado a `WeekScheduleBuilder` único** (sin Strategy Pattern): el LLM activo (Qwen `qwen3.6-plus` por defecto, Gemini 2.0 Flash, o `LocalLLMService` vía LM Studio/Ollama según `ACTIVE_AI_PROVIDER`) propone líneas semanales por empleado y el builder verifica/repara con heurística determinista como fallback.
- **Verify-loop sobre la propuesta del LLM**: si la propuesta viola hard constraints, se reintenta; si tras N reintentos no converge, cae al builder determinista.
- **Jerarquía V3** (`ShiftTemplate` + `ShiftMembership` + `VirtualShiftSlot` + `ShiftAssignment`) con invariante "11h descanso entre turnos" hardcodeado y testeado.
- **Fairness 0–1000 post-hoc** (no es restricción del solver): 0.6 balance, 0.4 satisfacción de preferencias.
- **Skill assignment a templates** (`feat(scheduling): asignación de skill a template (create + edit)`) — el solver consume templates con skill requerido alineado al tipo `Employee.skills`.

**Nuevo en este sprint (preparación para Phase 14):**
- **Subsistema CompanyPolicies** completo (open + interpreter accelerators, multi-tenant). Aggregate `CompanyPolicy`, repositorio, `PolicyInterpreterRegistry`, `PolicyEnforcementService`, `CompanyPolicyCreator` con suggestion-loop. Dos interpreters listos: `min_rest_days_per_week`, `min_rest_hours_between_shifts`. Tests en `test/unit/domain/services/policy-enforcement.service.spec.ts`.
- **Suggestion-loop pattern reutilizado** desde HTTP (`CompanyPoliciesController`) y WhatsApp (`MessageRouter` con `whatsapp_pending_clarifications`). Permiso configurable vía `companies.whatsapp_policy_creator_roles TEXT[]` (default `['manager']`).
- **Fairness sigue post-hoc**, sin cambios.

**Phase 14 — Policy-aware scheduling (planeado, no implementado todavía):**
- inyectar `policyEnforcement.formatForPrompt(companyId)` en el prompt del LLM antes de `WeekScheduleBuilder`.
- correr `policyEnforcement.evaluate(companyId, { shifts })` después de cada propuesta como hard-gate (reusa el verify-loop existente).
- soft violations se adjuntan al schedule para revisión del manager; las LLM-only quedan en el prompt.
- Detalle de integración en `.agents/SCHEDULER-ENGINE.md` ("PHASE 14").

**Por qué importa para E2**: el motor pasa de "respetar reglas hardcodeadas + reglas semánticas individuales" a "respetar reglas hardcodeadas + reglas semánticas individuales + políticas a nivel empresa con interpreters deterministas opcionales". Sin cambiar el contrato del builder.
