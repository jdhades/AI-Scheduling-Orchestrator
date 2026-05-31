import { ImportValidatorService } from '../../../src/application/imports/import-validator.service';
import type { ImportPayload } from '../../../src/domain/imports/import-payload.types';
import type { ResolvedReferences } from '../../../src/application/imports/import-reference-resolver.service';

function payloadWithEmployeeReferencingMissingDept(): ImportPayload {
  return {
    schemaVersion: '1.0.0',
    source: 'external_agent',
    sourceMetadata: {
      extractedAt: '2026-05-31T00:00:00Z',
      agentName: 'test',
    },
    data: {
      employees: [
        {
          externalId: 'e1',
          name: 'Alice',
          phone: '+15551234567',
          departmentExternalId: 'Kitchen',
        },
      ],
    },
    warnings: [],
  } as ImportPayload;
}

describe('ImportValidatorService — ref differentiation', () => {
  const validator = new ImportValidatorService();

  it('emits severity=warn when dept ref is not in payload and not resolved in DB', () => {
    const w = validator.validate(payloadWithEmployeeReferencingMissingDept());
    const refWarn = w.find(
      (x) => x.code === 'IMPORT_EMPLOYEE_DEPT_NOT_IN_PAYLOAD',
    );
    expect(refWarn).toBeDefined();
    expect(refWarn?.severity).toBe('warn');
  });

  it('emits severity=info when dept ref resolves in DB (resolved map)', () => {
    const resolved: ResolvedReferences = {
      employees: new Map(),
      departments: new Map([['Kitchen', 'dept-uuid-real']]),
      roles: new Map(),
      branches: new Map(),
    };
    const w = validator.validate(
      payloadWithEmployeeReferencingMissingDept(),
      resolved,
    );
    const refWarn = w.find(
      (x) => x.code === 'IMPORT_EMPLOYEE_DEPT_RESOLVED_IN_DB',
    );
    expect(refWarn).toBeDefined();
    expect(refWarn?.severity).toBe('info');
    expect(
      w.find((x) => x.code === 'IMPORT_EMPLOYEE_DEPT_NOT_IN_PAYLOAD'),
    ).toBeUndefined();
  });
});
