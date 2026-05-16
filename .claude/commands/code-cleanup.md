---
description: Limpieza de código — unused, dead files, TODO triage, lint, tests, docs vs code
---

Pasada de limpieza pre-release. Atacá cada sección en orden. Para cada
item, decidí: **DONE / SKIP / TODO** (con archivo:línea).

Aplica a ambos repos. Si encontrás algo en producción que está deprecated
pero todavía vivo, marcar TODO con plan de migración.

## 1. Dead code (highest impact)

- [ ] Unused imports detectados por `tsc --noEmit` (TS6133)
- [ ] Unused exports — archivos que nadie importa
- [ ] Archivos `.tsx` / `.ts` que no aparecen en ningún `import` (dead files)
- [ ] Branches de `if` que nunca se ejecutan (condiciones imposibles)
- [ ] Funciones/clases declaradas pero nunca llamadas
- [ ] Migration files marcados como rollback de algo que nunca llegó a prod

Comandos:
```bash
# Unused vars/imports en TS (frontend + backend)
pnpm tsc --noEmit 2>&1 | grep "TS6133"

# Archivos sin referencias inbound
for f in $(find src -name "*.tsx" -o -name "*.ts"); do
  name=$(basename "$f" | sed 's/\.[jt]sx\?$//')
  if [[ "$name" != "index" && "$name" != "main" ]]; then
    refs=$(grep -rln "from ['\"].*${name}" src --include="*.tsx" --include="*.ts" | grep -v "^${f}$" | wc -l)
    [ "$refs" -eq 0 ] && echo "DEAD: $f"
  fi
done
```

## 2. TODO triage

- [ ] `grep -rn "TODO(hardcode)"` — revisar cada uno; ¿se puede sacar
      ya? ¿O sigue siendo deuda real?
- [ ] `grep -rn "TODO\\|FIXME\\|XXX\\|HACK"` general — categorizá:
      - Deuda con plan claro → mover a issue / memory
      - Stale (ya no aplica) → borrar
      - Sin plan → discutir
- [ ] Comentarios `Phase N` / `PR M` que ya no son relevantes — borrar
      o reformular (el contexto de cuándo se hizo ya no aporta)

Comandos:
```bash
grep -rn "TODO\\|FIXME\\|HACK" src/ --include="*.tsx" --include="*.ts" | wc -l
grep -rn "TODO(hardcode)" src/ --include="*.tsx" --include="*.ts"
```

## 3. Duplicate / inconsistent

- [ ] Constantes duplicadas en archivos distintos (consolidar en un
      módulo `lib/constants.ts` o equivalente)
- [ ] Helper functions con misma lógica en varios archivos
- [ ] Componentes UI que hacen lo mismo con clases ligeramente distintas
- [ ] API hooks con shape inconsistente (algunos retornan `{data, error}`,
      otros retornan `T | null`) — uniformar

## 4. i18n cleanup

- [ ] Keys en `locales/en/*.json` que ningún componente usa (huérfanas)
- [ ] Keys en `locales/es/*.json` ausentes que sí están en `en` (broken)
- [ ] Strings hardcoded en JSX que deberían estar en i18n

Comandos:
```bash
# Keys huérfanas — listar keys y grep-ear
for ns in $(ls src/locales/en); do
  jq -r 'paths(scalars) | join(".")' "src/locales/en/$ns" | while read key; do
    if ! grep -rqn "${ns%.json}:${key}" src --include="*.tsx" --include="*.ts"; then
      echo "ORPHAN: $ns:$key"
    fi
  done
done
```

## 5. Naming consistency

- [ ] Componentes en PascalCase, hooks en `useThing`, types en PascalCase
- [ ] Archivos `.tsx` para componentes, `.ts` para utilities
- [ ] No mezclar `camelCase` y `snake_case` en mismo módulo

## 6. Tests + lint + types

- [ ] `pnpm tsc -b --noEmit` clean (frontend)
- [ ] `pnpm tsc --noEmit -p tsconfig.build.json` clean (orchestrator)
- [ ] `pnpm lint` sin nuevos errors/warnings
- [ ] `pnpm test` 100% verde

## 7. Docs vs code

- [ ] README de cada repo describe el stack actual (no menciona libs
      removidas, ni package manager viejo)
- [ ] `docs/00_root_context.md` (orchestrator) actualizado con
      controllers + services nuevos
- [ ] `docs/design-system.md` (frontend) describe tokens y rules
      vigentes; sin "TODO instalar X" si ya está instalado
- [ ] Memorias en `~/.claude/projects/.../memory/` apuntan a estado
      actual, no a sprints viejos cerrados

## 8. Migrations cleanup (orchestrator)

- [ ] Cada migration tiene comentario de cabecera explicando qué hace
      y el "why"
- [ ] No hay migrations vacías o con solo comentarios
- [ ] Migrations con `DROP TABLE` / `DROP COLUMN` están auditadas
      contra el git history (¿quién las podría romper?)

## 9. Git hygiene

- [ ] No hay `.DS_Store`, `*.swp`, `*.log` trackeados
- [ ] `.gitignore` cubre `node_modules`, `dist`, `.env*` excepto `.env.example`
- [ ] No hay branches locales abandonadas con más de un mes de antigüedad
      (`git branch -v --merged | head`)

## Reporte

```
## Code Cleanup — <fecha>

✅ Done: <N items>
⏭️  Skip: <item> — <razón>
📝 TODO: <item> — <plan>

### Action items para PR
- [ ] ...
```

Si los TODOs son mayores (refactors significativos), abrí PRs por bloque
temático — no un mega-commit "cleanup" que toca 50 archivos.
