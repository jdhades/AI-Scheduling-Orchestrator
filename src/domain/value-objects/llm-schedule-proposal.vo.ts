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

/** Par concreto (empleado, turno) bloqueado según las reglas semánticas — resuelto por el LLM */
export interface ProposedBlock {
  employeeId: string;
  shiftId: string;
}

/**
 * Permiso para que un empleado tenga múltiples turnos el mismo día.
 * Solo se genera cuando una regla semántica lo autoriza explícitamente
 * (ej. "Maria cubre turno mañana + noche el 15/04").
 */
export interface ProposedMultiShiftPermit {
  employeeId: string;
  day: string; // YYYY-MM-DD
}

export class LLMScheduleProposalVO {
  private constructor(
    private readonly proposals: ProposedAssignment[],
    private readonly _blocks: ProposedBlock[],
    private readonly _multiShiftPermits: ProposedMultiShiftPermit[],
    private readonly rawText: string,
  ) {}

  /**
   * Parsea la respuesta cruda del LLM.
   * El LLM debe retornar JSON con formato:
   * {
   *   "blocks": [ { "employeeId": "...", "shiftId": "..." } ],
   *   "assignments": [ { "shiftId": "...", "employeeId": "...", "reason": "...", "confidence": 0.9 } ]
   * }
   *
   * Si el JSON está embebido en texto, se extrae con regex.
   * El campo "blocks" es opcional — si está ausente se ignora silenciosamente.
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

    let parsed: {
      assignments?: unknown[];
      blocks?: unknown[];
      multi_shift_permits?: unknown[];
    };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error(
        `LLMScheduleProposal: LLM response JSON is malformed. Raw (first 200): ${jsonMatch[0].substring(0, 200)}`,
      );
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

    // Parsear blocks opcionales — descartar items inválidos silenciosamente
    const blocks: ProposedBlock[] = Array.isArray(parsed.blocks)
      ? (parsed.blocks as unknown[]).reduce<ProposedBlock[]>((acc, item) => {
          const b = item as Record<string, unknown>;
          if (typeof b.employeeId === 'string' && typeof b.shiftId === 'string') {
            acc.push({ employeeId: b.employeeId, shiftId: b.shiftId });
          }
          return acc;
        }, [])
      : [];

    // Parsear multi_shift_permits opcionales — descartar items inválidos silenciosamente
    const multiShiftPermits: ProposedMultiShiftPermit[] = Array.isArray(
      parsed.multi_shift_permits,
    )
      ? (parsed.multi_shift_permits as unknown[]).reduce<ProposedMultiShiftPermit[]>(
          (acc, item) => {
            const p = item as Record<string, unknown>;
            if (typeof p.employeeId === 'string' && typeof p.day === 'string') {
              acc.push({ employeeId: p.employeeId, day: p.day });
            }
            return acc;
          },
          [],
        )
      : [];

    return new LLMScheduleProposalVO(proposals, blocks, multiShiftPermits, raw);
  }

  /** Crea una propuesta vacía (LLM sin propuestas útiles) */
  static empty(): LLMScheduleProposalVO {
    return new LLMScheduleProposalVO([], [], [], '');
  }

  getProposals(): ProposedAssignment[] {
    return [...this.proposals];
  }

  /** Pares (empleado, turno) bloqueados derivados de las reglas semánticas por el LLM */
  getBlocks(): ProposedBlock[] {
    return [...this._blocks];
  }

  /** Permisos para que un empleado tenga múltiples turnos el mismo día (override de la regla base) */
  getMultiShiftPermits(): ProposedMultiShiftPermit[] {
    return [...this._multiShiftPermits];
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
      this._blocks,
      this._multiShiftPermits,
      this.rawText,
    );
  }
}
