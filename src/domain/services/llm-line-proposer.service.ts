import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Employee } from '../aggregates/employee.aggregate';
import type { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';
import type { SemanticConstraint } from '../strategies/scheduling-strategy.interface';
import type { ILLMService } from './llm.service.interface';
import { LLM_SERVICE } from './llm.service.interface';

/**
 * LLMLineProposerService — pide al LLM una LÍNEA SEMANAL por empleado.
 *
 * El prompt habla en lenguaje natural (nombres, no UUIDs), permite
 * chain-of-thought y evita la jerga interna del motor. La respuesta se
 * espera como JSON parseable al final del texto (el LLM puede razonar
 * antes en prosa; extraemos el último bloque `{...}` que encontremos).
 *
 * Al parsear traducimos nombres → UUIDs usando los maps que creamos al
 * construir el prompt. Así el resto del sistema sigue trabajando con
 * UUIDs en memoria y en BD.
 *
 * Este service NO decide si la propuesta es válida. Esa responsabilidad
 * es del `WeekScheduleBuilder.verify()` que, si encuentra violaciones,
 * pedirá al proposer un reintento con `feedback` puesto.
 */
@Injectable()
export class LLMLineProposerService {
  private readonly logger = new Logger(LLMLineProposerService.name);

  constructor(@Inject(LLM_SERVICE) private readonly llm: ILLMService) {}

  async proposeLines(params: {
    employees: Employee[];
    slots: VirtualShiftSlot[];
    semanticRules: SemanticConstraint[];
    weekStart: Date;
    /** Si está presente, se añade al prompt un bloque "Tu intento anterior
     *  violó X; corrige." para el loop de reintento del builder. */
    feedback?: string;
  }): Promise<Map<string, Record<string, string | 'rest'>>> {
    const { employees, slots, semanticRules, weekStart, feedback } = params;

    if (employees.length === 0 || slots.length === 0) {
      return new Map();
    }

    const { prompt, nameToEmpId, nameToTemplateId } = this.buildPrompt({
      employees,
      slots,
      semanticRules,
      weekStart,
      feedback,
    });

    this.logger.debug(
      `LLM line-proposer prompt (${prompt.length} chars):\n${prompt.slice(0, 2000)}${prompt.length > 2000 ? '\n…[truncated]' : ''}`,
    );

    let raw: string;
    try {
      raw = await this.llm.complete(prompt);
    } catch (err) {
      this.logger.warn(
        `LLM failed (${(err as Error).message}). Builder fallback a lógica determinística.`,
      );
      return new Map();
    }

    return this.parse(raw, {
      employees,
      slots,
      nameToEmpId,
      nameToTemplateId,
    });
  }

  // ─── Prompt ──────────────────────────────────────────────────────────────

  private buildPrompt(params: {
    employees: Employee[];
    slots: VirtualShiftSlot[];
    semanticRules: SemanticConstraint[];
    weekStart: Date;
    feedback?: string;
  }): {
    prompt: string;
    nameToEmpId: Map<string, string>;
    nameToTemplateId: Map<string, string>;
  } {
    const { employees, slots, semanticRules, weekStart, feedback } = params;

    // Mapeo de nombres a UUIDs. Si dos empleados comparten nombre, desambiguamos
    // con un sufijo compacto basado en los primeros chars del UUID.
    const nameToEmpId = this.buildNameMap(
      employees.map((e) => ({ id: e.id, name: e.name })),
    );
    const empIdToName = new Map([...nameToEmpId.entries()].map(([n, id]) => [id, n]));

    const templates = this.uniqueTemplates(slots);
    const nameToTemplateId = this.buildNameMap(
      templates.map((t) => ({ id: t.templateId, name: t.templateName })),
    );
    const templateIdToName = new Map(
      [...nameToTemplateId.entries()].map(([n, id]) => [id, n]),
    );

    const weekStartIso = weekStart.toISOString().split('T')[0];
    const dates = Array.from(new Set(slots.map((s) => s.date))).sort();

    const employeeBlock = employees
      .map((e) => {
        const skills = e.getSkills().map((s) => s.name).join(', ') || 'ninguna';
        return `  - ${empIdToName.get(e.id)} (skills: ${skills})`;
      })
      .join('\n');

    const templateBlock = templates
      .map((t) => {
        const displayName = templateIdToName.get(t.templateId)!;
        const capacity = this.capacityLabel(t.requiredEmployees, t.targetMode);
        return `  - ${displayName}: ${t.startLabel} a ${t.endLabel} (${capacity})`;
      })
      .join('\n');

    const datesBlock = dates
      .map((d, i) => `  ${i + 1}. ${d} (${this.weekdayLabel(d)})`)
      .join('\n');

    const rulesBlock =
      semanticRules.length > 0
        ? semanticRules.map((r, i) => `  ${i + 1}. ${r.rule}`).join('\n')
        : '  (ninguna regla adicional)';

    const feedbackBlock = feedback
      ? `\n## Tu intento anterior no fue válido\n\n${feedback}\n\nCorrige esos problemas en la nueva respuesta.\n`
      : '';

    const prompt = `Eres un asistente de planificación de horarios. Tu trabajo es armar el
horario semanal de un equipo, respetando las reglas listadas abajo.

Piensa paso a paso antes de decidir. Primero cuenta empleados, días
laborables disponibles, ausencias pedidas (feriados, vacaciones, días
libres). Luego reparte los turnos de forma equilibrada.

## Contexto

Empleados:
${employeeBlock}

Turnos disponibles (aplican todos los días de la semana):
${templateBlock}

Semana a planificar (comienza el ${weekStartIso}):
${datesBlock}

## Reglas específicas de esta semana

${rulesBlock}

## Reglas generales del sistema

- Un empleado solo puede tener un turno por día.
- Los días feriados nadie trabaja (nadie, ni el manager).
- Las vacaciones cuentan como días libres adicionales.
- Los turnos con capacidad "exactamente N" deben cubrirse con ese número EXACTO de personas.
- Los turnos con capacidad "al menos N" deben cubrirse con N o más.
- Los turnos con capacidad "idealmente N" intentan llegar a N, se permite menos.
- Los turnos con capacidad "objetivo N (el sistema distribuye)" usan N como guía; si sobra gente, repártela hacia turnos elásticos antes que saturar.
- Los turnos "elásticos" aceptan cualquier número de personas (0 o más).
- Reparte los tipos de turno de forma equilibrada entre todos los empleados. Evita que un empleado cargue siempre el mismo turno.

## Formato de salida

**CRÍTICO**: responde BREVEMENTE. Máximo 3–5 líneas de razonamiento en texto
(quién libra qué día, de un tirón). Luego, inmediatamente, el bloque JSON.
No uses tablas markdown, no expliques cada día uno por uno, no repitas las
reglas. El JSON es lo único que la máquina procesa.

\`\`\`json
{
  "weekStart": "${weekStartIso}",
  "lines": [
    {
      "employee": "<nombre exacto del empleado>",
      "days": {
        "YYYY-MM-DD": "<nombre exacto del turno | 'rest' | 'feriado' | 'vacaciones'>",
        ...
      }
    },
    ...
  ]
}
\`\`\`

Reglas del JSON:
- Una entrada de "lines" por cada empleado listado arriba.
- Una entrada por cada fecha listada arriba (las ${dates.length} fechas son obligatorias).
- Los valores de "days" deben ser: el nombre exacto de un turno, o "rest", o "feriado", o "vacaciones".
- No inventes empleados, turnos ni fechas.

## Ejemplo de referencia (SOLO para ilustrar el formato — NO es el caso real)

Contexto del ejemplo: 3 empleados (A, B, C), un turno "Mañana" con capacidad
"exactamente 2 personas", semana de 3 días (lunes, martes, miércoles), sin
feriado, regla adicional "cada uno un día libre".

Razonamiento: cada empleado descansa un día distinto → A libre lunes,
B libre martes, C libre miércoles. Los días siempre trabajan 2 personas.

\`\`\`json
{
  "weekStart": "2026-01-05",
  "lines": [
    {"employee": "A", "days": {"2026-01-05": "rest",    "2026-01-06": "Mañana", "2026-01-07": "Mañana"}},
    {"employee": "B", "days": {"2026-01-05": "Mañana",  "2026-01-06": "rest",   "2026-01-07": "Mañana"}},
    {"employee": "C", "days": {"2026-01-05": "Mañana",  "2026-01-06": "Mañana", "2026-01-07": "rest"}}
  ]
}
\`\`\`
${feedbackBlock}
## Tu tarea

Resuelve el horario real descrito arriba siguiendo TODAS las reglas específicas
y generales. Razona, luego devuelve el JSON final.`;

    return { prompt, nameToEmpId, nameToTemplateId };
  }

  private capacityLabel(
    requiredEmployees: number | null,
    targetMode: 'exact' | 'minimum' | 'aspirational' | null,
  ): string {
    if (requiredEmployees === null) {
      return 'capacidad elástica — recibe cualquier número de personas';
    }
    switch (targetMode) {
      case 'exact':
        return `exactamente ${requiredEmployees} personas`;
      case 'minimum':
        return `al menos ${requiredEmployees} personas`;
      case 'aspirational':
        return `idealmente ${requiredEmployees} personas (se permite menos)`;
      default:
        return `objetivo ${requiredEmployees} personas (el sistema distribuye el sobrante a elásticos)`;
    }
  }

  private weekdayLabel(dateISO: string): string {
    const d = new Date(`${dateISO}T12:00:00Z`);
    const dow = d.getUTCDay();
    return ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][dow];
  }

  private uniqueTemplates(
    slots: VirtualShiftSlot[],
  ): {
    templateId: string;
    templateName: string;
    startLabel: string;
    endLabel: string;
    requiredEmployees: number | null;
    targetMode: 'exact' | 'minimum' | 'aspirational' | null;
  }[] {
    const byId = new Map<string, VirtualShiftSlot>();
    for (const s of slots) {
      if (!byId.has(s.templateId)) byId.set(s.templateId, s);
    }
    return [...byId.values()].map((s) => ({
      templateId: s.templateId,
      templateName: s.templateName,
      startLabel: this.hm(s.startTime),
      endLabel: this.hm(s.endTime),
      requiredEmployees: s.requiredEmployees,
      targetMode: s.targetMode,
    }));
  }

  private hm(d: Date): string {
    return d.toISOString().slice(11, 16);
  }

  /**
   * Produce un mapa `displayName → id` resolviendo colisiones con sufijos
   * `(<6 chars del id>)`. Si un name ya es único, se usa tal cual.
   */
  private buildNameMap(
    entries: { id: string; name: string }[],
  ): Map<string, string> {
    const byName = new Map<string, string[]>();
    for (const { id, name } of entries) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push(id);
    }
    const result = new Map<string, string>();
    for (const { id, name } of entries) {
      const ids = byName.get(name)!;
      if (ids.length === 1) {
        result.set(name, id);
      } else {
        result.set(`${name} (${id.slice(0, 6)})`, id);
      }
    }
    return result;
  }

  // ─── Parse ───────────────────────────────────────────────────────────────

  private parse(
    raw: string,
    context: {
      employees: Employee[];
      slots: VirtualShiftSlot[];
      nameToEmpId: Map<string, string>;
      nameToTemplateId: Map<string, string>;
    },
  ): Map<string, Record<string, string | 'rest'>> {
    const result = new Map<string, Record<string, string | 'rest'>>();

    const json = this.extractJson(raw);
    if (!json) {
      this.logger.warn('LLM line-proposer: no pude extraer JSON del output');
      return result;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      this.logger.warn(
        `LLM line-proposer: JSON inválido (${(err as Error).message})`,
      );
      return result;
    }

    if (!Array.isArray(parsed?.lines)) {
      this.logger.warn(
        'LLM line-proposer: la respuesta no trae un array "lines"',
      );
      return result;
    }

    const validDates = new Set(context.slots.map((s) => s.date));
    const normalizedEmpMap = this.buildNormalizedNameMap(context.nameToEmpId);
    const normalizedTemplateMap = this.buildNormalizedNameMap(
      context.nameToTemplateId,
    );

    for (const line of parsed.lines) {
      if (typeof line?.employeeId === 'string') {
        // Retrocompatibilidad: el prompt viejo aún devolvía employeeId (UUID).
        this.logger.warn(
          `LLM line-proposer: recibida línea con employeeId legacy (${line.employeeId}). Se ignora.`,
        );
        continue;
      }
      if (typeof line?.employee !== 'string') continue;
      const empId = this.resolveName(line.employee, normalizedEmpMap);
      if (!empId) {
        this.logger.warn(
          `LLM line-proposer: empleado desconocido "${line.employee}" en la respuesta`,
        );
        continue;
      }
      if (typeof line?.days !== 'object' || !line.days) continue;

      const clean: Record<string, string | 'rest'> = {};
      for (const [date, rawValue] of Object.entries(line.days)) {
        if (!validDates.has(date)) continue;
        const value = typeof rawValue === 'string' ? rawValue : '';
        const norm = this.normalize(value);
        if (norm === 'rest' || norm === 'libre') {
          clean[date] = 'rest';
        } else if (norm === 'feriado' || norm === 'vacaciones') {
          clean[date] = 'rest';
        } else {
          const tplId = this.resolveName(value, normalizedTemplateMap);
          if (tplId) clean[date] = tplId;
          // Valor desconocido: se descarta silenciosamente (builder tratará
          // esa celda como sin sugerencia).
        }
      }
      if (Object.keys(clean).length > 0) {
        result.set(empId, clean);
      }
    }

    this.logger.log(
      `LLM line-proposer: ${result.size}/${context.employees.length} líneas parseadas`,
    );
    for (const [empId, days] of result) {
      const emp = context.employees.find((e) => e.id === empId);
      const tplIdToShort = new Map<string, string>();
      for (const s of context.slots) {
        if (!tplIdToShort.has(s.templateId)) tplIdToShort.set(s.templateId, s.templateName);
      }
      const summary = Object.entries(days)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, v]) => {
          const short = v === 'rest' ? 'REST' : tplIdToShort.get(v) ?? v.slice(0, 6);
          return `${d.slice(5)}→${short}`;
        })
        .join(' ');
      this.logger.log(`  LLM[${emp?.name ?? empId.slice(0, 6)}]: ${summary}`);
    }
    return result;
  }

  /** Busca el bloque JSON en el output (prefer el último `{...}` balanceado). */
  private extractJson(raw: string): string | null {
    // Strip code fences si vienen: ```json ... ``` o ``` ... ```
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : raw;
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    return candidate.slice(first, last + 1);
  }

  private normalize(s: string): string {
    return s
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''); // remove diacritics
  }

  private buildNormalizedNameMap(
    original: Map<string, string>,
  ): Map<string, string> {
    const out = new Map<string, string>();
    for (const [name, id] of original) {
      out.set(this.normalize(name), id);
    }
    return out;
  }

  private resolveName(
    candidate: string,
    normalizedMap: Map<string, string>,
  ): string | null {
    return normalizedMap.get(this.normalize(candidate)) ?? null;
  }
}
