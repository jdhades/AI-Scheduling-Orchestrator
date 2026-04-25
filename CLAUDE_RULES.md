# Reglas de seguridad — npm / supply-chain

> Trigger: ataque a `axios@1.14.1` (Oct 2025) y publicación de
> `plain-crypto-js`. Las reglas siguientes son obligatorias antes de
> cualquier instalación o cambio de dependencia en este repo.

## Antes de instalar un paquete

1. Verificar que el paquete tenga **>1 000 descargas semanales** y **>7 días
   desde la última publicación**. (Evita typosquatting + 0-day publish.)
2. Inspeccionar el `package.json` del paquete buscando `postinstall`,
   `preinstall`, `install` y revisar qué hacen. Si descargan binarios
   (`curl`, `wget`, fetches a hosts no oficiales) → no instalar sin
   autorización.
3. Si el paquete es nuevo y desconocido, instalarlo primero con
   `--ignore-scripts` y solo habilitar el script post-instalación tras
   revisar su contenido.

## Cómo se instala

- `npm install <pkg>` se guarda con **versión exacta** (sin caret) por
  el `.npmrc` (`save-exact=true`).
- `npm install` falla si la operación introduce vulnerabilidades
  `high+` (`audit-level=high`).
- Para un paquete específicamente sospechoso usar:
  `npm install --ignore-scripts <pkg>`
- Después de cualquier `install`, correr `npm audit` y revisar.

## Versiones bloqueadas explícitamente

| Paquete | Versión segura | Versión a EVITAR | Motivo |
|---|---|---|---|
| axios | `1.13.6` (pinneado vía `overrides`) | `1.14.1`, `0.30.4` | supply-chain Oct 2025 |
| plain-crypto-js | — (no instalar) | cualquiera | typosquatting de `crypto-js` |

## Por qué NO usamos `ignore-scripts` global

Estos paquetes legítimos necesitan postinstall:

- `unrs-resolver` → binario napi nativo.
- `supabase` (CLI) → binario.
- `protobufjs` → script propio.
- `@nestjs/core` → mensaje de OpenCollective (inocuo).

Hacer ignore-scripts global rompería los builds. Usamos la flag por install
puntual, no como default.

## Auditoría periódica

- `npm audit --audit-level=high` debe correr semanalmente o antes de
  cualquier release.
- Vulnerabilidades `critical` requieren fix o exception documentada
  antes de mergear a main.

## Notas sobre `overrides`

Como `axios` es transitivo (vía `twilio`), el pin a `1.13.6` se aplica
con `overrides` en `package.json`. Cualquier dep nueva que reclame
una versión incompatible va a fallar el resolve — eso es deseado.

## Ámbito

Este archivo se aplica a este repo (`ai-scheduling-orchestrator`). El
repo `ai-scheduling-frontend` tiene su propio `CLAUDE_RULES.md` con las
mismas reglas.
