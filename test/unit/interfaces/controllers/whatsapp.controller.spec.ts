import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';

// pg-boss v12+ es ESM-only y rompe Jest cuando lo carga transitivamente
// vía message-router → schedule-generation-dispatcher → pg-boss.service.
// Mockeamos los servicios que lo importan ANTES de cualquier import del
// controller (los `jest.mock` se hoistean al top del archivo).
jest.mock(
  '../../../../src/application/jobs/schedule-generation-dispatcher.service',
  () => ({
    ScheduleGenerationDispatcher: class {},
  }),
);
jest.mock('../../../../src/infrastructure/queue/pg-boss.service', () => ({
  PgBossService: class {},
}));

import { WhatsAppController } from '../../../../src/interfaces/controllers/whatsapp.controller';
import { TenantFeatureService } from '../../../../src/domain/services/tenant-feature.service';
import { MessageRouterService } from '../../../../src/application/conversational/message-router.service';
import {
  EMPLOYEE_REPOSITORY,
  IEmployeeRepository,
} from '../../../../src/domain/repositories/employee.repository';
import { WhatsappWebhookDto } from '../../../../src/interfaces/dtos/whatsapp-webhook.dto';
import { Employee } from '../../../../src/domain/aggregates/employee.aggregate';

const Twilio = require('twilio');

jest.mock('twilio', () => ({
  validateRequest: jest.fn(),
}));

describe('WhatsAppController', () => {
  let controller: WhatsAppController;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockMessageRouter: jest.Mocked<MessageRouterService>;
  let mockEmployeeRepo: jest.Mocked<IEmployeeRepository>;
  let mockTenantFeatures: jest.Mocked<TenantFeatureService>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'app.env') return 'production';
        if (key === 'twilio.accountSid') return 'sid123';
        if (key === 'twilio.authToken') return 'token123';
        if (key === 'twilio.webhookUrl') return 'https://test.com/webhook';
        return null;
      }),
    } as any;

    mockMessageRouter = {
      route: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockEmployeeRepo = {
      findByPhone: jest.fn(),
    } as any;

    // Default: feature flag whatsapp_inbound habilitado para que el
    // flow continúe. Tests específicos pueden re-mockearlo a false.
    mockTenantFeatures = {
      isEnabled: jest.fn().mockResolvedValue(true),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WhatsAppController],
      providers: [
        { provide: ConfigService, useValue: mockConfigService },
        { provide: MessageRouterService, useValue: mockMessageRouter },
        { provide: EMPLOYEE_REPOSITORY, useValue: mockEmployeeRepo },
        // SUPABASE_CLIENT se inyecta en el controller (Phase 18); el
        // test no toca DB así que basta con un stub vacío.
        { provide: 'SUPABASE_CLIENT', useValue: {} },
        { provide: TenantFeatureService, useValue: mockTenantFeatures },
      ],
    }).compile();

    controller = module.get<WhatsAppController>(WhatsAppController);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('should throw ForbiddenException if Twilio signature is invalid', async () => {
    (Twilio.validateRequest as jest.Mock).mockReturnValue(false);

    const dto = new WhatsappWebhookDto();
    const req = { body: dto } as any;

    await expect(
      controller.receive(req, 'invalid-sig', 'host.com'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should skip signature validation in test environment', async () => {
    mockConfigService.get.mockImplementation((key: string) => {
      if (key === 'app.env') return 'test';
      return null;
    });

    // Ensure Twilio validateRequest is NOT called
    (Twilio.validateRequest as jest.Mock).mockClear();

    const dto = new WhatsappWebhookDto();
    dto.From = 'whatsapp:+1234567890';

    const employee = { id: 'emp-1', companyId: 'comp-1' } as Employee;
    mockEmployeeRepo.findByPhone.mockResolvedValue(employee);

    const req = { body: dto } as any;
    await controller.receive(req, 'any-sig', 'host.com');

    expect(Twilio.validateRequest).not.toHaveBeenCalled();
    expect(mockEmployeeRepo.findByPhone).toHaveBeenCalledWith(
      '+1234567890',
      '*',
    );
  });

  it('should ignore webhooks without a valid From field', async () => {
    (Twilio.validateRequest as jest.Mock).mockReturnValue(true);
    const dto = new WhatsappWebhookDto();
    dto.From = '';

    const req = { body: dto } as any;
    await controller.receive(req, 'valid-sig', 'host.com');

    expect(mockEmployeeRepo.findByPhone).not.toHaveBeenCalled();
  });

  it('should ignore messages from unregistered numbers', async () => {
    (Twilio.validateRequest as jest.Mock).mockReturnValue(true);
    const dto = new WhatsappWebhookDto();
    dto.From = 'whatsapp:+11111111111';

    mockEmployeeRepo.findByPhone.mockResolvedValue(null);

    const req = { body: dto } as any;
    await controller.receive(req, 'valid-sig', 'host.com');

    expect(mockEmployeeRepo.findByPhone).toHaveBeenCalledWith(
      '+11111111111',
      '*',
    );
    expect(mockMessageRouter.route).not.toHaveBeenCalled();
  });

  it('should route the message asynchronously using setImmediate', async () => {
    (Twilio.validateRequest as jest.Mock).mockReturnValue(true);
    const dto = new WhatsappWebhookDto();
    dto.From = 'whatsapp:+1234567890';
    dto.Body = 'Hello';
    dto.MediaUrl0 = 'http://example.com/audio.ogg';
    dto.MediaContentType0 = 'audio/ogg';

    const employee = { id: 'emp-1', companyId: 'comp-1' } as Employee;
    mockEmployeeRepo.findByPhone.mockResolvedValue(employee);

    const req = { body: dto } as any;
    await controller.receive(req, 'valid-sig', 'host.com');

    // Router not called synchronously
    expect(mockMessageRouter.route).not.toHaveBeenCalled();

    // Let setImmediate run
    jest.runAllTimers();

    expect(mockMessageRouter.route).toHaveBeenCalledWith({
      from: '+1234567890',
      companyId: 'comp-1',
      employeeId: 'emp-1',
      body: 'Hello',
      mediaUrl: 'http://example.com/audio.ogg',
      mimeType: 'audio/ogg',
      twilioSid: 'sid123',
      twilioToken: 'token123',
    });
  });
});
