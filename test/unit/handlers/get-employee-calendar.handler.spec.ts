import { GetEmployeeCalendarHandler } from '../../../src/application/handlers/get-employee-calendar.handler';
import { GetEmployeeCalendarQuery } from '../../../src/application/queries/get-employee-calendar.query';
import type { IShiftAssignmentRepository } from '../../../src/domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../../src/domain/repositories/shift-template.repository';

describe('GetEmployeeCalendarHandler', () => {
  let handler: GetEmployeeCalendarHandler;
  let mockRepo: jest.Mocked<IShiftAssignmentRepository>;
  let mockTemplateRepo: jest.Mocked<IShiftTemplateRepository>;

  beforeEach(() => {
    mockRepo = {
      save: jest.fn(),
      deleteById: jest.fn(),
      deleteByDateRange: jest.fn(),
      findById: jest.fn(),
      findByEmployeeAndDateRange: jest.fn().mockResolvedValue([]),
      findByCompanyAndDateRange: jest.fn(),
      findBySlot: jest.fn(),
      resolveShortId: jest.fn(),
    } as any;
    mockTemplateRepo = {
      findAllByCompany: jest.fn().mockResolvedValue([]),
    } as any;
    // Sin assignments (mock devuelve []) el handler no consulta supabase.
    const mockSupabase = { from: jest.fn() } as any;
    handler = new GetEmployeeCalendarHandler(
      mockRepo,
      mockTemplateRepo,
      mockSupabase,
    );
  });

  it('returns an array from the repository and normalizes the date range', async () => {
    const result = await handler.execute(
      new GetEmployeeCalendarQuery(
        'employee-1',
        'company-1',
        new Date('2024-01-01'),
        new Date('2024-01-31'),
      ),
    );

    expect(Array.isArray(result)).toBe(true);
    expect(mockRepo.findByEmployeeAndDateRange).toHaveBeenCalledWith(
      'employee-1',
      'company-1',
      '2024-01-01',
      '2024-01-31',
    );
  });

  it('enforces tenant isolation via companyId', async () => {
    await handler.execute(
      new GetEmployeeCalendarQuery(
        'emp-1',
        'co-1',
        new Date('2024-02-01'),
        new Date('2024-02-28'),
      ),
    );

    expect(mockRepo.findByEmployeeAndDateRange).toHaveBeenCalledWith(
      'emp-1',
      'co-1',
      '2024-02-01',
      '2024-02-28',
    );
  });
});
