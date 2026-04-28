import { LLMScheduleProposalVO } from '../../../src/domain/value-objects/llm-schedule-proposal.vo';

describe('LLMScheduleProposalVO', () => {
  // ── fromLLMResponse ───────────────────────────────────────────────────────

  describe('fromLLMResponse()', () => {
    it('should parse a valid JSON response with multiple assignments', () => {
      const raw = JSON.stringify({
        assignments: [
          {
            shiftId: 'shift-1',
            employeeId: 'emp-1',
            reason: 'Tiene la skill',
            confidence: 0.95,
          },
          {
            shiftId: 'shift-2',
            employeeId: 'emp-2',
            reason: 'Disponible',
            confidence: 0.8,
          },
        ],
      });

      const vo = LLMScheduleProposalVO.fromLLMResponse(raw);

      expect(vo.count()).toBe(2);
      expect(vo.getProposals()[0].shiftId).toBe('shift-1');
      expect(vo.getProposals()[0].employeeId).toBe('emp-1');
      expect(vo.getProposals()[0].confidence).toBe(0.95);
    });

    it('should extract JSON even when embedded in surrounding text', () => {
      const raw = `
                Aquí está mi propuesta de horario:
                {"assignments": [{"shiftId": "s1", "employeeId": "e1", "reason": "OK", "confidence": 0.9}]}
                Recuerda respetar los descansos.
            `;

      const vo = LLMScheduleProposalVO.fromLLMResponse(raw);
      expect(vo.count()).toBe(1);
      expect(vo.getProposals()[0].shiftId).toBe('s1');
    });

    it('should default reason to "No reason provided" if missing', () => {
      const raw = JSON.stringify({
        assignments: [{ shiftId: 's1', employeeId: 'e1', confidence: 0.7 }],
      });

      const vo = LLMScheduleProposalVO.fromLLMResponse(raw);
      expect(vo.getProposals()[0].reason).toBe('No reason provided');
    });

    it('should default confidence to 0.5 if missing or non-number', () => {
      const raw = JSON.stringify({
        assignments: [{ shiftId: 's1', employeeId: 'e1', reason: 'OK' }],
      });

      const vo = LLMScheduleProposalVO.fromLLMResponse(raw);
      expect(vo.getProposals()[0].confidence).toBe(0.5);
    });

    it('should clamp confidence to [0, 1]', () => {
      const raw = JSON.stringify({
        assignments: [
          { shiftId: 's1', employeeId: 'e1', reason: 'Over', confidence: 1.5 },
          {
            shiftId: 's2',
            employeeId: 'e2',
            reason: 'Under',
            confidence: -0.3,
          },
        ],
      });

      const vo = LLMScheduleProposalVO.fromLLMResponse(raw);
      expect(vo.getProposals()[0].confidence).toBe(1);
      expect(vo.getProposals()[1].confidence).toBe(0);
    });

    it('should throw if LLM response is empty', () => {
      expect(() => LLMScheduleProposalVO.fromLLMResponse('')).toThrow(
        'LLMScheduleProposal: LLM returned empty response',
      );
    });

    it('should throw if no JSON block is found in response', () => {
      expect(() =>
        LLMScheduleProposalVO.fromLLMResponse(
          'El sistema no pudo procesar la solicitud en este momento.',
        ),
      ).toThrow('LLMScheduleProposal: no JSON block found in LLM response');
    });

    it('should throw if JSON is malformed', () => {
      expect(() =>
        LLMScheduleProposalVO.fromLLMResponse('{invalid json}'),
      ).toThrow('LLMScheduleProposal: LLM response JSON is malformed');
    });

    it('should throw if assignments field is not an array', () => {
      const raw = JSON.stringify({ assignments: 'not-an-array' });
      expect(() => LLMScheduleProposalVO.fromLLMResponse(raw)).toThrow(
        '"assignments" field must be an array',
      );
    });

    it('should throw if shiftId is missing', () => {
      const raw = JSON.stringify({
        assignments: [{ employeeId: 'e1', reason: 'OK', confidence: 0.9 }],
      });
      expect(() => LLMScheduleProposalVO.fromLLMResponse(raw)).toThrow(
        'shiftId must be a string',
      );
    });

    it('should throw if employeeId is missing', () => {
      const raw = JSON.stringify({
        assignments: [{ shiftId: 's1', reason: 'OK', confidence: 0.9 }],
      });
      expect(() => LLMScheduleProposalVO.fromLLMResponse(raw)).toThrow(
        'employeeId must be a string',
      );
    });
  });

  // ── empty ─────────────────────────────────────────────────────────────────

  describe('empty()', () => {
    it('should create an empty proposal', () => {
      const vo = LLMScheduleProposalVO.empty();
      expect(vo.isEmpty()).toBe(true);
      expect(vo.count()).toBe(0);
      expect(vo.getProposals()).toEqual([]);
    });
  });

  // ── withMinConfidence ─────────────────────────────────────────────────────

  describe('withMinConfidence()', () => {
    it('should filter out proposals below threshold', () => {
      const raw = JSON.stringify({
        assignments: [
          { shiftId: 's1', employeeId: 'e1', reason: 'High', confidence: 0.9 },
          { shiftId: 's2', employeeId: 'e2', reason: 'Low', confidence: 0.5 },
          {
            shiftId: 's3',
            employeeId: 'e3',
            reason: 'Medium',
            confidence: 0.7,
          },
        ],
      });

      const vo = LLMScheduleProposalVO.fromLLMResponse(raw);
      const filtered = vo.withMinConfidence(0.7);

      expect(filtered.count()).toBe(2);
      expect(filtered.getProposals().map((p) => p.shiftId)).toEqual([
        's1',
        's3',
      ]);
    });
  });
});
