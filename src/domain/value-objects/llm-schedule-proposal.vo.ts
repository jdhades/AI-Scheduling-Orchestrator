/**
 * LLMScheduleProposalVO — Value Object
 *
 * Encapsula la propuesta de asignaciones devuelta por el LLM.
 * Parsea y valida el JSON crudo antes de que el orquestador lo procese.
 */
export interface ProposedAssignment {
  shiftId: string;
  employeeId: string;
  reason: string; // explicación en lenguaje natural del LLM
  confidence: number; // 0.0 – 1.0 declarado por el LLM
}

export class LLMScheduleProposalVO {
  private constructor(
    private readonly proposals: ProposedAssignment[],
    private readonly rawText: string,
  ) {}

  /**
   * Parsea la respuesta cruda del LLM.
   * El LLM debe retornar JSON con formato:
   * { "assignments": [ { "shiftId": "...", "employeeId": "...", "reason": "...", "confidence": 0.9 } ] }
   *
   * Si el JSON está embebido en texto, se extrae con regex.
   */
  static fromLLMResponse(raw: string): LLMScheduleProposalVO {
    if (!raw || raw.trim().length === 0) {
      throw new Error('LLMScheduleProposal: LLM returned empty response');
    }

    // Extraer bloque JSON aunque venga con texto envolvente
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(
        'LLMScheduleProposal: no JSON block found in LLM response',
      );
    }

    let parsed: { assignments?: unknown[] };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error('LLMScheduleProposal: LLM response JSON is malformed');
    }

    if (!Array.isArray(parsed.assignments)) {
      throw new Error(
        'LLMScheduleProposal: "assignments" field must be an array',
      );
    }

    const proposals = parsed.assignments.map((item: unknown, idx: number) => {
      const a = item as Record<string, unknown>;
      if (typeof a.shiftId !== 'string') {
        throw new Error(
          `LLMScheduleProposal: assignment[${idx}].shiftId must be a string`,
        );
      }
      if (typeof a.employeeId !== 'string') {
        throw new Error(
          `LLMScheduleProposal: assignment[${idx}].employeeId must be a string`,
        );
      }

      return {
        shiftId: a.shiftId,
        employeeId: a.employeeId,
        reason: typeof a.reason === 'string' ? a.reason : 'No reason provided',
        confidence:
          a.employeeId === 'NONE' || String(a.employeeId).toUpperCase() === 'NONE'
            ? 1.0
            : typeof a.confidence === 'number'
              ? Math.max(0, Math.min(1, a.confidence))
              : 0.5,
      } satisfies ProposedAssignment;
    });

    return new LLMScheduleProposalVO(proposals, raw);
  }

  /** Crea una propuesta vacía (LLM sin propuestas útiles) */
  static empty(): LLMScheduleProposalVO {
    return new LLMScheduleProposalVO([], '');
  }

  getProposals(): ProposedAssignment[] {
    return [...this.proposals];
  }

  isEmpty(): boolean {
    return this.proposals.length === 0;
  }

  count(): number {
    return this.proposals.length;
  }

  getRawText(): string {
    return this.rawText;
  }

  /** Filtra propuestas por umbral de confianza del LLM */
  withMinConfidence(threshold: number): LLMScheduleProposalVO {
    return new LLMScheduleProposalVO(
      this.proposals.filter((p) => p.confidence >= threshold),
      this.rawText,
    );
  }
}
