import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ILLMService } from './llm.service.interface';
import { LLM_SERVICE } from './llm.service.interface';
import {
  type RuleStructure,
  isValidRuleStructure,
} from '../value-objects/rule-structure.vo';

/**
 * RuleStructureExtractor — Domain Service
 *
 * Toma el texto libre de una regla semántica y le pide a un LLM que lo
 * descomponga en estructura (intent, employeeMatchers, dateMatchers,
 * shiftTypeMatchers). La extracción ocurre UNA VEZ al crear/editar la regla.
 *
 * El runtime usa la estructura directamente — sin NLP ni patrones hardcodeados.
 *
 * Si el LLM falla o devuelve JSON inválido → retorna `null`. El caller decide
 * si persiste la regla sin estructura (y marca warning para el manager) o
 * rechaza la creación.
 */
@Injectable()
export class RuleStructureExtractor {
  private readonly logger = new Logger(RuleStructureExtractor.name);

  constructor(
    @Inject(LLM_SERVICE)
    private readonly llmService: ILLMService,
  ) {}

  async extract(params: {
    ruleText: string;
    /** Año de referencia para resolver fechas sin año (ej. "el 25" → 2026-XX-25). */
    referenceYear?: number;
  }): Promise<RuleStructure | null> {
    const prompt = this.buildPrompt(params.ruleText, params.referenceYear);

    let raw: string;
    try {
      raw = await this.llmService.complete(prompt);
    } catch (error) {
      this.logger.warn(
        `RuleStructureExtractor: LLM call failed for rule "${params.ruleText.substring(0, 60)}". Error: ${(error as Error).message}`,
      );
      return null;
    }

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.warn(
        `RuleStructureExtractor: no JSON in LLM response. Raw: ${raw.substring(0, 200)}`,
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      this.logger.warn(
        `RuleStructureExtractor: JSON parse error. Raw: ${jsonMatch[0].substring(0, 200)}`,
      );
      return null;
    }

    if (!isValidRuleStructure(parsed)) {
      this.logger.warn(
        `RuleStructureExtractor: LLM output failed schema validation. Raw: ${jsonMatch[0].substring(0, 200)}`,
      );
      return null;
    }

    this.logger.log(
      `RuleStructureExtractor: extracted intent=${parsed.intent} for rule "${params.ruleText.substring(0, 60)}"`,
    );
    return parsed;
  }

  private buildPrompt(ruleText: string, referenceYear?: number): string {
    const year = referenceYear ?? new Date().getUTCFullYear();
    return `You are a rule analyzer for a workforce scheduling system. You receive a rule written in natural language (any language: Spanish, English, French, etc.) and convert it to a structured JSON.

# INPUT
- Rule text (may be in any language, may contain typos, ambiguities, or multiple rules in one sentence):
"${ruleText}"
- Reference year for dates without year: ${year}

# OUTPUT
Return ONE structure object. If the input contains multiple independent rules, pick the one that best captures the main intent and mark intent=complex explaining that the input mixed multiple rules.

# AVAILABLE INTENTS

Each intent represents a PATTERN TYPE (not a specific text). Pick by the INTENT of the rule, not by specific keywords.

## 1. block — Direct prohibition
Semantics: "X cannot work on Y"
Parameters:
  employeeMatchers: [{type:"name", value:"..."} | {type:"all"}]
  dateMatchers: [{type:"iso-date", value:"YYYY-MM-DD"} | {type:"day-of-week", value:"monday"|"tuesday"|"wednesday"|"thursday"|"friday"|"saturday"|"sunday"}]
  shiftTypeMatchers?: ["day"|"night"|"morning"|"afternoon"]

## 2. permit-multi-shift — Exception to "one shift per day"
Semantics: authorize an employee to cover 2+ shifts on the same day
Parameters:
  employeeMatchers, dateMatchers (specific day)

## 3. preference — Soft, non-blocking
Semantics: orientative (e.g. "X prefers mornings"). Not enforced as hard constraint.

## 4. complex — Does not fit any of the above
Use when:
  - The rule has conditional dependencies between employees
  - Dates are relative to application time ("next week") without a clear anchor
  - It requires counting/distribution logic (e.g. "each employee must have N days off")
  - The schema above cannot express it
Parameters:
  complexReason: explain which aspect of the rule does not fit the schema

# DECISION CRITERIA (in order)

1. COMPOSITION. If the sentence contains multiple independent rules, use intent=complex with a complexReason pointing this out (UX: the manager should send one rule per message).

2. INTENT. Choose by INTENT:
  - Prohibition/closure → block
  - Exceptional multi-shift authorization → permit-multi-shift
  - Soft preference → preference
  - Anything else → complex

3. PARAMETERS. Extract ONLY what the rule explicitly states. Do NOT invent values, do NOT fill aggressive defaults.

4. STRUCTURAL SANITY. Before closing, verify:
  a. If intent=block would end up with employeeMatchers=[all] + dateMatchers=[] + shiftTypeMatchers=[], the structure is empty → use complex.
  b. If your intent would block >50% of the shifts of a week without concrete data, you probably misread → use complex.
  c. If numeric parameters are out of range, something is wrong → use complex.
  d. If the date is relative without anchor AND you cannot reasonably infer it from the reference year → use complex.

5. NAMES. You do not have the employee list. Use the name as it appears. The resolver will match by first name (case-insensitive, accent-insensitive) at runtime.

6. LANGUAGE. The rule text may be in any language. day-of-week values MUST be lowercase English (monday..sunday) in the output regardless of the input language.

# OUTPUT FORMAT

{
  "intent": "block" | "permit-multi-shift" | "preference" | "complex",
  "employeeMatchers": [ { "type": "all" } | { "type": "name", "value": "..." } ],
  "dateMatchers": [ { "type": "iso-date", "value": "YYYY-MM-DD" } | { "type": "day-of-week", "value": "monday"|"tuesday"|"wednesday"|"thursday"|"friday"|"saturday"|"sunday" } ],
  "shiftTypeMatchers": ["day"|"night"|"morning"|"afternoon"],
  "complexReason": "only when intent=complex — explain what does not fit"
}

Return ONLY the JSON (no markdown, no explanation text).`;
  }
}
