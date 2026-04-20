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
    /**
     * Reglas textuales adicionales (ej. `unstructured` y `complex` del RAG)
     * que no produjeron constraints pero el LLM sí puede interpretar. Se
     * concatenan con `semanticRules` en la sección de reglas específicas.
     */
    rawRuleTexts?: string[];
    weekStart: Date;
    /** Si está presente, se añade al prompt un bloque "Tu intento anterior
     *  violó X; corrige." para el loop de reintento del builder. */
    feedback?: string;
  }): Promise<Map<string, Record<string, string | 'rest'>>> {
    const { employees, slots, semanticRules, rawRuleTexts, weekStart, feedback } = params;

    if (employees.length === 0 || slots.length === 0) {
      return new Map();
    }

    const { prompt, nameToEmpId, nameToTemplateId } = this.buildPrompt({
      employees,
      slots,
      semanticRules,
      rawRuleTexts: rawRuleTexts ?? [],
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
    rawRuleTexts: string[];
    weekStart: Date;
    feedback?: string;
  }): {
    prompt: string;
    nameToEmpId: Map<string, string>;
    nameToTemplateId: Map<string, string>;
  } {
    const { employees, slots, semanticRules, rawRuleTexts, weekStart, feedback } = params;

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
        const capacity = this.capacityLabel(t.requiredEmployees);
        return `  - ${displayName}: ${t.startLabel} a ${t.endLabel} (${capacity})`;
      })
      .join('\n');

    const datesBlock = dates
      .map((d, i) => `  ${i + 1}. ${d} (${this.weekdayLabel(d)})`)
      .join('\n');

    // Dedupe: the same textual rule can produce many constraints (e.g.
    // holiday × N blocked slots). Dedupe by `rule` to keep the prompt clean,
    // and include unstructured rule texts coming from the RAG (previously
    // silently dropped).
    const structuredTexts = semanticRules.map((r) => r.rule);
    const allRuleTexts = [...new Set([...structuredTexts, ...rawRuleTexts])];
    const rulesBlock =
      allRuleTexts.length > 0
        ? allRuleTexts.map((t, i) => `  ${i + 1}. ${t}`).join('\n')
        : '  (no additional rules)';

    const feedbackBlock = feedback
      ? `\n## Your previous attempt was invalid\n\n${feedback}\n\nFix those problems in the new response.\n`
      : '';

    const prompt = `You are a schedule generator. Produce the weekly schedule satisfying ALL rules.
Think step by step INTERNALLY. Output ONLY 3–5 short lines of reasoning and then the JSON.

## Employees
Everyone has the same conditions (including the manager).
${employeeBlock}

## Shifts (valid every day of the week)
${templateBlock}

## Week
${weekStartIso} to ${dates[dates.length - 1]}.
${datesBlock}

## Specific rules for this week
${rulesBlock}

## General rules
- One shift per employee per day.
- On holidays everyone rests (including the manager).
- Vacation days count as rest days.
- Rests: spread them across different days across employees; do not concentrate rest days on the same day.
- Balance: avoid any employee always doing only one type of shift; alternate shift types across days.

## Distribution (deterministic, applied PER DAY)

Assignment order:

1. **Exact targets first**: for each shift with EXACT TARGET N, assign exactly N available employees (with the required skill, if any). If fewer than N are available, report underfilled but continue.

2. **Even split across elastic shifts**: the remaining employees are split as evenly as possible across the ELASTIC shifts.
   - If M employees remain and there are K elastic shifts: some receive ceil(M/K), the rest receive floor(M/K).
   - Examples:
       M=10, K=2 → 5 + 5
       M=9,  K=2 → 5 + 4
       M=10, K=3 → 4 + 3 + 3
       M=6,  K=4 → 2 + 2 + 1 + 1

3. **No elastic shifts available**: if all shifts have EXACT TARGET and employees remain, those employees get "rest" that day. Never exceed an exact target.

## Output format

Reasoning: 3–5 lines maximum.
Then ONLY this JSON (nothing before or after, no extra markdown):

\`\`\`json
{
  "weekStart": "${weekStartIso}",
  "lines": [
    {
      "employee": "<exact employee name>",
      "days": {
        "YYYY-MM-DD": "<exact shift name | 'rest' | 'holiday' | 'vacation'>"
      }
    }
  ]
}
\`\`\`

Implicit validations:
- One "line" per employee listed above (${employees.length} total).
- ${dates.length} entries in "days" per employee (all dates listed above).
- Names and dates must match EXACTLY the ones listed above. Do not invent.

## Reference example (format only — NOT the real case)

Example context: 3 employees (A, B, C), a shift "Morning" with EXACT TARGET 2, a 3-day week.

Reasoning: each employee rests on a different day; 2 people always work.

\`\`\`json
{
  "weekStart": "2026-01-05",
  "lines": [
    {"employee": "A", "days": {"2026-01-05": "rest",    "2026-01-06": "Morning", "2026-01-07": "Morning"}},
    {"employee": "B", "days": {"2026-01-05": "Morning", "2026-01-06": "rest",    "2026-01-07": "Morning"}},
    {"employee": "C", "days": {"2026-01-05": "Morning", "2026-01-06": "Morning", "2026-01-07": "rest"}}
  ]
}
\`\`\`
${feedbackBlock}
## Your task

Solve the real schedule described above, obeying ALL specific and general rules.
Reason (3–5 lines), then return the JSON.`;

    return { prompt, nameToEmpId, nameToTemplateId };
  }

  private capacityLabel(requiredEmployees: number | null): string {
    if (requiredEmployees === null) {
      return 'ELASTIC';
    }
    return `EXACT TARGET: ${requiredEmployees} people/day`;
  }

  private weekdayLabel(dateISO: string): string {
    const d = new Date(`${dateISO}T12:00:00Z`);
    const dow = d.getUTCDay();
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow];
  }

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
        if (
          norm === 'rest' ||
          norm === 'libre' ||
          norm === 'holiday' ||
          norm === 'feriado' ||
          norm === 'vacation' ||
          norm === 'vacaciones'
        ) {
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

  /** Devuelve la versión "corta" de un nombre — sin paréntesis ni sufijos. */
  private stripSuffix(s: string): string {
    return this.normalize(s.replace(/\([^)]*\)/g, '').trim());
  }

  private buildNormalizedNameMap(
    original: Map<string, string>,
  ): Map<string, string> {
    // Indexamos el nombre completo Y la versión sin paréntesis, para tolerar
    // casos como "Sofía (Manager)" cuando el LLM devuelve solo "Sofía".
    // Si el stripped coincide con varias entradas, prevalece la primera; el
    // prompt usa el nombre completo para reducir ambigüedades.
    const out = new Map<string, string>();
    for (const [name, id] of original) {
      out.set(this.normalize(name), id);
      const short = this.stripSuffix(name);
      if (!out.has(short)) out.set(short, id);
    }
    return out;
  }

  private resolveName(
    candidate: string,
    normalizedMap: Map<string, string>,
  ): string | null {
    const exact = normalizedMap.get(this.normalize(candidate));
    if (exact) return exact;
    return normalizedMap.get(this.stripSuffix(candidate)) ?? null;
  }
}
