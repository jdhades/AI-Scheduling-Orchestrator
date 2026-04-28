import { IncidentId } from '../../../../src/domain/value-objects/incident-id.vo';
import { DomainError } from '../../../../src/domain/errors/domain.error';
import { randomUUID } from 'crypto';

describe('IncidentId Value Object', () => {
  it('should create a valid IncidentId', () => {
    const id = IncidentId.create();
    expect(id).toBeDefined();
    expect(id.value).toBeDefined();
  });

  it('should create from a valid UUID string', () => {
    const uuid = randomUUID();
    const id = IncidentId.fromString(uuid);
    expect(id.value).toBe(uuid);
  });

  it('should throw an error for an invalid UUID string', () => {
    expect(() => IncidentId.fromString('not-a-uuid')).toThrow(DomainError);
    expect(() => IncidentId.fromString('not-a-uuid')).toThrow(
      'Invalid Incident ID format',
    );
  });

  it('should be equal to another IncidentId with the same value', () => {
    const uuid = randomUUID();
    const id1 = IncidentId.fromString(uuid);
    const id2 = IncidentId.fromString(uuid);
    expect(id1.equals(id2)).toBe(true);
  });

  it('should not be equal to another IncidentId with a different value', () => {
    const id1 = IncidentId.create();
    const id2 = IncidentId.create();
    expect(id1.equals(id2)).toBe(false);
  });
});
