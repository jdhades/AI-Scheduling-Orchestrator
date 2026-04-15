import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Employee } from '../aggregates/employee.aggregate';
import type { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';
import type { SemanticConstraint } from '../strategies/scheduling-strategy.interface';
import type { ILLMService } from './llm.service.interface';
import { LLM_SERVICE } from './llm.service.interface';

/**
 * LLMLineProposerService — pide al LLM una LÍNEA SEMANAL por empleado.
 *
 * En lugar de proponer asignaciones atómicas `(slot, empleado)`, el LLM
 * devuelve, para cada empleado, qué template le toca cada día de la semana
 * (o `rest` si ese día descansa). El `WeekScheduleBuilder` trata cada línea
 * como una PREFERENCIA — solo se acepta si el template propuesto pasa el
 * filtro de elegibilidad (skills, disponibilidad, bloqueos hard). Si el LLM
 * falla o se niega, el builder continúa con su lógica determinística.
 */
@Injectable()
export class LLMLineProposerService {
  private readonly logger = new Logger(LLMLineProposerService.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llm: ILLMService,
  ) {}

  async proposeLines(params: {
    employees: Employee[];
    slots: VirtualShiftSlot[];
    semanticRules: SemanticConstraint[];
    weekStart: Date;
  }): Promise<Map<string, Record<string, string | 'rest'>>> {
    const { employees, slots, semanticRules, weekStart } = params;

    if (employees.length === 0 || slots.length === 0) {
      return new Map();
    }

    const prompt = this.buildPrompt({ employees, slots, semanticRules, weekStart });
    this.logger.debug(
      `LLM line-proposer prompt (${prompt.length} chars):\n${prompt.slice(0, 1500)}${prompt.length > 1500 ? '\n…[truncated]' : ''}`,
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

    return this.parse(raw, { employees, slots });
  }

  // ─── Prompt ──────────────────────────────────────────────────────────────

  private buildPrompt(params: {
    employees: Employee[];
    slots: VirtualShiftSlot[];
    semanticRules: SemanticConstraint[];
    weekStart: Date;
  }): string {
    const { employees, slots, semanticRules, weekStart } = params;

    const weekStartIso = weekStart.toISOString().split('T')[0];
    const dates = Array.from(new Set(slots.map((s) => s.date))).sort();
    const templates = this.uniqueTemplates(slots);

    const employeeBlock = employees
      .map((e) => {
        const skills = e.getSkills().map((s) => s.name).join(', ') || 'ninguna';
        return `  - ${e.id} | ${e.name} | skills: [${skills}]`;
      })
      .join('\n');

    const templateBlock = templates
      .map(
        (t) =>
          `  - ${t.templateId} | ${t.templateName} | horario: ${t.startLabel}–${t.endLabel} | required_employees: ${t.requiredEmployees ?? 'elastic'}`,
      )
      .join('\n');

    const datesBlock = dates.map((d) => `    "${d}"`).join(',\n');

    const rulesBlock =
      semanticRules.length > 0
        ? semanticRules.map((r, i) => `  ${i + 1}. [weight=${r.weight}] ${r.rule}`).join('\n')
        : '  (no active rules)';

    return `You are a workforce scheduling assistant.
Your task is to propose a WEEKLY LINE for each employee: for every day of
the week, say which shift template they work — or "rest" if they don't.

CONSTRAINTS (enforced AUTOMATICALLY by the validator — don't try to dodge them):
  - One shift per employee per day (unless a rule says otherwise).
  - Hard rules (weight >= 2) are mandatory. Do not violate them.
  - Holidays (SEMANTIC_BLOCKED_ALL) mean NOBODY works that date.
  - Employees must have the required skill for a template.
  - Templates with required_employees = N are targets (aim for ~N per day).
  - Templates with required_employees = "elastic" absorb leftovers.

WEEK STARTS: ${weekStartIso}
DATES IN THE WEEK:
${datesBlock}

EMPLOYEES:
${employeeBlock}

SHIFT TEMPLATES:
${templateBlock}

SEMANTIC RULES:
${rulesBlock}

## OUTPUT (strict JSON, no text before or after)

{
  "lines": [
    {
      "employeeId": "<uuid>",
      "days": {
        "2026-04-20": "<templateId or 'rest'>",
        "2026-04-21": "<templateId or 'rest'>",
        ...
      }
    },
    ...
  ]
}

RULES for the JSON:
- One "lines" entry per employee listed above.
- One entry per date listed above (all ${dates.length} dates required).
- Value is either a templateId from the list above, or the literal "rest".
- Do NOT invent templateIds. Do NOT invent dates.
- Prefer covering required_employees targets first; send the rest to elastic templates.`;
  }

  // ─── Parse ───────────────────────────────────────────────────────────────

  private parse(
    raw: string,
    context: { employees: Employee[]; slots: VirtualShiftSlot[] },
  ): Map<string, Record<string, string | 'rest'>> {
    const result = new Map<string, Record<string, string | 'rest'>>();

    const json = this.extractJson(raw);
    if (!json) {
      this.logger.warn('LLM line-proposer: no pude extraer JSON del output');
      return result;
    }

    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed?.lines)) {
      this.logger.warn(
        'LLM line-proposer: la respuesta no trae un array "lines"',
      );
      return result;
    }

    const validEmployeeIds = new Set(context.employees.map((e) => e.id));
    const validTemplateIds = new Set(
      context.slots.map((s) => s.templateId),
    );
    const validDates = new Set(context.slots.map((s) => s.date));

    for (const line of parsed.lines) {
      if (typeof line?.employeeId !== 'string') continue;
      if (!validEmployeeIds.has(line.employeeId)) continue;
      if (typeof line?.days !== 'object' || !line.days) continue;

      const clean: Record<string, string | 'rest'> = {};
      for (const [date, value] of Object.entries(line.days)) {
        if (!validDates.has(date)) continue;
        if (value === 'rest') {
          clean[date] = 'rest';
        } else if (typeof value === 'string' && validTemplateIds.has(value)) {
          clean[date] = value;
        }
        // Valores desconocidos se descartan en silencio (el builder los
        // tratará como "sin sugerencia" → cae al paso 3b/4).
      }
      if (Object.keys(clean).length > 0) {
        result.set(line.employeeId, clean);
      }
    }

    this.logger.log(
      `LLM line-proposer: ${result.size}/${context.employees.length} líneas parseadas`,
    );
    // Resumen legible por empleado (ayuda a diagnosticar qué propuso el LLM).
    const tplShort = new Map<string, string>();
    for (const s of context.slots) {
      if (!tplShort.has(s.templateId)) tplShort.set(s.templateId, s.templateName);
    }
    for (const [empId, days] of result) {
      const emp = context.employees.find((e) => e.id === empId);
      const summary = Object.entries(days)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, v]) => {
          const short = v === 'rest' ? 'REST' : tplShort.get(v) ?? v.slice(0, 6);
          return `${d.slice(5)}→${short}`;
        })
        .join(' ');
      this.logger.log(`  LLM[${emp?.name ?? empId.slice(0, 6)}]: ${summary}`);
    }
    return result;
  }

  /** Busca el primer bloque `{...}` válido dentro del texto (tolera wrappers). */
  private extractJson(raw: string): string | null {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    return raw.slice(first, last + 1);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private uniqueTemplates(
    slots: VirtualShiftSlot[],
  ): {
    templateId: string;
    templateName: string;
    startLabel: string;
    endLabel: string;
    requiredEmployees: number | null;
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
    }));
  }

  private hm(d: Date): string {
    return d.toISOString().slice(11, 16);
  }
}
