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
    return `Eres un analizador de reglas de planificación de horarios. Recibes una regla en lenguaje natural (español) y la conviertes en una estructura JSON.

REGLA A ANALIZAR:
"${ruleText}"

AÑO DE REFERENCIA PARA FECHAS SIN AÑO: ${year}

SCHEMA DE RESPUESTA (JSON ESTRICTO, SIN TEXTO ADICIONAL):
{
  "intent": "block" | "permit-multi-shift" | "preference" | "complex",
  "employeeMatchers": [
    { "type": "all" } |
    { "type": "name", "value": "NOMBRE" }
  ],
  "dateMatchers": [
    { "type": "iso-date", "value": "YYYY-MM-DD" } |
    { "type": "day-of-week", "value": "lunes" | "martes" | "miercoles" | "jueves" | "viernes" | "sabado" | "domingo" }
  ],
  "shiftTypeMatchers": ["day" | "night" | "morning" | "afternoon"],
  "complexReason": "solo si intent=complex, explica por qué no pudo descomponerse"
}

REGLAS DE DECISIÓN:
- intent="block" si la regla PROHÍBE trabajar (ej. "el 25 no se trabaja", "Ana no puede hacer noches").
- intent="permit-multi-shift" si AUTORIZA múltiples turnos el mismo día a un empleado (ej. "Maria cubre mañana y noche el 15/04").
- intent="preference" si es orientativa, no bloqueante (ej. "Pedro prefiere mañanas").
- intent="complex" cuando la regla NO se puede representar con los matchers disponibles. Criterio clave: si la regla habla de restricciones de tiempo (días libres, rotación, frecuencia, secuencia, condiciones entre empleados) pero al intentar llenar los matchers terminarías con dateMatchers=[] y shiftTypeMatchers=[] → NO uses intent=block. Eso sería una regla vacía que el sistema ignora silenciosamente. Mejor marca intent="complex" y explica en complexReason exactamente qué datos le faltan al schema.

CRITERIO DE SANIDAD: si elegís intent=block, verificá que AL MENOS UNO de estos tiene valores concretos: dateMatchers[], shiftTypeMatchers[], o employeeMatchers con type=name específico. Si los tres serían vacíos/all-generic, la regla NO es block — marcala complex.

SEGUNDO CRITERIO (anti-avalancha): NUNCA rellenes dateMatchers con TODOS los días de la semana, ni employeeMatchers=[all] + dateMatchers cubriendo todos los días. Eso bloquearía la semana entera silenciosamente. Si la regla habla de "cada empleado", "todos tienen que…", "hay que distribuir…" → es una regla de DISTRIBUCIÓN o EXISTENCIA, no de bloqueo. Usá intent=complex y explicá en complexReason. El schema actual NO puede expresar reglas de distribución/existencia.

EMPLOYEE MATCHERS:
- {"type": "all"} si aplica a todos (ej. "feriado", "nadie trabaja", "cerrado").
- {"type": "name", "value": "..."} si menciona un empleado específico. Usa el primer nombre tal como aparece.
- Puede haber varios matchers si la regla menciona múltiples empleados.

DATE MATCHERS:
- Fechas concretas ("el 25 de abril", "15/04") → {"type": "iso-date", "value": "${year}-MM-DD"}.
- Días de la semana ("los lunes", "cada viernes") → {"type": "day-of-week", "value": "lunes"}.
- Si la regla no menciona fechas específicas → dateMatchers: [].

SHIFT TYPE MATCHERS (opcional):
- "de noche", "nocturno" → "night"
- "de día", "diurno" → "day"
- "de mañana", "matutino" → "morning"
- "de tarde", "vespertino" → "afternoon"
- Si no se menciona el tipo de turno → omitir el campo.

EJEMPLOS:

Regla: "El 16 de abril es feriado, así que nadie trabaja ese día."
{"intent":"block","employeeMatchers":[{"type":"all"}],"dateMatchers":[{"type":"iso-date","value":"${year}-04-16"}]}

Regla: "El 25 no se trabaja, estamos de luto."
{"intent":"block","employeeMatchers":[{"type":"all"}],"dateMatchers":[{"type":"iso-date","value":"${year}-MM-25"}]} (usa el mes contextual actual si no se indica; si es ambiguo, marca intent=complex)

Regla: "Pedro no puede trabajar de noche."
{"intent":"block","employeeMatchers":[{"type":"name","value":"Pedro"}],"dateMatchers":[],"shiftTypeMatchers":["night"]}

Regla: "Maria cubre turno mañana y noche el 15/04."
{"intent":"permit-multi-shift","employeeMatchers":[{"type":"name","value":"Maria"}],"dateMatchers":[{"type":"iso-date","value":"${year}-04-15"}]}

Devuelve SOLO el JSON, sin markdown ni texto adicional. Decidí vos el intent según lo que la regla realmente indique.`;
  }
}
