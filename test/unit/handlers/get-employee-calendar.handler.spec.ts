import { GetEmployeeCalendarHandler } from '../../../src/application/handlers/get-employee-calendar.handler';
import { GetEmployeeCalendarQuery } from '../../../src/application/queries/get-employee-calendar.query';
import type { IShiftRepository } from '../../../src/domain/repositories/shift.repository';

/**
 * 🧪 UNIT TEST: GetEmployeeCalendarHandler
 *
 * El handler devuelve las asignaciones del empleado para un rango de fechas.
 * Mockeamos IShiftRepository para verificar que se llama correctamente.
 */
describe('GetEmployeeCalendarHandler', () => {
    let handler: GetEmployeeCalendarHandler;
    let mockShiftRepo: jest.Mocked<IShiftRepository>;

    beforeEach(() => {
        mockShiftRepo = {
            save: jest.fn(),
            findByCompanyAndWeek: jest.fn(),
            saveAssignment: jest.fn(),
            findAssignmentsByEmployee: jest.fn().mockResolvedValue([]),
            findAssignmentsByCompanyAndWeek: jest.fn(),
        };
        handler = new GetEmployeeCalendarHandler(mockShiftRepo);
    });

    it('should return an array from the repository', async () => {
        const query = new GetEmployeeCalendarQuery(
            'employee-1',
            'company-1',
            new Date('2024-01-01'),
            new Date('2024-01-31'),
        );

        const result = await handler.execute(query);

        expect(Array.isArray(result)).toBe(true);
        expect(mockShiftRepo.findAssignmentsByEmployee).toHaveBeenCalledWith(
            'employee-1',
            'company-1',
            expect.any(Date),
            expect.any(Date),
        );
    });

    it('should pass companyId for multi-tenant isolation', async () => {
        const query = new GetEmployeeCalendarQuery('emp-1', 'co-1', new Date(), new Date());

        await handler.execute(query);

        expect(mockShiftRepo.findAssignmentsByEmployee).toHaveBeenCalledWith(
            'emp-1', 'co-1', expect.any(Date), expect.any(Date),
        );
    });
});
