import { PolicyInterpreterRegistry } from '../../../../src/domain/services/policy-interpreter-registry';
import type {
  PolicyEvaluationContext,
  PolicyInterpreter,
  PolicyViolation,
} from '../../../../src/domain/services/policy-interpreter.interface';

const makeStub = (
  id: string,
  matchPattern: RegExp,
): PolicyInterpreter<{ raw: string }> => ({
  id,
  description: `stub:${id}`,
  matches: (text: string) => matchPattern.test(text),
  extractParams: async (text: string) => ({ raw: text }),
  apply: (_ctx: PolicyEvaluationContext): PolicyViolation[] => [],
  format: (params) => `[${id}] ${params.raw}`,
});

describe('PolicyInterpreterRegistry', () => {
  it('registra interpreters y los expone por id', () => {
    const a = makeStub('alpha', /alpha/);
    const b = makeStub('beta', /beta/);

    const reg = new PolicyInterpreterRegistry([a, b]);

    expect(reg.getAvailableIds().sort()).toEqual(['alpha', 'beta']);
    expect(reg.getById('alpha')).toBe(a);
    expect(reg.getById('inexistente')).toBeNull();
  });

  it('findMatch devuelve el primer interpreter con matches=true', () => {
    const a = makeStub('alpha', /alpha/);
    const b = makeStub('beta', /beta/);

    const reg = new PolicyInterpreterRegistry([a, b]);

    expect(reg.findMatch('contiene alpha texto')).toBe(a);
    expect(reg.findMatch('texto con beta')).toBe(b);
    expect(reg.findMatch('nada relevante')).toBeNull();
  });

  it('respeta el orden de registro cuando dos pueden matchear', () => {
    const a = makeStub('alpha', /común/);
    const b = makeStub('beta', /común/);

    const reg = new PolicyInterpreterRegistry([a, b]);

    expect(reg.findMatch('texto con palabra común')).toBe(a);
  });

  it('rechaza ids duplicados al construir', () => {
    const a = makeStub('dup', /a/);
    const b = makeStub('dup', /b/);

    expect(() => new PolicyInterpreterRegistry([a, b])).toThrow(
      /duplicate interpreter id "dup"/,
    );
  });

  it('soporta ser inicializado vacío (Optional inject)', () => {
    const reg = new PolicyInterpreterRegistry();

    expect(reg.getAvailableIds()).toEqual([]);
    expect(reg.findMatch('cualquier cosa')).toBeNull();
  });
});
