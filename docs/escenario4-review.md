# Escenario 4 — Conversacional (WhatsApp + Voz + Gemini/Qwen): Review Detallado

> ⚠️ **FROZEN SNAPSHOT (Mar 2026).** Las referencias a "Gemini 1.5 Pro" en el texto
> se deben leer como **"el proveedor LLM activo"** (seleccionable vía
> `ACTIVE_AI_PROVIDER=qwen|gemini|local`): Qwen `qwen3.6-plus` default,
> Gemini 2.0 Flash, o `LocalLLMService` contra LM Studio/Ollama/llama.cpp.
> Ver `.agents/ARCHITECTURE.md` §External Services y `docs/00_root_context.md` §1.

> **Proyecto:** AI Scheduling Orchestrator  
> **Fecha de implementación:** Marzo 2026  
> **Stack:** NestJS · Twilio (WhatsApp y Audio) · LLM providers (Qwen/Gemini/Local) · CQRS / DDD · Supabase  
> **Autor principal:** Jean Newman  
> **Revisión técnica:** Antigravity (IA Assistant)

---

## Tabla de contenidos

1. [Introducción](#1-introducción)
2. [Arquitectura de Alto Nivel](#2-arquitectura-de-alto-nivel)
3. [Qué se supone que debe hacer (El Flujo)](#3-qué-se-supone-que-debe-hacer-el-flujo)
4. [Fases de Desarrollo](#4-fases-de-desarrollo)
   - [Fase 1: Inicialización y Setup de Proyecto](#fase-1-inicialización-y-setup-de-proyecto)
   - [Fase 2: Value Objects del Dominio](#fase-2-value-objects-del-dominio)
   - [Fase 3: Agregados y Entidades](#fase-3-agregados-y-entidades)
   - [Fase 4: Puertos e Interfaces](#fase-4-puertos-e-interfaces)
   - [Fase 5: Infraestructura (Supabase, Twilio, Gemini)](#fase-5-infraestructura-supabase-twilio-gemini)
   - [Fase 6: Servicios de Dominio](#fase-6-servicios-de-dominio)
   - [Fase 7: Application Commands & Handlers](#fase-7-application-commands--handlers)
   - [Fase 8: Webhook & REST API](#fase-8-webhook--rest-api)
   - [Fase 9: Migración SQL (Escenario 4)](#fase-9-migración-sql-escenario-4)
   - [Fase 10: Prompt Orchestrator / Routing](#fase-10-prompt-orchestrator--routing)
   - [Fase 11: Unit Tests (E4)](#fase-11-unit-tests-e4)
5. [Explicación de cada Test](#5-explicación-de-cada-test)
6. [Resultados Alcanzados](#6-resultados-alcanzados)
7. [Conclusiones](#7-conclusiones)

---

## 1. Introducción

El **Escenario 4** introduce una de las capacidades estrella del **AI Scheduling Orchestrator**: interactuar de forma intuitiva, fluida y natural usando lenguaje natural a través de **WhatsApp**, combinando notas de voz y mensajes de texto.

A diferencia del paradigma clásico de chatbots basados en menús rígidos, este escenario incorpora **Gemini 1.5 Pro** para comprender la intención del empleado a través del audio o texto entrante (gracias a sus capacidades multimodales de procesamiento de audio en línea) y así traducir el lenguaje natural en comandos estructurados del patrón CQRS. Esto permite operaciones como consultar horarios, reportar ausencias (enfermedad/emergencias), solicitar cambios de turno y generar horarios manejando todo nativamente a través de un simple mensaje.

## 2. Arquitectura de Alto Nivel

Para lograr una comunicación asíncrona y eficiente, se adoptaron las siguientes decisiones de diseño:

1. **Twilio Webhook Excluido de Tenant Middleware:**
   Las peticiones entrantes desde WhatsApp no llevan un encabezado normal de Tenant (ID de la empresa). Por ende, el Controlador `WhatsAppController` está excluido del middleware de tenant clásico. Su labor es usar el número de teléfono (remitente) para resolver a qué `companyId` y `employeeId` pertenece el usuario a través de una búsqueda global superando el aislamiento RLS intencionadamente solo para este punto.
2. **AI Agnostic Orchestration (Gemini 2.0 Flash & Qwen Plus):**
   Se implementó un motor de IA intercambiable. El sistema puede procesar audio (codificado en Base64) y texto usando el proveedor activo (`ACTIVE_AI_PROVIDER`), abstrayendo las diferencias entre las APIs de Google y Alibaba para extraer intenciones y entidades en JSON estructurado.
3. **Mapeo de Intenciones e i18n Auto-detectable:**
   La capa de inteligencia no solo detecta la intención, sino también el idioma del usuario. Si un empleado escribe en inglés o portugués, el sistema responde en el mismo idioma detectado, manteniendo la sesión conversacional coherente.
4. **Fire-and-Forget (No bloqueante):**
   El webhook devuelve `200 OK` inmediatamente a Twilio. El proceso de descarga, paso por Gemini y ejecución de la arquitectura de la app se delega a `setImmediate`, liberando la conexión HTTPS y evitando timeouts para la API del proveedor.

## 3. Qué se supone que debe hacer (El Flujo)

Cuando un empleado envía un mensaje (audio o texto) vía WhatsApp:

1. **Twilio** dispara el Webhook HTTP POST hacia el `WhatsAppController`.
2. El **Controller** responde 200 OK y verifica la firma criptográfica (saltado si es test enviroment), luego extrae el teléfono para buscar la empresa (`companyId`) y el empleado (`employeeId`) en la DB.
3. Delegación al `MessageRouterService`:
   - El router carga o crea una **Sesión Conversacional** efímera (en Redis o en memoria).
   - Analiza el `MIME Type`. Si es audio, descarga el `.ogg` desde Twilio, lo codifica en base64 y pide a `GeminiConversationalService` transcribir y estructurar la intención en un `ConversationIntentVO`.
   - Si es texto, se lo envía directamente a Gemini.
4. El `CommandMapperService` convierte el `ConversationIntentVO` a un CQRS Query (e.g., `GetMyScheduleQuery`) o a un Command (e.g., `SwapShiftCommand`).
5. El bus `CommandBus / QueryBus` ejecuta su correspondiente handler, aplicando reglas de dominio hasta detonar un Evento (Ej. `AbsenceReportedEvent`).
6. Un `EventHandler` (Ej. `notification-manager.handler`) o el mismo Orchestrator recibe el resultado y se envía el mensaje por Whatsapp al usuario notificando el éxito de su trámite.

## 4. Fases de Desarrollo

El Escenario 4 requirió dividir el esfuerzo en varias fases bien definidas según nuestra metodología de dominio:

### Fase 1: Inicialización y Setup de Proyecto
Se estableció la estructura base del proyecto NestJS con la configuración de Módulos globales, CQRS, y las dependencias fundamentales (Supabase, Twilio, Google GenAI).

### Fase 2: Value Objects del Dominio
Mapeo de los Value Objects específicos para el ecosistema conversacional: `ConversationIntentVO` para estructurar la intención detectada, y `ConversationSessionVO` para agrupar el estado temporal de la conversación (permitiendo reintentos o clarificaciones sin perder contexto).

### Fase 3: Agregados y Entidades
Revisión y ajustes sobre `EmployeeAggregate` y `ShiftAggregate` para asegurarse de que pudieran recibir estado desde los eventos disparados por la IA en lugar de solo por la API REST. Aquí el dominio empieza a reaccionar a la intención humana.

### Fase 4: Puertos e Interfaces
Se definieron los contratos para los servicios externos: `IConversationalService` para el LLM y `INotificationService` para WhatsApp. Esto garantiza la inversión de dependencias: nuestro núcleo de negocio no sabe qué es "Gemini" ni "Twilio", solo sabe que alguien puede analizar texto/audio y enviar mensajes.

### Fase 5: Infraestructura (Supabase, Twilio, Gemini)
Implementación concreta de las interfaces de la Fase 4:
- `GeminiConversationalService`: Implementa la conexión directa a la API de Google, incluyendo la codificación de audio en streaming hacia Base64.
- `TwilioService`: Maneja el envío real de los mensajes de respuesta hacia WhatsApp.

### Fase 6: Servicios de Dominio
Construcción de la orquestación lógica sin depender del exterior. Nos preparamos para el enrutamiento y validaciones de negocio puro vinculadas a conversaciones entrantes.

### Fase 7: Application Commands & Handlers
Aquí entra la capa de aplicación principal:
- **Comandos**: `SwapShiftCommand`, `ReportAbsenceCommand`, `RequestDayOffCommand`, y `GenerateHybridScheduleCommand`.
- **Handlers**: 
    - `swap-shift.handler.ts`: Verifica solapamientos temporales y emite el evento de solicitud al EventBus.
    - `report-absence.handler.ts`: Verifica urgencias (ej. "el turno empieza en menos de 2 horas", siendo vital para escalar una notificación a los administradores).
    - `get-my-schedule.handler.ts` (Query): Trae las programaciones pendientes de un empleado y las formatea amigablemente en texto.
- **Event Handlers**: `absence-reported.handler.ts` escucha si la ausencia reportada es urgente para dispararle un mensaje al WhatsApp del `Manager` correspondiente.

### Fase 8: Webhook & REST API
Implementación del `whatsapp.controller.ts` para servir como frontera externa directa con Twilio. Delegación de la lógica extraída a los comandos. Configuración de firmas en la API e instalación excluyendo el middleware de tenant estricto.

### Fase 9: Migración SQL (Escenario 4)
Se estructuraron las tablas de soporte para el almacenamiento físico y estado asíncrono en la base de datos (Supabase):
- **`shift_swap_requests`**: Maneja solicitudes de cambios de turno entre pares.
- **`absence_reports`**: Registra informes de ausencias y si son urgentes.
- **`day_off_requests`**: Para almacenar solicitudes de libranzas futuras.
- **`shift_assignments` (update)**: Se adhirió el soporte para marcar un turno libre en la nueva columna `needs_replacement`.
- Se habilitó la seguridad **RLS (Tenant Isolation)** en cada tabla.

### Fase 10: Prompt Orchestrator / Routing
Se refinaron los prompts principales (`system_instruction`) enviados a Gemini 1.5 Pro. La responsabilidad principal recae en el enrutador (`MessageRouterService`) y el mapeador (`CommandMapperService`), que fungen como traductores formales entre las intenciones "difusas" capturadas en lenguaje natural y las validaciones "estrictas" tipadas del código.

### Fase 11: Unit Tests (E4)
Esta fue la etapa final de validación. Implementamos **más de 80 unit tests robustos** evaluando cada extremo del flujo de trabajo conversacional para probar solidez frente a audios vacíos, comandos incorrectos, choques de agendas en la rotación y JSONs corruptos devueltos hipotéticamente por Gemini.

---

## 5. Explicación de cada Test

Se cubrió de forma muy escrupulosa esta fase usando TDD con Jest comprobando invariantes. Esta es una explicación detallada de para qué sirve cada suite de tests creada bajo la "Fase 11":

### 1. Value Objects (`conversation-intent.vo` y `session.vo`)
- **`ConversationIntentVO`**: Evalúa si los tipos provistos por Gemini se detectan. Prueba inmutabilidad (crear clones cuando sumamos entidades) y el método `hasMissingEntities()` que le informa a la IA que faltan cosas como la "fecha".
- **`ConversationSessionVO`**: Testea si la sesión nace limpia, si guarda contexto de JSON parcialmente construido por el empleado y se verifica su serialización en caso de requerirse en Redis debido a caídas eventuales.

### 2. Infra / LLM (`gemini-conversational.service.spec`)
Se simulan respuestas exitosas de Google AI y roturas hipotéticas (Network err, Unparseable JSON).
- **Procesamiento de Texto**: Confirma que el prompt contenga las reglas esperadas (`system_instruction`) para esquematizar el JSON.
- **Procesamiento de Audio**: Asegura que el servicio se conecte al `TwilioClient` para pedir un Stream, lo codifique correctamente a Base64, e imite el anidamiento MIME correcto a Gemini, y maneje debidamente cuando el archivo de Twilio no exista.

### 3. Application Services (`command-mapper` y `message-router`)
- **`CommandMapperService`**: Verifica cada una de las 4 posibles rutas (`check_schedule`, `swap_shift`, `report_absence`, `request_day_off`, `generate_schedule`). Confirma que si nos piden cambiar el turno, retorna un `SwapShiftCommand`; pero si al mapear este falla en extraer la *"fecha"* o *"compañero"*, devuelve proactivamente `ClarificationMessage`.
- **`MessageRouterService`**: El corazón. Examina la ruta condicional, comprobando asertivamente que un MIME `audio/ogg` invoca el processAudio local, y ejecuta el `CommandBus`. Verifica la contención de medias no soportadas (ej. `video/mp4`).

### 4. Handlers Finales (`swap-shift`, `report-absence`, `get-my-schedule`, `absence-reported`)
Se introdujo persistencia en Mock. 
- **`get-my-schedule.handler`**: Chequea que, en vez de un simple objeto, devuelva un `string` agradable de Markdown format a WhatsApp si el empíeado no tiene turnos o si los tiene en un rango.
- **`report-absence.handler`**: Empleó validaciones temporales estandar con Fake Timers comprobando la diferenciación de "Urgencia". Si faltaban menos de 2 horas para su Shift, el Command emite flag `isUrgent: true`.
- **`swap-shift.handler`**: Interesante al validar el conflicto con cruce de un `ShiftAggregate`. Si tu colega ya trababa entre las 10:00 y las 14:00, y tu le solicitaste un swap a las 11:00 am, el test falla y arroja error.
- **`absence-reported.handler`**: Un _listener_ dedicado. Demostró empíricamente en su Test que si la bandera `isUrgent` venía de un Evento subyacente, este inmediatamente invocaba al Notifier para contactar el teléfono fijo del MANAGER, en vez de un silencio asíncrono.

### 5. Controlador REST (`whatsapp.controller.spec`)
Simuló un End-to-End mockeado de la llegada de HTTP. Confirmando: 
- Rechazo explícito de `Invalid Twilio Signatures` (Seguridad OAUTH externa preventiva).
- Ignorar números de SPAM o no registrados en el repositorio global de Database (Multi-tenant lookup).
- Que el proceso despachado para Router es totalmente desligado (se invoca `setImmediate`) y no cuelga el response 200 de HTTP a Twilio.

---

## 6. Resultados Alcanzados

La implementación del Escenario 4 se concretó en el **paso superado de un total de 366 tests unitarios locales para toda la aplicación**, confirmando la no-regresión.

De ellos, **un conjunto robusto de tests exclusivos** consolidó al motor conversacional sin ningún cabo suelto.

Entre los logros destacan:
- Capacidad omnicanal asíncrona (Aceptas voz y texto natural, descargas medios nativamente).
- Alta escalabilidad sin infraestructura externa pesada (No hubo necesidad inmediata de Redis/BullMQ dada la respuesta rápida de Gemini y SetImmediate del thread local).
- Reducción de sobrecarga cognitiva al trabajador final: Un audio de 3 segundos ("Jefe, estoy indispuesto hoy, no creo llegar.") se traduce autónomamente a una Alerta Roja urgente al Manager sin intermedios en frontales webs o APPs burocráticos.

## 7. Conclusiones

La solución desarrollada se ajusta fielmente al espíritu de la arquitectura de la aplicación en Dominio, y abraza la moderna disrrupción *Voice-to-JSON* que brinda **Gemini 1.5 Pro**. Todo el código base es agnóstico del medio, respetando la segregación de Command Query Responsability (CQRS), permitiendo que la App Core trabaje transparentemente de si el evento se solicitó por un Clic de ratón o por una nota de voz. 

Con los tests pasando y la infraestructura inyectada, el Escenario 4 está consolidado y listo para cualquier demo en producción.

---

## 8. Actualización Reciente: Reporte Dinámico y Conversacional de Ausencias

Se implementó una mejora sustancial en cómo el motor conversacional maneja el reporte de ausencias (`report_absence`), combinando tres estrategias que reducen la fricción para el empleado:

1. **Extracción Avanzada por NLP:** Se robusteció el prompt de Gemini 1.5 Pro en `GeminiConversationalService` para extraer no solo fechas, sino también referencias relativas de tiempo (entidad `timeOfDay` como "mañana", "tarde", "noche").
2. **Detección Implícita (Lookup Dinámico):** Si el empleado no especifica explícitamente el ID de turno (comportamiento normal), el sistema delega en la nueva consulta CQRS `GetUpcomingShiftsQuery` para consultar directamente los turnos en el repositorio en base al tiempo actual. Si solo hay un turno próximo o filtrado lógicamente por el NLP que coincida, el bot asume ese turno y pide una simple confirmación de "Sí/No", resguardando el UUID mapeado temporalmente en la sesión (`ConversationSessionVO`).
3. **Listado Interactivo (Fallback):** Si el motor detecta múltiples turnos próximos que se solapan con la intención abstracta del usuario, emite un listado enumerado claro por WhatsApp. El empleado responde sencillamente seleccionando el número (capturado bajo la nueva intención `select_option`).

Esta actualización acopla nativamente el entendimiento de lenguaje natural difuso extraído por Gemini con las invariantes estrictas de las llaves primarias de la base de datos SQL.

---

## 9. Actualización Reciente: Agrupación Conversacional por Bloques (Shift Templates)

La interfaz en WhatsApp para el intercambio de turnos (`swap_shift`) fue mejorada drásticamente delegando el trabajo visual al nuevo modelo de datos jerárquico V2:

1. **Visualización Agrupada (Grouped Options):** El `MessageRouterService` fue refactorizado para que las opciones devueltas a los empleados en el paso `SELECT_TARGET` ya no se muestren como una lista plana y confusa de horarios solapados. Ahora, los turnos de sus colegas se agrupan en tiempo real por el bloque base del `ShiftTemplate`.
2. **Claridad del UX:** En vez de duplicados textuales (`1. Pedro - 08:00 a 16:00, 2. María - 08:00 a 16:00`), el trabajador observa el bloque titular unificado (`*08:00 - 16:00*`) y subordinada a éste, la enumeración corta de los compañeros elegibles y los puestos libres.
3. **Optimización Cognitiva:** Este cambio reconcilia la mente humana del operario front-line con la base de datos (entendiendo el turno como un slot espacial, no como una asignación individual) reduciendo la ambigüedad en la selección y acortando los mensajes de WhatsApp para evitar colapsar la pantalla del dispositivo.

---

## 10. Delta — Sprint 2026-04 (Provider abstraction + Conversational Policy/Rule Creation)

**1. Provider abstraction completa**

`ACTIVE_AI_PROVIDER` selecciona en runtime entre tres implementaciones de `ILLMService`:
- **Qwen `qwen3.6-plus`** (DashScope) — default. Multimodal: acepta audio Base64 directo.
- **Gemini 2.0 Flash** — alternativo. Multimodal.
- **`LocalLLMService`** (LM Studio / Ollama) — para entornos offline o pruebas locales. NO es multimodal: usa pipeline Whisper + LLM en dos pasos.

El `MessageRouter` no conoce la implementación; delega a `ILLMService.processMultimodal(...)` o, si el provider activo es no-multimodal, a `ITranscriptionService.transcribe(...)` + `ILLMService.processText(...)`. Decisión documentada en `.agents/AGENTS.md` y memoria de configuración de IA.

**2. WhatsApp como creador conversacional de policies y rules**

Antes WhatsApp era solo para empleados (absences, swaps, queries). En este sprint se abrió el canal para que **managers** creen policies y rules conversacionalmente. Detalle:

- **Intent nuevo `create_policy`** (y `create_rule`) que delega en `CompanyPolicyCreator` (mismo domain service que usa el HTTP controller — sin duplicación).
- **State machine de suggestion-loop** vía tabla `whatsapp_pending_clarifications`. Cada empleado puede tener un loop abierto a la vez (originalText, suggestions, expiresAt).
- **Resolución antes de intent detection**: cada mensaje entrante se chequea contra esta tabla ANTES de pasar al pipeline de NLP. Si hay loop abierto, el usuario puede responder "1", "2", "3" o reescribir; el router resuelve y persiste/descarta. Solo si no hay loop, sigue el flujo normal.
- **Permiso configurable**: `companies.whatsapp_policy_creator_roles TEXT[]` (default `['manager']`). NO hay role hardcodeado; cada tenant decide.
- **Three outcomes**:
  - `created` + `mode: 'matched'`     → "Listo, política creada con interpreter X."
  - `needs_clarification`             → "No estoy seguro de cómo estructurar eso. ¿Querés decir alguna de estas? 1) … 2) … 3) … (o reescribilo)"
  - `created` + `mode: 'llm_only'`    → "Política creada como texto libre. Se aplicará vía LLM en el solver."

Detalle de flow en `.agents/EVENT-FLOWS.md` (FLOW 7 + FLOW 8).

**3. Otros cambios relevantes para E4**

- **Provider-agnostic OCR** (E5) y **provider-agnostic NLP** (E4) ya comparten el mismo abstraction layer.
- **Cost tracking** vía `LLMUsageTracker` (memoria de configuración de IA). Aún sin agregación por empresa en UI, pero el dato se persiste por llamada.
- Twilio webhook sigue siendo la única puerta de entrada; el router se volvió más complejo pero sigue siendo síncrono al webhook (con publishing async vía Redis Streams).
