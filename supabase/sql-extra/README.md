# `supabase/sql-extra/`

SQL que **NO** se aplica automáticamente con `supabase start`.

`supabase/migrations/` corre como rol `postgres`, que carece de privilegios para
modificar ciertos schemas (notablemente `auth`). Cuando una migration falla
por permisos, el CLI aborta el start completo. Por eso este directorio existe:
archivos acá se aplican manualmente con `supabase_admin`.

## Archivos

### `custom_access_token_hook.sql`

Function `auth.custom_access_token_hook` que enriquece el JWT con
`company_id`, `employee_id`, `employee_role`, `department_id` resueltos
desde `public.employees`.

**Apply (local dev):**
```bash
docker exec -i -e PGPASSWORD=postgres supabase_db_ai-scheduling-orchestrator \
  psql -U supabase_admin -d postgres < supabase/sql-extra/custom_access_token_hook.sql
```

**Apply (Supabase Cloud):**
Dashboard → SQL Editor → pegar contenido del archivo → Run.

Después de crear la function, activá el hook:
- Local: ya declarado en `supabase/config.toml`.
- Cloud: Dashboard → Auth → Hooks → Customize Access Token → seleccionar
  `auth.custom_access_token_hook`.
