# Arquitectura de Seguridad del Backend

Este documento detalla la capa de seguridad implementada en el backend del **AI Workforce Scheduling Orchestrator**. Las directrices aquí descritas están alineadas con las mejores prácticas del skill `backend-security-coder`.

---

## 1. Seguridad de Red y Cabeceras HTTP (Network Security)

El punto de entrada principal de la aplicación (`main.ts`) cuenta con protecciones globales contra vectores de ataque comunes en la web.

- **Helmet**: Se utiliza como middleware global para configurar automáticamente cabeceras HTTP seguras. Esto incluye la mitigación de ataques como Clickjacking (mediante `X-Frame-Options`), rastreos de tecnología (`X-Powered-By` desactivado), y protección contra ataques XSS reflejados.
- **CORS Estricto**: La política de Intercambio de Recursos de Origen Cruzado (CORS) está diseñada para leer la variable de entorno `ALLOWED_ORIGIN`. En producción, esto garantiza que solo los frontends o clientes autorizados puedan comunicarse con la API, bloqueando peticiones desde orígenes desconocidos.

---

## 2. Validación de Entrada (Input Validation & Sanitization)

Para prevenir la inyección de datos maliciosos o el abuso de endpoints, el sistema implementa una validación estricta a nivel global.

- **Global ValidationPipe**: Todo payload (JSON) entrante a través de métodos POST/PUT/PATCH es interceptado automáticamente por el `ValidationPipe` de NestJS.
- **Whitelist & Forbid Non-Whitelisted**: La validación está configurada de manera estricta. Cualquier propiedad enviada en el body que no esté explícitamente definida en el Data Transfer Object (DTO) correspondiente es automáticamente descartada (`whitelist: true`). Además, si se envían propiedades no deseadas, el request es bloqueado con un error `400 Bad Request` (`forbidNonWhitelisted: true`), protegiendo a la base de datos de inyecciones de campos y Mass Assignment.

---

## 3. Autenticación y Guardias (Authentication)

El sistema emplea un modelo **"Seguro por Defecto"** (Secure-by-Default) utilizando Supabase JWTs.

- **SupabaseAuthGuard (Global)**: Un guardia de autenticación global intercepta todas las peticiones a la API. Su responsabilidad es:
  1. Extraer el token `Bearer` del header `Authorization`.
  2. Validar criptográficamente el token contra el servidor de Supabase.
  3. Denegar el acceso (`401 Unauthorized`) si el token falta, expiró o fue alterado.
  4. Inyectar el objeto `user` seguro en el ciclo de vida de Express (`request.user`).
- **Decorador `@Public()`**: Dado que la aplicación está cerrada por defecto, los endpoints que deben ser accesibles externamente (como los webhooks de Twilio o WhatsApp) se marcan explícitamente con el decorador `@Public()`. El guardia global lee esta metadata y permite el paso exclusivo a estas rutas.

---

## 4. Aislamiento de Inquilinos (Tenant Isolation & Anti-IDOR)

Como una plataforma SaaS multi-inquilino (Multi-tenant), es crítico asegurar que un usuario de la "Empresa A" no pueda acceder a los datos de la "Empresa B".

- **TenantMiddleware**: Este middleware se ejecuta justo después de la autenticación. Su objetivo es establecer el contexto de la empresa (`company_id`) para el resto del ciclo de vida del request.
- **Prevención de IDOR**: La vulnerabilidad de Insecure Direct Object Reference (IDOR) está mitigada priorizando la identidad criptográfica. El middleware lee el `company_id` directamente del JWT validado (`request.user.company_id`). El uso de un header manual (`X-Company-Id`) solo se procesa como un fallback (por ejemplo, para comunicación servició a servicio interno sin usuario), pero **nunca** puede sobrescribir el contexto de un usuario logueado en una sesión activa.

---

## 5. Seguridad en Webhooks de Terceros

Los endpoints marcados como `@Public()` corren el riesgo de ser atacados directamente. En el caso de las integraciones externas, se implementan validaciones de firma.

- **Firma de Twilio / WhatsApp**: En el `WhatsAppController`, antes de procesar un mensaje entrante, el sistema utiliza `Twilio.validateRequest` usando el `authToken` secreto. Esto verifica el hash matemático `x-twilio-signature`, garantizando al 100% que el request fue originado genuinamente por los servidores de Twilio y no mediante un ataque de suplantación (Spoofing) o repetición (Replay Attack).

---

## 6. Seguridad en Base de Datos

- **Consultas Parametrizadas**: Al usar la SDK `@supabase/supabase-js`, todas las sentencias SQL (internamente en Supabase PostgREST) se parametriza automáticamente, eliminando por completo los vectores clásicos de Inyección SQL.
- **Supabase Service Role**: El backend opera usando el `SERVICE_ROLE_KEY`. Esto le otorga control total (haciendo bypass al PostgreSQL Row Level Security - RLS). Sin embargo, esto es seguro porque el backend, como "trusted boundary" (frontera segura), ya ha hecho cumplir las reglas lógicas de aislamiento en el `TenantMiddleware`.
