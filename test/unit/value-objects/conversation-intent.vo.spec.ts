import { ConversationIntentVO } from '../../../src/domain/value-objects/conversation-intent.vo';
import { DomainError } from '../../../src/domain/errors/domain.error';

describe('ConversationIntentVO', () => {
  describe('create()', () => {
    it('should create a valid intent with entities', () => {
      const intent = ConversationIntentVO.create({
        intent: 'swap_shift',
        confidence: 0.9,
        entities: { targetEmployeePhone: '+1234567890', shiftId: 'shift-1' },
        rawText: 'Can I swap my shift with John?',
      });

      expect(intent.getIntent()).toBe('swap_shift');
      expect(intent.getConfidence()).toBe(0.9);
      expect(intent.getEntities()).toEqual({
        targetEmployeePhone: '+1234567890',
        shiftId: 'shift-1',
      });
      expect(intent.getRawText()).toBe('Can I swap my shift with John?');
    });

    it('should throw DomainError for an invalid intent type', () => {
      expect(() => {
        ConversationIntentVO.create({
          intent: 'invalid_intent' as any,
          confidence: 0.8,
          entities: {},
          rawText: 'Some text',
        });
      }).toThrow(DomainError);
    });

    it('should throw DomainError if confidence is out of bounds', () => {
      expect(() => {
        ConversationIntentVO.create({
          intent: 'swap_shift',
          confidence: -0.1,
          entities: {},
          rawText: 'text',
        });
      }).toThrow(DomainError);

      expect(() => {
        ConversationIntentVO.create({
          intent: 'swap_shift',
          confidence: 1.1,
          entities: {},
          rawText: 'text',
        });
      }).toThrow(DomainError);
    });

    it('should throw DomainError if rawText is empty or whitespace', () => {
      expect(() => {
        ConversationIntentVO.create({
          intent: 'swap_shift',
          confidence: 0.8,
          entities: {},
          rawText: '',
        });
      }).toThrow(DomainError);

      expect(() => {
        ConversationIntentVO.create({
          intent: 'swap_shift',
          confidence: 0.8,
          entities: {},
          rawText: '   ',
        });
      }).toThrow(DomainError);
    });
  });

  describe('unknown()', () => {
    it('should create an unknown intent with 0 confidence', () => {
      const intent = ConversationIntentVO.unknown('I need help');
      expect(intent.getIntent()).toBe('unknown');
      expect(intent.getConfidence()).toBe(0);
      expect(intent.getEntities()).toEqual({});
      expect(intent.getRawText()).toBe('I need help');
      expect(intent.isUnknown()).toBe(true);
      expect(intent.isActionable()).toBe(false);
    });
  });

  describe('isActionable()', () => {
    it('should return true for known intents with high confidence (>= 0.6)', () => {
      const intent = ConversationIntentVO.create({
        intent: 'check_schedule',
        confidence: 0.65,
        entities: {},
        rawText: 'When am I working?',
      });
      expect(intent.isActionable()).toBe(true);
    });

    it('should return false for known intents with low confidence (< 0.6)', () => {
      const intent = ConversationIntentVO.create({
        intent: 'check_schedule',
        confidence: 0.59,
        entities: {},
        rawText: 'working?',
      });
      expect(intent.isActionable()).toBe(false);
    });

    it('should return false for unknown intent regardless of confidence threshold', () => {
      const intent = ConversationIntentVO.unknown('what');
      expect(intent.isActionable()).toBe(false);
    });
  });

  describe('getMissingFields() & isComplete()', () => {
    it('should identify missing required fields', () => {
      const intent = ConversationIntentVO.create({
        intent: 'report_absence',
        confidence: 0.9,
        entities: { shiftId: 'shift-1' }, // Missing reason
        rawText: 'No puedo ir',
      });

      expect(intent.getMissingFields()).toEqual(['reason']);
      expect(intent.isComplete()).toBe(false);
    });

    it('should return empty array and isComplete = true when all fields are present', () => {
      const intent = ConversationIntentVO.create({
        intent: 'report_absence',
        confidence: 0.9,
        entities: { shiftId: 'shift-1', reason: 'Sick' },
        rawText: 'I am sick',
      });

      expect(intent.getMissingFields()).toEqual([]);
      expect(intent.isComplete()).toBe(true);
    });

    it('should always be complete for check_schedule (requires no entities)', () => {
      const intent = ConversationIntentVO.create({
        intent: 'check_schedule',
        confidence: 0.9,
        entities: {},
        rawText: 'My schedule',
      });

      expect(intent.isComplete()).toBe(true);
    });
  });
});
