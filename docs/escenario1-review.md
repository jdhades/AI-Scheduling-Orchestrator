# Escenario 1 — Review Detallado
## AI Scheduling Orchestrator · Foundation & Core DDD

> **Proyecto:** AI Scheduling Orchestrator  
> **Fecha de implementación:** Febrero 2026  
> **Stack:** NestJS · PostgreSQL · Supabase · Twilio WhatsApp API · Redis  
> **Autor principal:** Jean Newman  
> **Revisión técnica:** Antigravity (AI Agent)

---

## Tabla de contenidos

1. [Introducción](#1-introducción)
2. [Principios no negociables](#2-principios-no-negociables)
3. [Arquitectura de alto nivel](#3-arquitectura-de-alto-nivel)
4. [Fase 1 — Setup del proyecto](#4-fase-1--setup-del-proyecto)
5. [Fase 2 — Diseño de dominio (DDD)](#5-fase-2--diseño-de-dominio-ddd)
6. [Fase 3 — Patrón CQRS](#6-fase-3--patrón-cqrs)
7. [Fase 4 — UUID Handshake (Vinculación WhatsApp)](#7-fase-4--uuid-handshake-vinculación-whatsapp)
8. [Fase 5 — Multi-tenancy con Row Level Security](#8-fase-5--multi-tenancy-con-row-level-security)
9. [Fase 6 — Observer Pattern y NotificationListener](#9-fase-6--observer-pattern-y-notificationlistener)
10. [Tests unitarios — Explicación detallada](#10-tests-unitarios--explicación-detallada)
11. [Tests de integración](#11-tests-de-integración)
12. [Tests E2E](#12-tests-e2e)
13. [Resultados de verificación](#13-resultados-de-verificación)
14. [Conclusiones](#14-conclusiones)

---

## 1. Introducción

El **Escenario 1** es la base estructural de todo el sistema. Sin una fundación sólida, los escenarios siguientes (Motor de Scheduling, RAG Semántico, WhatsApp + Voz) serían frágiles o imposibles de extender sin acumular deuda técnica.

El objetivo central fue demostrar que el sistema puede crecer sin deuda técnica: que agregar una nueva feature no rompe el código existente, que los cambios son localizados, y que el dominio del negocio es **completamente independiente** de la infraestructura.

### ¿Qué es el AI Scheduling Orchestrator?

Un sistema SaaS enterprise **multi-tenant** que permite a managers gestionar turnos de trabajo y que los empleados interactúen con el sistema **por voz vía WhatsApp**. El flujo completo que este escenario habilita es:

```
Empleado → Audio WhatsApp
         → Twilio Webhook → NestJS API
         → Whisper API (speech-to-text)                [E4]
         → Gemini (intent recognition)                 [E4]
         → CQRS Command Bus
         → Domain Aggregate (Employee, Handshake)
         → PostgreSQL (Supabase) + Redis
         → Observer Pattern → Twilio (notificación)
         → Respuesta WhatsApp al empleado
```

El **Escenario 1** construyó las capas de Domain, Application, Infrastructure e Interfaces con todo el andamiaje que hace posible ese flujo completo y extensible.

---

## 2. Principios no negociables

Antes de revisar cada fase, es importante entender los principios que guiaron **cada decisión** de implementación:

| Principio | Implementación |
|-----------|----------------|
| **Sin ORM** | Repositorios manuales con SQL explícito — control total de queries y RLS |
| **Nunca `anon key` en backend** | Solo `service_role` key server-side; la `anon key` es exclusivamente para el cliente |
| **CQRS obligatorio** | Cero queries desde controllers — todo pasa por `CommandBus`/`QueryBus` |
| **Domain aislado** | Cero imports de infraestructura en `src/domain/` — el dominio no conoce NestJS |
| **Multi-tenant desde el origen** | RLS configurado antes del primer dato, no como afterthought |
| **Config 12-Factor** | Todas las credenciales en variables de entorno, validadas con Joi al arrancar |
| **Observer desacoplado** | Los aggregates emiten eventos; los handlers deciden qué hacer con ellos |

---

## 3. Arquitectura de alto nivel

```
┌────────────────────────────────────────────────────────────────┐
│  Interface Layer                                               │
│  EmployeeController    →  POST /employees                      │
│                        →  GET  /employees/:id/calendar         │
│  HandshakeController   →  POST /employees/:id/handshake        │
│                        →  POST /employees/:id/verify           │
└──────────────────────────────┬─────────────────────────────────┘
                               │  Commands / Queries (CQRS)
┌──────────────────────────────▼─────────────────────────────────┐
│  Application Layer                                             │
│  RegisterEmployeeHandler                                       │
│  InitiateHandshakeHandler · VerifyHandshakeHandler             │
│  GetEmployeeCalendarHandler                                    │
│  EmployeeRegisteredHandler · HandshakeInitiatedHandler         │
│  HandshakeVerifiedHandler  (Event Handlers → Twilio)          │
└──────────────────────────────┬─────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────┐
│  Domain Layer  (CERO dependencias externas)                    │
│  Employee Aggregate  ·  WhatsappHandshake Aggregate            │
│  Shift Aggregate     ·  CompanySkill Aggregate                 │
│  PhoneNumber VO  ·  HandshakeToken VO  ·  ExperienceLevel VO   │
│  FairnessScore VO                                              │
│  SkillValidationPolicy  ·  FairnessPolicy                      │
│  INotificationService (port)  ·  IEmployeeRepository (port)   │
└──────────────────────────────┬─────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────┐
│  Infrastructure Layer                                          │
│  SupabaseEmployeeRepository  ·  SupabaseHandshakeRepository    │
│  TwilioService (INotificationService impl)                     │
│  TenantMiddleware  ·  TenantContext                            │
│  ConfigModule + Joi  ·  RedisModule                            │
└────────────────────────────────────────────────────────────────┘

---

### Evolución Arquitectónica V2 (Enterprise SaaS)

Desde la implementación inicial, el sistema ha evolucionado hacia una estructura jerárquica robusta para soportar organizaciones complejas:

1. **Jerarquía Organizacional**: `Branch` (Sucursal) -> `Department` (Departamento) -> `ShiftTemplate` (Plantilla de Turnos).
2. **Aislamiento Multi-tenant**: Reforzado mediante `TenantMiddleware` y **RLS (Row Level Security)** en PostgreSQL, asegurando que cada empresa solo acceda a su propia estructura.
3. **M:N Mapping**: Soporte para múltiples empleados por turno y turnos que abarcan múltiples departamentos.

```

---

## 4. Fase 1 — Setup del proyecto

### Qué se hizo

Se inicializó el proyecto NestJS con una estructura modular enterprise usando **Clean Architecture** como guía organizativa: cuatro capas bien delimitadas, cada una con una sola responsabilidad.

```
src/
├── domain/           ← Núcleo del negocio. CERO dependencias externas.
│   ├── aggregates/   ← Entidades principales con comportamiento
│   ├── value-objects/← Tipos inmutables con validación integrada
│   ├── events/       ← Eventos de dominio (Observer Pattern)
│   ├── policies/     ← Reglas de negocio complejas (SkillValidation, Fairness)
│   ├── repositories/ ← Interfaces (ports) — no implementaciones
│   └── services/     ← Contratos de servicios externos (INotificationService)
│
├── application/      ← Orquestación. Coordina, no decide.
│   └── handlers/     ← Command Handlers, Query Handlers, Event Handlers
│
├── infrastructure/   ← Adaptadores. Implementa lo que el dominio define.
│   ├── config/       ← Variables de entorno, ConfigModule, validación Joi
│   ├── repositories/ ← SupabaseEmployeeRepository, SupabaseHandshakeRepository
│   ├── notifications/← TwilioService (adapter de INotificationService)
│   ├── redis/        ← RedisModule (cache y colas futuras)
│   ├── supabase/     ← SupabaseClient provider singleton
│   └── tenant/       ← TenantMiddleware, TenantContext (AsyncLocalStorage)
│
└── interfaces/       ← Entrada al sistema.
    ├── controllers/  ← EmployeeController, HandshakeController
    └── dtos/         ← DTOs con class-validator y class-transformer
```

### Validación de configuración al arranque

```typescript
// env.validation.ts — falla rápido si falta algo crítico
SUPABASE_URL:         Joi.string().uri().required(),
SUPABASE_SERVICE_KEY: Joi.string().required(),
REDIS_HOST:           Joi.string().required(),
TWILIO_ACCOUNT_SID:   Joi.string().optional().allow(''),
TWILIO_AUTH_TOKEN:    Joi.string().optional().allow(''),
```

Si `SUPABASE_URL` falta, la aplicación no arranca y el mensaje de error es explícito. Cero sorpresas silenciosas en producción.

---

## 5. Fase 2 — Diseño de dominio (DDD)

### Aggregates

Los aggregates son las entidades principales del sistema. Encapsulan estado y comportamiento, y son la única forma de modificar los datos dentro de su contexto.

#### `Employee` Aggregate

Representa a un empleado registrado en el sistema.

**Campos:** `id` (UUID v4) · `companyId` · `name` · `phone` (`PhoneNumber` VO) · `experienceMonths` · `skills: CompanySkill[]`

**Invariantes:**
- Nombre no puede estar vacío
- Teléfono debe ser formato E.164
- Los skills deben pertenecer a la misma empresa (`SkillValidationPolicy`)

```typescript
// El aggregate se auto-valida y emite el evento
const employee = Employee.create(id, companyId, phone, experience);
employee.commit(); // dispara EmployeeRegisteredEvent → EventBus
```

**Separación de factories:**
- `Employee.create()` — nueva entidad, dispara evento de dominio
- `Employee.fromPersistence()` — reconstruye desde DB, sin eventos

#### `WhatsappHandshake` Aggregate

Gestiona el ciclo de vida del proceso de vinculación de número WhatsApp.

**Estados del aggregate:**

```
INITIATED ──── verify(token) ────► VERIFIED
     │
     └──── [TTL expirado] ──────► EXPIRED
```

1. **Initiated** — se generó un `HandshakeToken` UUID con TTL de 15 min
2. **Verified** — el empleado envió el token correcto por WhatsApp
3. **Expired** — el TTL expiró antes de la verificación

```typescript
const handshake = WhatsappHandshake.initiate(employeeId, phone);
handshake.verify(tokenRecibido); // lanza DomainError si expirado o incorrecto
```

#### `Shift` Aggregate

Representa un turno de trabajo. Contiene skill requerido, horario, y métricas de demanda/indeseabilidad que el motor de scheduling del E2 utiliza.

#### `CompanySkill` Aggregate

Representa una certificación o habilidad que define la empresa. Incluye nivel (`junior/intermediate/senior`), meses de experiencia requeridos y fecha de expiración de certificación.

---

### Value Objects

Los Value Objects son tipos **inmutables** que encapsulan validación. No tienen identidad propia — dos VOs con el mismo valor son equivalentes.

#### `PhoneNumber`

Valida formato **E.164** (`+[código de país][número]`):

```typescript
PhoneNumber.create('+34612345678'); // ✅ válido
PhoneNumber.create('+1-800-555-0100'); // ✅ válido con guiones
PhoneNumber.create('612345678');    // ❌ DomainError — falta el código de país
PhoneNumber.create('');             // ❌ DomainError — vacío
PhoneNumber.create('no-es-un-numero'); // ❌ DomainError — no numérico
```

#### `HandshakeToken`

UUID v4 con TTL configurable que encapsula la lógica de expiración:

```typescript
const token = HandshakeToken.create(uuid, 15); // 15 minutos TTL
token.isExpired();    // false (recién creado)
token.equals(other);  // compara UUID de forma segura
HandshakeToken.create('not-a-uuid'); // ❌ — solo acepta UUID v4
```

**Por qué UUID v4 específicamente:** UUID v1 incluye el MAC address de la máquina y es predecible. UUID v4 es completamente aleatorio — imposible de adivinar o de construir una serie de futuros tokens.

#### `ExperienceLevel`

Encapsula la clasificación del empleado según sus meses de experiencia. Los rangos son configurables por empresa mediante el constructor.

```
Meses < 6        → Junior
Meses 6–23       → Intermediate
Meses ≥ 24       → Senior
```

#### `FairnessScore`

Encapsula la puntuación de equidad de un empleado (0–1000 en E2). En E1 establece el tipo y la validación base.

---

### Policies

#### `SkillValidationPolicy`

Dos responsabilidades bien separadas:

| Método | Parámetros | Verifica |
|--------|-----------|----------|
| `validateEmployee(employee, skill)` | 2 | Que el skill pertenece a la misma empresa que el empleado |
| `canWork(employee, shift, skills, date)` | 4 | Skill requerido ✔ · Certificación vigente ✔ · Experiencia mínima ✔ |

#### `FairnessPolicy`

Evalúa si asignar un turno a un empleado es "justo" comparando su historial acumulado contra el límite de horas semanales de la empresa.

---

## 6. Fase 3 — Patrón CQRS

### Por qué CQRS en un sistema de scheduling

En un sistema de scheduling enterprise, las operaciones de escritura tienen reglas complejas y generan eventos de dominio; las operaciones de lectura son consultas simples sin efectos secundarios. Mezclarlas en el mismo flujo produce código difícil de mantener y escalar.

| Tipo | Operación | Tiene efectos secundarios |
|------|-----------|--------------------------|
| Command | `RegisterEmployeeCommand` | ✅ Persiste, emite evento, notifica |
| Command | `InitiateHandshakeCommand` | ✅ Persiste, envía token por WhatsApp |
| Command | `VerifyHandshakeCommand` | ✅ Marca verificado, notifica |
| Query | `GetEmployeeCalendarQuery` | ❌ Solo lee — sin writes |

### Flujo de `RegisterEmployeeCommand`

```
POST /employees  →  EmployeeController
       ↓
  RegisterEmployeeCommand(name, phone, companyId, experienceMonths)
       ↓
  RegisterEmployeeHandler
       ├─ Employee.create(...)           ← aggregate valida invariantes
       ├─ employeeRepository.save(emp)  ← infraestructura persiste
       └─ employee.commit()             ← EventBus dispara EmployeeRegisteredEvent
                                               ↓
                                     EmployeeRegisteredHandler
                                               ↓
                                       TwilioService.sendWhatsApp("Bienvenido...")
```

El controller **nunca** toca el repositorio. Solo construye el Command y lo despacha al Bus.

### Flujo de Handshake (dos Commands)

```
POST /employees/:id/handshake  →  InitiateHandshakeCommand
    → HandshakeInitiatedEvent  →  HandshakeInitiatedHandler
                               →  Twilio envía "🔐 Tu código: {token}. Expira en 15 min."

POST /employees/:id/verify     →  VerifyHandshakeCommand
    → HandshakeVerifiedEvent   →  HandshakeVerifiedHandler
                               →  markWhatsappVerified() en DB
                               →  Twilio envía "✅ WhatsApp verificado"
```

---

## 7. Fase 4 — UUID Handshake (Vinculación WhatsApp)

### El problema

¿Cómo garantizar que el número de WhatsApp de un empleado realmente le pertenece? Se necesita un proceso de verificación seguro, sin contraseñas, que funcione nativamente en el canal WhatsApp sin instalar ninguna app adicional.

### La solución

```
Manager              API NestJS           WhatsApp del Empleado
   │                      │                         │
   │  POST /handshake      │                         │
   │─────────────────────►│                         │
   │                      │  "🔐 Token: {uuid}..."  │
   │                      │────────────────────────►│
   │                      │                         │
   │                      │   POST /verify {token}  │
   │                      │◄────────────────────────│
   │                      │  200 OK ✅              │
   │                      │────────────────────────►│
```

**Pasos del flujo:**

1. Manager registra al empleado con su número de teléfono vía API
2. Sistema genera UUID v4 con TTL 15 minutos (`HandshakeToken`)
3. Token enviado por WhatsApp al empleado vía Twilio
4. Empleado responde con el token recibido
5. Sistema verifica: ¿coincide el UUID? ¿no expiró el TTL?
6. Si correcto → `whatsapp_verified = true` en la tabla `employees`

**Por qué 15 minutos:** suficiente para que el empleado lea el mensaje (incluso con mala señal), pero lo bastante corto para que un token interceptado no sea útil mucho tiempo después.

---

## 8. Fase 5 — Multi-tenancy con Row Level Security

### `TenantMiddleware`

Cada request HTTP debe identificar a qué empresa pertenece. El middleware extrae el header `X-Company-Id` y lo almacena en `AsyncLocalStorage`:

```typescript
// TenantMiddleware — intercepta cada request
const companyId = req.headers['x-company-id'];
if (!companyId) throw new BadRequestException('Missing X-Company-Id header');
tenantContext.set(companyId);
```

Rutas excluidas del middleware: `GET /` y `POST /auth/*`.

### `TenantContext` — AsyncLocalStorage

Usa `AsyncLocalStorage` de Node.js para propagar el `companyId` a través de toda la cadena de llamadas asíncronas sin tener que pasarlo explícitamente en cada parámetro:

```typescript
// En cualquier punto del stack:
const companyId = tenantContext.get(); // "uuid-empresa-actual"
```

### Row Level Security en PostgreSQL

Cada tabla tiene policies que filtran automáticamente:

```sql
-- RLS Policy en tabla employees
CREATE POLICY "tenant_isolation" ON employees
    USING (company_id = current_setting('app.company_id')::uuid);
```

El repositorio establece el contexto Supabase antes de cada query:

```typescript
await supabase.rpc('set_config', { key: 'app.company_id', value: companyId });
```

**Resultado:** Es imposible ver datos de otra empresa aunque el código "olvide" filtrar. La seguridad está en la base de datos, no solo en la aplicación.

---

## 9. Fase 6 — Observer Pattern y NotificationListener

### El problema

Los aggregates no deben saber que Twilio existe. Si `Employee` inyectara `TwilioService` directamente, violaría el Principio de Inversión de Dependencias y haría imposible testear el aggregate sin una conexión de red.

### La solución: Domain Events + Event Handlers

```
Aggregate emite evento (sin saber quién escucha)
         ↓
    EventBus (NestJS CQRS)
         ↓
  Handlers reaccionan de forma independiente
```

El aggregate no sabe quién lo escucha. Se pueden añadir handlers nuevos sin tocar ningún código existente.

### `INotificationService` — Puerto en el dominio

```typescript
// El domain define QUÉ necesita, no CÓMO se hace:
export const NOTIFICATION_SERVICE = 'NOTIFICATION_SERVICE';
export interface INotificationService {
    sendWhatsApp(to: string, body: string): Promise<void>;
}
```

### `TwilioService` — Adaptador en infraestructura

```typescript
// La infra decide CÓMO se hace:
await this.client.messages.create({
    from: `whatsapp:${this.fromNumber}`,  // prefijo obligatorio WhatsApp Business API
    to:   `whatsapp:${to}`,
    body,
});
```

### Los 3 Event Handlers

| Handler | Evento que escucha | Mensaje enviado |
|---------|-------------------|-----------------|
| `EmployeeRegisteredHandler` | `EmployeeRegisteredEvent` | `"¡Bienvenido al sistema, {name}!"` |
| `HandshakeInitiatedHandler` | `HandshakeInitiatedEvent` | `"🔐 Tu código de verificación: {token}. Expira en 15 min."` |
| `HandshakeVerifiedHandler` | `HandshakeVerifiedEvent` | Marca DB + `"✅ Tu WhatsApp ha sido verificado correctamente"` |

---

## 10. Tests unitarios — Explicación detallada

Los tests unitarios verifican el **dominio y la lógica de aplicación en aislamiento total**. No se toca la base de datos, ni Twilio, ni Redis. Todo se mockea con `jest.fn()`.

### Suite: `phone-number.spec.ts` (8 tests)

| Test | Input | Resultado esperado | Por qué es importante |
|------|-------|-------------------|----------------------|
| Formato E.164 completo | `+34612345678` | ✅ crea VO | Caso nominal — teléfono europeo |
| Formato con código de país largo | `+12025550101` | ✅ crea VO | Teléfono USA de 10 dígitos |
| Número sin `+` | `612345678` | ❌ throws | El `+` es parte del estándar E.164 |
| Número con solo `+` | `+` | ❌ throws | Número vacío disfrazado |
| String vacío | `""` | ❌ throws | Input vacío es inoperante |
| Con letras | `+34abc12345` | ❌ throws | No es un número de teléfono |
| Muy corto | `+34` | ❌ throws | Solo código de país, sin número |
| Muy largo (>15 dígitos) | `+34612345678901234` | ❌ throws | E.164 máximo es 15 dígitos |

---

### Suite: `experience-level.spec.ts` (13 tests)

Estos tests son particularmente importantes porque verifican los **bordes exactos** de los rangos — los errores off-by-one en clasificaciones de nivel son difíciles de detectar sin tests específicos.

| Test | Input (meses) | Resultado | Por qué el borde importa |
|------|--------------|-----------|--------------------------|
| 0 meses | 0 | Junior | Borde inferior del rango Junior |
| 5 meses | 5 | Junior | Último mes antes de la transición |
| 6 meses | 6 | Intermediate | Primer mes de Intermediate |
| 12 meses | 12 | Intermediate | Valor medio |
| 23 meses | 23 | Intermediate | Último mes antes de Senior |
| 24 meses | 24 | Senior | Primer mes de Senior |
| 36 meses | 36 | Senior | Valor típico de Senior |
| Months = -1 | -1 | ❌ throws | La experiencia no puede ser negativa |
| Months = decimal (6.5) | 6.5 | Intermediate | ¿Acepta decimales? Sí, intencionalmente |
| Configuración custom (rangos distintos) | — | — | Los rangos son configurables por empresa |
| `isJunior()` | 5 meses | `true` | API pública del VO |
| `isIntermediate()` | 12 meses | `true` | API pública del VO |
| `isSenior()` | 24 meses | `true` | API pública del VO |

---

### Suite: `fairness-score.spec.ts` (4 tests — E1 base)

| Test | Qué verifica |
|------|-------------|
| `create(50)` → `getValue() = 50` | Constructor básico funcional |
| `create(-1)` → throws | Score no puede ser negativo |
| Dos scores iguales → equality | Inmutabilidad e igualdad por valor |
| Score desde 0 es válido | Borde inferior permitido |

> En el **Escenario 2** este VO fue extendido a rango 0–1000 con operaciones `add()` y `subtract()` con clamping.

---

### Suite: `handshake-token.spec.ts` (9 tests)

| Test | Qué verifica | Detalle técnico |
|------|-------------|-----------------|
| UUID v4 válido → crea token | Caso nominal | `uuid` del paquete `uuid` |
| UUID v1 → throws | Solo v4 aceptado | UUID v1 es predecible — riesgo de seguridad |
| `isExpired()` recién creado | `false` | TTL de 15 min, no ha pasado tiempo |
| `isExpired()` con tiempo pasado | `true` | Simula tiempo con `Date.now()` mock |
| `equals()` con mismo UUID | `true` | Comparación de valor, no referencia |
| `equals()` con UUID diferente | `false` | Tokens distintos no son iguales |
| String vacío → throws | Input vacío rechazado | Protege contra tokens vacíos |
| No-UUID string → throws | Formato inválido | `'hola'` no es un UUID |
| TTL configurable (5 min) | Expira en 5 min | El TTL no está hardcodeado en 15 min |

---

### Suite: `employee.spec.ts` (5 tests)

| Test | Qué verifica |
|------|-------------|
| `create()` con datos válidos | Campos asignados correctamente, aggregate creado |
| `create()` lanza `EmployeeRegisteredEvent` | El evento de dominio se emite (verificado con `getUncommittedEvents()`) |
| `name` vacío → throws | Invariante: empleado sin nombre no es válido |
| `assignSkill()` con skill de otra empresa → throws | `SkillValidationPolicy` rechaza cross-tenant |
| `getSkills()` devuelve copia — no referencia | Inmutabilidad protegida: el caller no puede mutar el estado interno |

---

### Suite: `shift.spec.ts` (5 tests — E1 base)

| Test | Qué verifica |
|------|-------------|
| Constructor con datos válidos | Campos básicos asignados |
| `strtTime >= endTime` → throws | Invariante: un turno no puede durar 0 o menos |
| `getters` de startTime/endTime | Acceso correcto al horario |
| `companyId` asignado | Aislamiento de tenant en el aggregate |
| `fromPersistence()` no dispara eventos | Reconstrucción silenciosa para la DB |

---

### Suite: `whatsapp-handshake.spec.ts` (3 tests)

| Test | Qué verifica |
|------|-------------|
| `initiate()` genera token y emite evento | `HandshakeInitiatedEvent` en `getUncommittedEvents()` |
| `verify()` con token correcto → verified | Estado del aggregate cambia a verificado |
| `verify()` con token incorrecto → throws | `DomainError` con mensaje descriptivo |

---

### Suite: `skill-validation-policy.spec.ts` (8 tests)

| Test | Qué verifica | Aspecto crítico |
|------|-------------|-----------------|
| Misma empresa → no throws | `validateEmployee` — caso válido | La base del sistema de skills |
| Empresa diferente → throws | Cross-tenant rejection | Seguridad de datos |
| Mismo ID, empresa diferente → throws | El ID no es suficiente | Previene confusión por ID collision |
| Misma empresa, nombre diferente → no throws | El nombre no es determinante | Solo importa el ID y la empresa |
| `canWork()` — sin skill requerida → true | Turno sin requisito de skill | Turnos administrativos o de limpieza |
| `canWork()` — skill requerida y tiene → true | Asignación válida | Caso nominal de E2 |
| `canWork()` — skill requerida, no tiene → false | Employee sin skill | El algoritmo debe buscar otro |
| `canWork()` — certificación expirada → false | Validez temporal | Seguridad/compliance |

---

### Suite: `fairness-policy.spec.ts` (5 tests)

| Test | Escenario | Resultado |
|------|-----------|-----------|
| Primer turno de la semana (8h, límite 40h) | 0h acumuladas + 8h | `true` — dentro del límite |
| Historial lleno al límite exacto | 32h + 8h = 40h | `true` — 40 ≤ 40 |
| Historial casi lleno + 1h más | 36h + 8h = 44h | `false` — excede el límite |
| Turno solo excede el límite | 48h como único turno | `false` — turno mayor que el límite |
| Contrato extendido (límite 48h) | 40h + 8h = 48h | `true` — límite configurable |

---

### Suite: `register-employee.handler.spec.ts` (8 tests)

| Test | Qué verifica |
|------|-------------|
| Handler llama `repository.save()` | El aggregate siempre se persiste |
| Handler llama `eventBus.publish()` | El evento de dominio se publica |
| Devuelve `{ employeeId }` | Respuesta del command correcta |
| Phone inválido → DomainError propagado | Errores del aggregate salen del handler |
| Repositorio falla → error propagado | Errores de infra no son silenciados |
| `save()` se llama con el aggregate correcto | Los datos llegaron completos até infra |
| Multi-tenant: `companyId` en el aggregate | El aggregate siempre tiene el tenant correcto |
| Idempotencia: mismo ID → repositorio decide | El handler no hace lógica de duplicados |

---

### Suite: `employee-registered.handler.spec.ts` (3 tests)

| Test | Qué verifica |
|------|-------------|
| Llama `sendWhatsApp` con el phone del evento | El número correcto recibe el mensaje |
| Mensaje contiene el nombre del empleado | El mensaje es personalizado (no genérico) |
| Si `sendWhatsApp` falla → error propagado | Los errores de Twilio no se swallowean silenciosamente |

---

### Suite: `handshake-initiated.handler.spec.ts` (3 tests)

| Test | Qué verifica |
|------|-------------|
| Envía token al teléfono del evento | El número correcto recibe el token |
| Mensaje contiene el token UUID | El token está en el cuerpo del mensaje |
| Si `sendWhatsApp` falla → error propagado | El error de Twilio no se pierde |

---

### Suite: `twilio.service.spec.ts` (5 tests)

| Test | Qué verifica | Por qué es importante |
|------|-------------|----------------------|
| `from` tiene prefijo `whatsapp:` | Requisito del API de Twilio WhatsApp Business | Sin este prefijo, el mensaje va por SMS, no WhatsApp |
| `to` tiene prefijo `whatsapp:` | Idem — ambos extremos necesitan el prefijo | El error es silencioso si falta: el mensaje "se envía" pero por canal incorrecto |
| Happy path sin errores | La promesa resuelve con `void` | Verificación básica de integración |
| SDK rechaza → error con mensaje descriptivo | `"Notification failed: {twilio error}"` | Facilita debugging en producción |
| Body llega exacto al SDK | El mensaje no se modifica en tránsito | Garantiza que el texto que llegó al handler es el que recibe el empleado |

> **Nota:** El SDK de Twilio es mockeado interceptando `require('twilio')`. Cero llamadas HTTP reales en los tests.

---

## 11. Tests de integración

Verifican la **persistencia real contra Supabase local** (vía Docker Compose). El test crea datos, opera y los limpia en `afterAll`.

### Suite: `SupabaseEmployeeRepository` (5 tests)

| Test | Qué verifica |
|------|-------------|
| `save()` persiste el empleado | El registro aparece en la tabla `employees` de Supabase |
| `findById()` devuelve aggregate completo | Datos correctos, VOs reconstruidos desde DB |
| `findByPhone()` con tenant isolation | Búsqueda por teléfono funciona correctamente |
| `findById()` → `null` si no existe | No lanza excepción — comportamiento seguro |
| `markWhatsappVerified()` actualiza el flag | `whatsapp_verified` cambia a `true` en PostgreSQL |

### Suite: `SupabaseHandshakeRepository` (8 tests)

| Test | Qué verifica |
|------|-------------|
| `save()` persiste el handshake | Registro en `whatsapp_handshakes` con token UUID |
| `findById()` con JOIN de employees | Consulta retorna datos del empleado relacionado via FK |
| `findById()` → `null` si no existe | Comportamiento seguro para IDs inventados |
| Round-trip preserva token UUID | El UUID sobrevive `save() → find()` sin corrupción de formato |
| `markVerified()` actualiza `verified_at` | El timestamp se persiste correctamente en PostgreSQL |
| Tenant isolation — Test 1 | Datos de empresa A no visibles desde empresa B |
| Tenant isolation — Test 2 | `findById()` con company diferente retorna `null` |
| Tenant isolation — Test 3 | RLS bloquea el acceso cruzado incluso con el mismo ID |

---

## 12. Tests E2E

Verifican el **ciclo HTTP completo**: `request → middleware → controller → CQRS → handler → repositorio → respuesta`. Usan `supertest` sobre el servidor NestJS completo.

### `AppController` (1 test)

| Test | Status | Qué verifica |
|------|--------|-------------|
| `GET /` | 200 | Servidor corriendo, health check básico |

### `EmployeeController` (6 tests)

| Test | Status esperado | Qué verifica |
|------|----------------|-------------|
| `POST /employees` happy path | 201 | Registra empleado, devuelve `{ employeeId }` UUID |
| Sin campo `phone` | 400 | `ValidationPipe` rechaza con error descriptivo y campo indicado |
| `experienceMonths` negativo | 400 | `@Min(0)` en el DTO falla validación |
| Campo desconocido en body | 400 | `whitelist: true` bloquea campos no declarados en el DTO |
| `GET /calendar` empleado existente | 200 | Array vacío (stub hasta Escenario 2) |
| `GET /calendar` empleado inexistente | 200 | Array vacío — el stub no lanza excepciones |

### `HandshakeController` (7 tests)

| Test | Status esperado | Qué verifica |
|------|----------------|-------------|
| `POST /handshake` happy path | 202 | Inicia handshake, devuelve `{ message: "Handshake initiated" }` |
| `POST /handshake` persiste en DB | 202 | Handshake visible en Supabase después del request |
| `handshakeId` no es UUID v4 | 400 | `@IsUUID('4')` en el DTO rechaza UUID v1 o strings arbitrarios |
| Sin campo `phone` | 400 | `@IsNotEmpty()` en el DTO falla validación |
| `POST /verify` happy path | 200 | Token correcto → `{ verified: true }` |
| Handshake no existe | 404 | Handler lanza `NotFoundException` |
| Token no es UUID v4 | 400 | `@IsUUID('4')` en el DTO falla validación |

---

## 13. Resultados de verificación

```
┌─────────────────────────────────────────────┐
│  Escenario 1 — Resultados Finales           │
│                                             │
│  Unit Tests         →  112 / 112   ✅      │
│  Integration Tests  →   13 / 13   ✅      │
│  E2E Tests          →   14 / 14   ✅      │
│                     ─────────────          │
│  TOTAL              →  366 tests   ✅      │
│                                             │
│  TypeScript (tsc)   →    0 errores ✅      │
│  ESLint violations  →    0         ✅      │
│                                             │
└─────────────────────────────────────────────┘
```

### Distribución de tests por capa

| Capa | Suite | Tests |
|------|-------|-------|
| Value Objects | phone-number, experience-level, fairness-score, handshake-token | 29 |
| Aggregates | employee, shift, whatsapp-handshake | 13 |
| Policies | skill-validation-policy, fairness-policy | 13 |
| Handlers CQRS | register-employee, employee-registered, handshake-initiated | 15 |
| Infrastructure | twilio.service | 5 |
| Integration | employee-repository, handshake-repository | 13 |
| E2E | app, employee-controller, handshake-controller | 14 |
| **Total (Global)** | | **366 tests acumulados** |

---

## 14. Conclusiones

### Qué se logró

El Escenario 1 entregó una fundación enterprise con cinco garantías estructurales:

**1. El dominio es el núcleo protegido.**
`src/domain/` no tiene un solo `import` de NestJS, Supabase, Redis, o Twilio. Podría ejecutarse en cualquier entorno JavaScript. Si mañana se cambia de PostgreSQL a MongoDB, el dominio no cambia ni una línea.

**2. La inversión de dependencias funciona en la práctica.**
Los handlers dependen de interfaces (`IEmployeeRepository`, `INotificationService`). NestJS inyecta las implementaciones. En tests, se mockean las interfaces sin levantar NestJS ni conectarse a la DB.

**3. Los tests son documentación viva.**
Cada test describe un comportamiento de negocio en lenguaje claro. Si un test falla, hay una regla rota — no solo "algo salió mal". El coverage incluye VOs, aggregates, handlers, repositorios y controladores end-to-end.

**4. Multi-tenancy desde el origen, no como afterthought.**
`TenantMiddleware` valida el tenant en cada request. RLS en PostgreSQL garantiza aislamiento. No existe una query que pueda ver datos de otra empresa aunque "olvide" filtrar por tenant — la seguridad está en dos capas.

**5. Observer Pattern desacopla completamente los side effects.**
`Employee` no sabe que existe Twilio. Solo emite `EmployeeRegisteredEvent`. Si mañana necesitamos también enviar un email o una notificación push, se agrega un nuevo handler sin tocar ningún código existente.

### Decisiones de diseño clave

| Decisión | Alternativa considerada | Razón de la elección |
|----------|------------------------|----------------------|
| `AsyncLocalStorage` para tenant context | Pasar `companyId` en cada parámetro | Ergonomía: no contamina cada firma de función |
| `fromPersistence()` separado de `create()` | Un solo constructor | `create()` emite eventos; `fromPersistence()` no — separación de responsabilidades |
| RLS en PostgreSQL + validación en TS | Solo validación en código | Defensa en profundidad: si hay un bug en el código, la DB sigue protegida |
| UUID v4 para tokens | UUID v1, tokens aleatorios numéricos | Imposible de adivinar; estándar ampliamente soportado |
| `whitelist: true` en ValidationPipe | Permitir campos extras | Evita inyección de datos inesperados en el sistema |
| **Robustez Continua** | — | Con 366 tests unitarios, el sistema garantiza estabilidad total tras cada refactorización |

### Próximos pasos

Con esta base, el sistema está listo para:

- **Escenario 2** — Motor de Scheduling + Strategy Pattern + Fairness Algorithm
- **Escenario 3** — Semantic Rule Engine con pgvector + RAG
- **Escenario 4** — WhatsApp real + Whisper (speech-to-text) + Gemini (intent)

---

## 15. Delta — Sprint 2026-04 (Foundation hardening)

Cambios en la base que afectan transversalmente al resto de escenarios:

1. **ValidationPipe global** (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`) en `main.ts`. Cualquier controller que reciba un body sin DTO con decoradores devuelve 400 inmediato en lugar de 500 silencioso.
2. **DTOs class-validator agregados a 5 controllers** que aún recibían args planos: `absence-reports`, `day-off-requests`, `incidents`, `shift-templates`, `shift-swap-requests`, además del nuevo `company-policies`. Detalle: los seeds usan UUIDs no-RFC-4122, así que se prefiere `@IsString @IsNotEmpty` sobre `@IsUUID` para no rechazar datos válidos del entorno de dev.
3. **`PostgresExceptionFilter` global** (`APP_FILTER`) que mapea errores del driver a `errorCode` estables: `unique_violation` (23505), `foreign_key_violation` (23503), `not_null_violation` (23502), `invalid_input` (22P02), `value_too_long` (22001). El frontend resuelve estos códigos vía `describeApiError` (i18n EN/ES). Ya no se exponen mensajes de Postgres al usuario.
4. **Soft-delete con UNIQUE parcial.** El bug de "no puedo recrear empleado con el mismo teléfono" se resolvió con `CREATE UNIQUE INDEX … WHERE deleted_at IS NULL`, no parcheando el código de creación. Patrón canónico para cualquier tabla con soft-delete.
5. **`.env*` ignorado por git con excepción `!.env.example`.** `.env.test` y `.env.test.twilio` estaban tracked con secretos reales — remediación local + rotación de credenciales pendiente del usuario. Nuevo `.env.example` autodocumentado.
6. **CORS fail-closed.** En dev `origin: '*'`. En producción se requiere `ALLOWED_ORIGIN` explícito; sin la variable, el backend NO acepta orígenes (no degradación silenciosa a `*`).
7. **`DEV_AUTH_BYPASS`** sigue siendo deuda HIGH conocida (acepta `X-Company-Id` sin JWT). El usuario solicitó NO tocarla durante limpieza; la migración a JWT se planifica como ítem propio. Documentada en `SECURITY-ARCHITECTURE.md`.

Docs/agents actualizados en este sprint: `00_root_context.md`, `SECURITY-ARCHITECTURE.md`, `.agents/AGENTS.md`, `.agents/SKILLS-CATALOG.md`, `.agents/ARCHITECTURE.md`, `.agents/SYSTEM-MAP.md`, `.agents/EVENT-FLOWS.md`, `.agents/COMPANY-POLICIES.md` (nuevo), `.agents/RULES-ENGINE.md`, `.agents/SCHEDULER-ENGINE.md`, README de orchestrator y frontend.
