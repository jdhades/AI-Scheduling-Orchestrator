import { EventBus } from '@nestjs/cqrs';
import { CreateSemanticRuleHandler } from '../../../src/application/handlers/create-semantic-rule.handler';
import { DeleteSemanticRuleHandler } from '../../../src/application/handlers/delete-semantic-rule.handler';
import { GetSemanticRulesHandler } from '../../../src/application/handlers/get-semantic-rules.handler';
import { CreateSemanticRuleCommand } from '../../../src/application/commands/create-semantic-rule.command';
import { DeleteSemanticRuleCommand } from '../../../src/application/commands/delete-semantic-rule.command';
import { GetSemanticRulesQuery } from '../../../src/application/queries/get-semantic-rules.query';
import type { IEmbeddingService } from '../../../src/domain/services/embedding.service.interface';
import type { ISemanticRuleRepository } from '../../../src/domain/repositories/semantic-rule.repository.interface';
import { SemanticRuleAggregate } from '../../../src/domain/aggregates/semantic-rule.aggregate';
import { RulePriority } from '../../../src/domain/value-objects/rule-priority.vo';
import { RuleType } from '../../../src/domain/value-objects/rule-type.vo';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makeMockEmbeddingService(vector?: number[]): jest.Mocked<IEmbeddingService> {
    return {
        generate: jest.fn().mockResolvedValue(vector ?? Array(768).fill(0.1)),
        generateBatch: jest.fn().mockResolvedValue([Array(768).fill(0.1)]),
    };
}

function makeMockRepository(): jest.Mocked<ISemanticRuleRepository> {
    return {
        save: jest.fn().mockResolvedValue(undefined),
        findById: jest.fn(),
        findAllByCompany: jest.fn().mockResolvedValue([]),
        findRelevantRules: jest.fn().mockResolvedValue([]),
        softDelete: jest.fn().mockResolvedValue(undefined),
    };
}

function makePersistedRule(id = 'rule-1', type: 'restriction' | 'preference' = 'restriction'): SemanticRuleAggregate {
    return SemanticRuleAggregate.create({
        id,
        ruleText: 'Regla de prueba persistida para testing de handlers',
        priority: RulePriority.legal(),
        ruleType: RuleType.create(type),
        companyId: 'company-1',
    });
}

function makeEventBusMock(): jest.Mocked<EventBus> {
    return { publish: jest.fn() } as unknown as jest.Mocked<EventBus>;
}

// ─── CreateSemanticRuleHandler ────────────────────────────────────────────────

describe('CreateSemanticRuleHandler', () => {
    let embeddingService: jest.Mocked<IEmbeddingService>;
    let repository: jest.Mocked<ISemanticRuleRepository>;
    let eventBus: jest.Mocked<EventBus>;
    let handler: CreateSemanticRuleHandler;

    beforeEach(() => {
        embeddingService = makeMockEmbeddingService();
        repository = makeMockRepository();
        eventBus = makeEventBusMock();
        handler = new CreateSemanticRuleHandler(embeddingService, repository, eventBus);
    });

    it('should create rule, generate embedding and persist it', async () => {
        const cmd = new CreateSemanticRuleCommand(
            'company-1',
            'Los empleados necesitan descanso de al menos 11 horas entre turnos',
            1,
            'restriction',
        );
        const result = await handler.execute(cmd);

        expect(result.id).toBeDefined();
        expect(result.embeddingGenerated).toBe(true);
        expect(embeddingService.generate).toHaveBeenCalledTimes(1);
        expect(repository.save).toHaveBeenCalledTimes(1);
        expect(eventBus.publish).toHaveBeenCalledTimes(1);
    });

    it('should persist rule even if embedding generation fails (resilience)', async () => {
        embeddingService.generate.mockRejectedValueOnce(new Error('Gemini API unavailable'));

        const cmd = new CreateSemanticRuleCommand(
            'company-1',
            'No se pueden asignar turnos nocturnos dos noches consecutivas',
            2,
            'preference',
        );
        const result = await handler.execute(cmd);

        expect(result.embeddingGenerated).toBe(false);
        expect(repository.save).toHaveBeenCalledTimes(1); // se persiste igual
        expect(eventBus.publish).toHaveBeenCalledTimes(1);
    });

    it('should pass correct priority and type to saved rule', async () => {
        const cmd = new CreateSemanticRuleCommand(
            'company-2',
            'Mínimo de experiencia requerida para turnos de noche de fin de semana',
            3,
            'requirement',
        );
        await handler.execute(cmd);

        const savedRule: SemanticRuleAggregate = (repository.save as jest.Mock).mock.calls[0][0];
        expect(savedRule.getPriority().getValue()).toBe(3);
        expect(savedRule.getRuleType().getValue()).toBe('requirement');
    });
});

