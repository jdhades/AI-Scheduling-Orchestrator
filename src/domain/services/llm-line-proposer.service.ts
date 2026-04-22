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

  /** Cache de traducciones: evita re-llamar al LLM en loops de reintento. */
  private readonly translationCache = new Map<string, string[]>();

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

    const combinedRuleTexts = [
      ...new Set([
        ...semanticRules.map((r) => r.rule),
        ...(rawRuleTexts ?? []),
      ]),
    ];
    const englishRuleTexts = await this.translateRulesToEnglish(combinedRuleTexts);

    const { prompt, empMaps, templateMaps } = this.buildPrompt({
      employees,
      slots,
      ruleTexts: englishRuleTexts,
      weekStart,
      feedback,
    });

    this.logger.log(
      `📝 LLM line-proposer prompt (${prompt.length} chars):\n${prompt}`,
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

    this.logger.log(
      `📥 LLM raw response (${raw.length} chars):\n${raw}`,
    );

    return this.parse(raw, {
      employees,
      slots,
      empMaps,
      templateMaps,
    });
  }

  // ─── Translation ─────────────────────────────────────────────────────────

  /**
   * Traduce reglas textuales a inglés para que encajen con el resto del
   * prompt (que ya está en inglés). Si el LLM falla o devuelve un formato
   * inesperado, se devuelven los originales (fallback silencioso).
   *
   * Cachea por input completo: en un loop de reintento con las mismas reglas
   * no re-llama al LLM.
   */
  private async translateRulesToEnglish(texts: string[]): Promise<string[]> {
    if (texts.length === 0) return [];

    const key = texts.join('\n---\n');
    const cached = this.translationCache.get(key);
    if (cached) return cached;

    const prompt = `Translate the following scheduling rules to clear English.
Preserve dates, numbers, employee names and shift names exactly.
Return ONLY a JSON array of strings — one translation per rule, in the same order.
No prose, no code fences, no explanations.

Rules:
${texts.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Expected output format:
["<english of rule 1>", "<english of rule 2>"]`;

    let raw: string;
    try {
      raw = await this.llm.complete(prompt);
    } catch (err) {
      this.logger.warn(
        `Rule translation failed (${(err as Error).message}); using originals`,
      );
      return texts;
    }

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      this.logger.warn(
        'Rule translation: no JSON array in LLM output; using originals',
      );
      return texts;
    }

    try {
      const parsed = JSON.parse(match[0]);
      if (
        !Array.isArray(parsed) ||
        parsed.length !== texts.length ||
        !parsed.every((s) => typeof s === 'string' && s.trim().length > 0)
      ) {
        this.logger.warn(
          `Rule translation: shape mismatch (expected ${texts.length} strings); using originals`,
        );
        return texts;
      }
      this.translationCache.set(key, parsed);
      this.logger.log(
        `Rule translation: ${texts.length} rule(s) translated to English`,
      );
      return parsed;
    } catch (err) {
      this.logger.warn(
        `Rule translation: JSON parse failed (${(err as Error).message}); using originals`,
      );
      return texts;
    }
  }

  // ─── Prompt ──────────────────────────────────────────────────────────────

  private buildPrompt(params: {
    employees: Employee[];
    slots: VirtualShiftSlot[];
    ruleTexts: string[];
    weekStart: Date;
    feedback?: string;
  }): {
    prompt: string;
    empMaps: ReturnType<LLMLineProposerService['buildIdentifierMaps']>;
    templateMaps: ReturnType<LLMLineProposerService['buildIdentifierMaps']>;
  } {
    const { employees, slots, ruleTexts, weekStart, feedback } = params;

    // Mapeo de nombres a UUIDs. Sufijo `-xxxxxx` (6 chars del UUID) se incluye
    // SIEMPRE para que el LLM use un identificador estable y desambiguado.
    const empMaps = this.buildIdentifierMaps(
      employees.map((e) => ({ id: e.id, name: e.name })),
    );
    const empIdToName = new Map([...empMaps.display.entries()].map(([n, id]) => [id, n]));

    const templates = this.uniqueTemplates(slots);
    const templateMaps = this.buildIdentifierMaps(
      templates.map((t) => ({ id: t.templateId, name: t.templateName })),
    );
    const templateIdToName = new Map(
      [...templateMaps.display.entries()].map(([n, id]) => [id, n]),
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

    // `ruleTexts` comes deduped and translated to English from `proposeLines`.
    const rulesBlock =
      ruleTexts.length > 0
        ? ruleTexts.map((t, i) => `  ${i + 1}. ${t}`).join('\n')
        : '  (no additional rules)';

    const feedbackBlock = feedback
      ? `\n## Your previous attempt was invalid\n\n${feedback}\n\nFix those problems in the new response.\n`
      : '';

    const prompt = `You are a schedule generator. Produce the weekly schedule satisfying ALL rules.
Think step by step INTERNALLY. Output ONLY 3–5 short lines of reasoning and then the JSON.

## Identifier format (MANDATORY)
Every employee and shift identifier has the form \`Name-xxxxxx\`, where \`xxxxxx\` is a stable 6-character suffix.
Use the FULL identifier (name + dash + suffix) EXACTLY as listed below in your JSON output. Do NOT drop, shorten, or omit the suffix — even if two identifiers share the same name.

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
      "employee": "<exact employee identifier including the -xxxxxx suffix>",
      "days": {
        "YYYY-MM-DD": "<exact shift identifier including the -xxxxxx suffix | 'rest' | 'holiday' | 'vacation'>"
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

Example context: 3 employees (A-aaaaaa, B-bbbbbb, C-cccccc), one shift "Morning-mmmmmm" with EXACT TARGET 2, a 3-day week.

Reasoning: each employee rests on a different day; 2 people always work.

\`\`\`json
{
  "weekStart": "2026-01-05",
  "lines": [
    {"employee": "A-aaaaaa", "days": {"2026-01-05": "rest",            "2026-01-06": "Morning-mmmmmm", "2026-01-07": "Morning-mmmmmm"}},
    {"employee": "B-bbbbbb", "days": {"2026-01-05": "Morning-mmmmmm", "2026-01-06": "rest",            "2026-01-07": "Morning-mmmmmm"}},
    {"employee": "C-cccccc", "days": {"2026-01-05": "Morning-mmmmmm", "2026-01-06": "Morning-mmmmmm", "2026-01-07": "rest"}}
  ]
}
\`\`\`
${feedbackBlock}
## Your task

Solve the real schedule described above, obeying ALL specific and general rules.
Reason (3–5 lines), then return the JSON.`;

    return { prompt, empMaps, templateMaps };
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
   * Produce mapas para identificar entidades por nombre+sufijo de UUID.
   *
   * `display`     — `"Nombre-xxxxxx" → uuid` (para renderizar en el prompt;
   *                 el sufijo siempre va, sea único o no, para que el LLM
   *                 use un identificador estable y no normalice el nombre).
   * `prefixToId`  — `"xxxxxx" → uuid` (parser primario; el LLM puede tipear
   *                 el nombre como quiera mientras conserve el sufijo).
   * `nameToIds`   — `normalize(nombre) → [uuids]` (fallback si el LLM
   *                 dropea el sufijo; >1 candidato ⇒ ambigüedad reportada).
   */
  private buildIdentifierMaps(
    entries: { id: string; name: string }[],
  ): {
    display: Map<string, string>;
    prefixToId: Map<string, string>;
    nameToIds: Map<string, string[]>;
  } {
    const display = new Map<string, string>();
    const prefixToId = new Map<string, string>();
    const nameToIds = new Map<string, string[]>();
    for (const { id, name } of entries) {
      // Últimos 6 chars del UUID: en v4 son la zona más aleatoria, y en los
      // seeds de testing (ej. 11111111-aaaa-bbbb-cccc-000000000001) son la
      // única parte que varía entre filas.
      const suffix = id.slice(-6);
      display.set(`${name}-${suffix}`, id);
      prefixToId.set(suffix.toLowerCase(), id);
      const norm = this.normalize(name);
      if (!nameToIds.has(norm)) nameToIds.set(norm, []);
      nameToIds.get(norm)!.push(id);
    }
    return { display, prefixToId, nameToIds };
  }

  // ─── Parse ───────────────────────────────────────────────────────────────

  private parse(
    raw: string,
    context: {
      employees: Employee[];
      slots: VirtualShiftSlot[];
      empMaps: ReturnType<LLMLineProposerService['buildIdentifierMaps']>;
      templateMaps: ReturnType<LLMLineProposerService['buildIdentifierMaps']>;
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

    for (const line of parsed.lines) {
      if (typeof line?.employeeId === 'string') {
        // Retrocompatibilidad: el prompt viejo aún devolvía employeeId (UUID).
        this.logger.warn(
          `LLM line-proposer: recibida línea con employeeId legacy (${line.employeeId}). Se ignora.`,
        );
        continue;
      }
      if (typeof line?.employee !== 'string') continue;
      const empId = this.resolveIdentifier(line.employee, context.empMaps, 'employee');
      if (!empId) continue; // resolveIdentifier ya warnea
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
          const tplId = this.resolveIdentifier(value, context.templateMaps, 'shift');
          if (tplId) clean[date] = tplId;
          // Valor desconocido: el `resolveIdentifier` ya warneó; la celda queda
          // sin sugerencia y el builder decidirá.
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

  /**
   * Resuelve el identificador devuelto por el LLM contra los maps producidos
   * en `buildIdentifierMaps`. Estrategia:
   *
   * 1. Suffix-first: si el candidate termina en `-xxxxxx` (6 hex) → match
   *    directo contra `prefixToId`. Es la ruta esperada (el prompt enseña
   *    `Name-xxxxxx`).
   * 2. Fallback por nombre: si no hay sufijo o no resuelve, intenta por
   *    nombre normalizado contra `nameToIds`:
   *    - 1 candidato → resuelve.
   *    - >1 candidato (homónimos) → warnea ambigüedad y NO resuelve.
   *    - 0 candidatos → warnea desconocido.
   */
  private resolveIdentifier(
    candidate: string,
    maps: ReturnType<LLMLineProposerService['buildIdentifierMaps']>,
    kind: 'employee' | 'shift',
  ): string | null {
    const trimmed = candidate.trim();

    // 1. Suffix-first.
    const suffixMatch = trimmed.match(/-([a-f0-9]{6})\s*$/i);
    if (suffixMatch) {
      const id = maps.prefixToId.get(suffixMatch[1].toLowerCase());
      if (id) return id;
    }

    // 2. Fallback: strip cualquier sufijo `-xxxx`/`(...)` y matchear por nombre.
    const cleaned = trimmed
      .replace(/-[a-f0-9]{4,8}\s*$/i, '')
      .replace(/\([^)]*\)/g, '')
      .trim();
    const norm = this.normalize(cleaned);
    const ids = maps.nameToIds.get(norm);
    if (!ids || ids.length === 0) {
      this.logger.warn(
        `LLM line-proposer: ${kind} desconocido "${candidate}" (no matchea sufijo ni nombre).`,
      );
      return null;
    }
    if (ids.length > 1) {
      this.logger.warn(
        `LLM line-proposer: ${kind} ambiguo "${candidate}" — ${ids.length} candidatos con el mismo nombre y sin sufijo. Línea descartada.`,
      );
      return null;
    }
    return ids[0];
  }
}
