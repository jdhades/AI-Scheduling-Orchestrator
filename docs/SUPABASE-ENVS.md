# Supabase — entornos y procedimiento de schema

Tres entornos. Reglas distintas para cada uno. NO confundir.

## Mapa

| Entorno | Proyecto Supabase | Dónde está la URL | Quién puede pushear schema |
|---|---|---|---|
| **Local** | `supabase start` (Docker en tu laptop) | `127.0.0.1:54321` / `54322` | Cualquier dev, sin restricción |
| **Staging** | `gpjxtotkqwiwputcvgrw` (cuenta alternetica-io) | `https://gpjxtotkqwiwputcvgrw.supabase.co` | Dev con acceso al `~/.supabase-orchestrator/staging.env` |
| **Prod** | `elueurlgcphdnlqobvyj` (cuenta alternetica-io) | `https://elueurlgcphdnlqobvyj.supabase.co` | **Solo workflow manual con approval** — NO desde laptop |

## Regla dura

**NUNCA correr `supabase link --project-ref` apuntando a prod desde tu
máquina local.** El comando deja persistente el link en `.supabase/`
y un `supabase db push` siguiente sin querer aplica cambios contra
prod. Para prod usar SIEMPRE el workflow dedicado (sección "Prod")
que tiene approval explícito.

## Cómo pushear a staging

```bash
# Cargar variables sin export al shell padre (más seguro)
set -a
. ~/.supabase-orchestrator/staging.env
set +a

cd /home/jhav/ai-scheduling-orchestrator

# Dry-run primero (lista migrations que aplicaría, no aplica)
pnpm supabase db push --db-url "$DATABASE_URL" --dry-run

# Si el dry-run se ve bien, el real
pnpm supabase db push --db-url "$DATABASE_URL"
```

Notas:
- Esto NO requiere `supabase login`. Va directo via connection string.
- No persiste link en `.supabase/` — es one-shot.
- Las migrations en `supabase/migrations/*.sql` se aplican en orden
  alfabético. La tabla `supabase_migrations.schema_migrations` registra
  cuáles ya corrieron, así re-ejecutar es idempotente.

## Cómo pushear a prod

**Diseñado para que NO se pueda hacer accidentalmente.** El flujo:

1. **Trigger manual desde GitHub Actions** — workflow
   `.github/workflows/supabase-migrate-prod.yml` con `workflow_dispatch`.
   Requiere que un humano apruete la ejecución (Environments → "prod"
   con required reviewers configurados).

2. **El workflow corre los mismos comandos** que staging pero contra el
   secret `PROD_DATABASE_URL` que vive solo en GitHub Secrets, nunca
   en tu disco local.

3. **Pre-flight requerido**: el workflow primero corre `--dry-run`,
   imprime las migrations que se aplicarían, y espera approval antes
   de hacer el push real. Si el dry-run muestra algo inesperado, se
   cancela.

> El workflow aún no está creado — lo agregamos en Fase 6 del plan de
> deploy. Hasta entonces, **prod no tiene schema todavía** (intencional:
> primero validamos todo en staging con amigos probadores).

## Si necesitás aplicar urgente a prod sin esperar el workflow

(Caso de emergencia. Solo el owner del proyecto.)

```bash
# Cargar prod.env (vive fuera del repo, en ~/.supabase-orchestrator/)
set -a
. ~/.supabase-orchestrator/prod.env
set +a

# Confirmar visualmente que la URL es la de prod
echo "$SUPABASE_URL"

# Dry-run con doble check del nombre de host
pnpm supabase db push --db-url "$DATABASE_URL" --dry-run

# Push real (tomar screenshot del dry-run primero)
pnpm supabase db push --db-url "$DATABASE_URL"
```

**Quedate con esto**: cada vez que toques prod manualmente, documentalo
en `docs/CHANGELOG.md` con fecha, motivo y qué migrations corrieron.

## Estructura del archivo `.env` por entorno

```bash
# ~/.supabase-orchestrator/staging.env  (chmod 600)
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=sb_publishable_<...>
SUPABASE_SERVICE_ROLE_KEY=sb_secret_<...>
DATABASE_URL=postgresql://postgres:<DB_PASSWORD>@db.<ref>.supabase.co:5432/postgres
```

Reglas:
- `chmod 600 ~/.supabase-orchestrator/*.env` siempre.
- Estos archivos NO van al repo. Están fuera del working directory.
- Si compartís la máquina, considerá cifrar el directorio (`ecryptfs`,
  `gocryptfs`, o un keychain del SO).

## Reset si algo sale mal

**Staging** se puede resetear completo desde el dashboard:
`Settings → Database → Reset database password` + apenas tengas, correr
las migrations de nuevo. Toma 1 minuto, no hay data real.

**Prod** NO se resetea nunca. Si una migration rompe data real, se
hace restore desde backup (Supabase Pro tiene PITR — Point In Time
Recovery — hasta 7 días). En el plan Free no hay backups automáticos
del lado de Supabase: tenés que hacer tu propio dump diario con
`pg_dump` desde el VPS hasta que migremos a Pro.