// ─── DeleteSemanticRuleHandler ────────────────────────────────────────────────

describe('DeleteSemanticRuleHandler', () => {
    let repository: jest.Mocked<ISemanticRuleRepository>;
    let handler: DeleteSemanticRuleHandler;

    beforeEach(() => {
        repository = makeMockRepository();
        handler = new DeleteSemanticRuleHandler(repository);
    });

    it('should soft-delete an existing rule', async () => {
        repository.findById.mockResolvedValue(makePersistedRule('rule-to-delete'));

        const result = await handler.execute(
            new DeleteSemanticRuleCommand('rule-to-delete', 'company-1'),
        );

        expect(result.deleted).toBe(true);
        expect(repository.softDelete).toHaveBeenCalledWith('rule-to-delete', 'company-1');
    });

    it('should return deleted=false when rule does not exist', async () => {
        repository.findById.mockResolvedValue(null);

        const result = await handler.execute(
            new DeleteSemanticRuleCommand('non-existent', 'company-1'),
        );

        expect(result.deleted).toBe(false);
        expect(repository.softDelete).not.toHaveBeenCalled();
    });

    it('should not soft-delete rule from different company', async () => {
        repository.findById.mockResolvedValue(null); // null because different company in repo filter

        const result = await handler.execute(
            new DeleteSemanticRuleCommand('rule-1', 'wrong-company'),
        );

        expect(result.deleted).toBe(false);
    });
});

// ─── GetSemanticRulesHandler ──────────────────────────────────────────────────

describe('GetSemanticRulesHandler', () => {
    let repository: jest.Mocked<ISemanticRuleRepository>;
    let handler: GetSemanticRulesHandler;

    beforeEach(() => {
        repository = makeMockRepository();
        handler = new GetSemanticRulesHandler(repository);
    });

    it('should return empty array when company has no rules', async () => {
        repository.findAllByCompany.mockResolvedValue([]);
        const result = await handler.execute(new GetSemanticRulesQuery('company-empty'));
        expect(result).toEqual([]);
    });

    it('should map rules to SemanticRuleDto format', async () => {
        const rule = makePersistedRule('rule-1', 'restriction');
        repository.findAllByCompany.mockResolvedValue([rule]);

        const result = await handler.execute(new GetSemanticRulesQuery('company-1'));

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('rule-1');
        expect(result[0].ruleType).toBe('restriction');
        expect(result[0].priorityLevel).toBe(1);
        expect(result[0].hasEmbedding).toBe(false);
        expect(result[0].isActive).toBe(true);
    });

    it('should filter by ruleType when provided', async () => {
        const restriction = makePersistedRule('r1', 'restriction');
        const preference = makePersistedRule('r2', 'preference');
        repository.findAllByCompany.mockResolvedValue([restriction, preference]);

        const result = await handler.execute(new GetSemanticRulesQuery('company-1', 'restriction'));
        expect(result).toHaveLength(1);
        expect(result[0].ruleType).toBe('restriction');
    });

    it('should return all rules when no ruleType filter', async () => {
        const restriction = makePersistedRule('r1', 'restriction');
        const preference = makePersistedRule('r2', 'preference');
        repository.findAllByCompany.mockResolvedValue([restriction, preference]);

        const result = await handler.execute(new GetSemanticRulesQuery('company-1'));
        expect(result).toHaveLength(2);
    });
});
