# Pendiente — Analítica de horario generado (dashboard + WhatsApp)

**Estado:** por hacer / a revisar
**Origen:** discusión 2026-05-02 sobre re-prompt de Qwen con la respuesta de `generate_schedule` (devuelve análisis Markdown rico: matriz Persona×Día, KPIs, alertas, recomendaciones).

---

## Decisión guía

> No usar al LLM como source of truth de métricas. Computar determinísticamente desde `assignments` y, opcional, decorar con LLM on-demand.

Razones:
1. Conteos LLM no son confiables (suma 43, 5 por empleado, etc.) — un `reduce` da el mismo número 100% exacto.
2. Las "alertas" del LLM (ej. "sobrecarga diurna sábado: 6🌞") **no están grounded** contra la demanda real del template. La única alerta de cobertura confiable es `actual vs. expected`, donde `expected` sale del `ShiftTemplate` / `VirtualShiftSlot`.

---

## Q1 — Dashboard (qué tomar)

Aprovechable, todo recalculable determinísticamente:
- Matriz Persona × Día con icono por tipo de turno (clasificado por `ShiftTemplate.startTime`)
- Total turnos + horas por empleado
- Cobertura por día y por tipo de turno (mañana / tarde / noche)
- Subutilización: empleados < 50% del promedio del equipo
- Distribución de carga (óptimo / bajo / crítico) como barra
- Brechas vs. demanda (compara contra `VirtualShiftSlot`)

No copiar:
- "Recomendaciones urgentes" (LLM, no determinista)
- Texto narrativo largo ("Patrones observados")
- Alertas tipo "sobrecarga diurna" sin saber qué pedía el template
- Bloque de promoción final ("¿Necesitas en otro formato?")

---

## Q2 — WhatsApp (alto valor, bajo espacio)

Base existente: `bot.schedule.warning_*` (`warning_complex_rule`, `warning_unstructured_rule`, `warning_unfilled_shift`, `warning_no_day_off`).

Agregar 2-3 bullets accionables:
- **Subutilización**: "Luis: 1 turno (8h) — muy por debajo del promedio (4.3)"
- **Resumen de balance**: "8 con 40h | 2 con <16h (Luis, Pablo)"
- **Brecha por tipo**: "Mié 06/05: 0 nocturnos asignados (template requería 2)"

No mandar por WA:
- La matriz tabular (se rompe en monospace)
- Bloque de métricas multiline
- Prosa larga de recomendaciones

Regla: **WA = "qué está mal y qué hago"; dashboard = detalle completo.**

---

## Q3 — Opinión experta (resumen)

**a)** Determinístico para datos, LLM solo para narrativa.
**b)** Las alertas del LLM están sin grounding contra demanda — calcular `actual vs. expected` desde el template.
**c)** Separación dato/narrativa:
- Determinístico (gratis, exacto, automático en cada generate): coverage, totales, fairness, gaps vs. template
- LLM (on-demand, botón "explicame esta semana" en dashboard): una llamada extra cuando el manager la pide

Reusar antes de inventar:
- Fairness 0–1000 ya existe → un número al pie del dashboard sustituye media página de "comparativas de carga"
- `verify-loop` ya detecta complex/unstructured/unfilled — extender con `imbalance` + `overstaffed`
- `bot.schedule.warning_*` ya tiene el patrón de bullets para WA

---

## Prioridad sugerida (si retomamos)

1. **Backend**: agregaciones determinísticas en el response de `generate_schedule` (per-employee totals, coverage por día/tipo, imbalance flag, gaps vs. template). Idealmente como un nuevo VO `WeekScheduleSummary` o expuesto en el query handler.
2. **Dashboard**: consume las agregaciones, dibuja matriz + barra de carga + alertas.
3. **WhatsApp**: 1–2 bullets nuevos (`bot.schedule.warning_imbalance`, `bot.schedule.warning_understaffed_type`).
4. **LLM "explicame esta semana"**: botón opcional, baja prioridad. Toma JSON + métricas y devuelve narrativa.

---

## Archivos relevantes (para cuando se retome)

- [src/domain/services/week-schedule-builder.service.ts](../src/domain/services/week-schedule-builder.service.ts) — donde se construye el schedule y se generan los warnings actuales
- [src/application/handlers/get-my-schedule.handler.ts](../src/application/handlers/get-my-schedule.handler.ts) — formato de schedule para WA
- [src/i18n/en/bot.json](../src/i18n/en/bot.json) + [es/bot.json](../src/i18n/es/bot.json) — namespace `schedule.*`
- [src/domain/aggregates/shift-assignment.aggregate.ts](../src/domain/aggregates/shift-assignment.aggregate.ts)
- [src/domain/aggregates/shift-template.aggregate.ts](../src/domain/aggregates/shift-template.aggregate.ts) — fuente de demanda esperada
