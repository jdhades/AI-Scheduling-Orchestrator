# Reglas de seguridad — supply-chain + package manager

> Trigger: ataque a `axios@1.14.1` (Oct 2025), publicación de
> `plain-crypto-js`, ataque al paquete unscoped `tanstack@2.0.4-2.0.7`
> (Apr 2026 — brand-squat de `@tanstack/*`), y la oleada creciente de
> paquetes maliciosos en el registro npm. Las reglas siguientes son
> obligatorias antes de cualquier instalación o cambio de dependencia
> en este repo.

## Package manager: usar pnpm, NO npm

**Política del proyecto** (decidida 2026-05-14):

| npm | pnpm |
|---|---|
| `npm install` | `pnpm install` |
| `npm install <pkg>` | `pnpm add <pkg>` |
| `npm install -D <pkg>` | `pnpm add -D <pkg>` |
| `npm install --ignore-scripts <pkg>` | `pnpm add --ignore-scripts <pkg>` |
| `npm run <script>` | `pnpm <script>` o `pnpm run <script>` |
| `npm audit --audit-level=high` | `pnpm audit --audit-level=high` |

- Lockfile: `pnpm-lock.yaml` (no `package-lock.json`). Si todavía existe
  `package-lock.json` por legacy, en la próxima instalación migramos via
  `pnpm import` o `pnpm install` fresh.
- pnpm respeta `.npmrc` — `save-exact=true` y `audit-level=high` siguen
  aplicando igual.
- Por qué pnpm: content-addressed store + symlinks blindan contra
  postinstall scripts que se propagan lateralmente en el flat layout de
  npm. Plus, strict peer-deps cachean conflicts antes.

## Antes de instalar un paquete

1. Verificar que el paquete tenga **>1 000 descargas semanales** y **>7 días
   desde la última publicación**. (Evita typosquatting + 0-day publish.)
2. **Si la librería pertenece a un namespace scoped conocido (`@tanstack/*`,
   `@nestjs/*`, `@supabase/*`, `@radix-ui/*`, etc.), instalar SIEMPRE la
   versión scoped, NUNCA la unscoped del mismo nombre.** Los paquetes
   unscoped con nombre de namespace conocido casi siempre son brand-squats
   maliciosos. Ejemplo del ataque Apr 2026: `tanstack@2.0.4-2.0.7` (unscoped)
   exfiltraba `.env` via postinstall, mientras `@tanstack/*` (scoped,
   oficiales) son seguros.
3. Inspeccionar el `package.json` del paquete buscando `postinstall`,
   `preinstall`, `install` y revisar qué hacen. Si descargan binarios
   (`curl`, `wget`, fetches a hosts no oficiales) → no instalar sin
   autorización.
4. Si el paquete es nuevo y desconocido, instalarlo primero con
   `pnpm add --ignore-scripts` y solo habilitar el script post-instalación
   tras revisar su contenido.

## Cómo se instala

- `pnpm add <pkg>` guarda con **versión exacta** (sin caret) por
  el `.npmrc` (`save-exact=true`).
- `pnpm install` falla si la operación introduce vulnerabilidades
  `high+` (configurado via `.npmrc` `audit-level=high`).
- Para un paquete específicamente sospechoso usar:
  `pnpm add --ignore-scripts <pkg>`
- Después de cualquier `add` o `install`, correr `pnpm audit` y revisar.

## Versiones bloqueadas explícitamente

| Paquete | Versión segura | Versión a EVITAR | Motivo |
|---|---|---|---|
| axios | `1.16.1` (pinneado vía `pnpm.overrides`) | `1.14.1`, `0.30.4`, `<1.15.2` | supply-chain Oct 2025 + CVE-2025-62718 + prototype pollution |
| `tanstack` (unscoped) | — (no instalar; usar `@tanstack/*` scoped) | `2.0.4`–`2.0.7` (todas las versiones del paquete unscoped) | brand-squat de `@tanstack/*` con exfiltración de `.env` via postinstall (Apr 2026) |
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

- `pnpm audit --audit-level=high` debe correr semanalmente o antes de
  cualquier release.
- Vulnerabilidades `critical` requieren fix o exception documentada
  antes de mergear a main.

## Notas sobre `pnpm.overrides`

Como `axios` es transitivo (vía `twilio`), el pin se aplica con
`pnpm.overrides` en `package.json` (NO `overrides` al nivel raíz —
esa es sintaxis npm que pnpm IGNORA silenciosamente). Cualquier dep
nueva que reclame una versión incompatible va a fallar el resolve —
eso es deseado.

Para agregar nuevos pins, editar:
```json
{ "pnpm": { "overrides": { "<pkg>": "<version>" } } }
```
y correr `pnpm install` para regenerar el lockfile.

## Ámbito

Este archivo se aplica a este repo (`ai-scheduling-orchestrator`). El
repo `ai-scheduling-frontend` tiene su propio `CLAUDE_RULES.md` con las
mismas reglas.
