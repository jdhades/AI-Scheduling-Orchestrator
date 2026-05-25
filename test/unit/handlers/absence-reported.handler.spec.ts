import { AbsenceReportedHandler } from '../../../src/application/handlers/absence-reported.handler';
import { AbsenceReportedEvent } from '../../../src/domain/events/absence-reported.event';
import type { IEmployeeRepository } from '../../../src/domain/repositories/employee.repository';
import type { IShiftAssignmentRepository } from '../../../src/domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../../src/domain/repositories/shift-template.repository';
import type { ManagerNotificationService } from '../../../src/application/services/manager-notification.service';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';

/**
 * Tests del handler post Phase 17.5: el mensaje incluye nombre de empleado
 * + nombre/horario del/los turno(s) afectado(s) y la entrega delega en
 * `ManagerNotificationService.notifyManagerForEmployee()`. El handler ya
 * NO toca `NOTIFICATION_SERVICE` ni `MANAGER_WHATSAPP_NUMBER` — eso quedó
 * encapsulado en el ManagerNotificationService.
 */
describe('AbsenceReportedHandler', () => {
  let handler: AbsenceReportedHandler;
  let employeeRepo: jest.Mocked<IEmployeeRepository>;
  let assignmentRepo: jest.Mocked<IShiftAssignmentRepository>;
  let templateRepo: jest.Mocked<IShiftTemplateRepository>;
  let managerNotifications: jest.Mocked<ManagerNotificationService>;

  const employee = {
    id: 'emp-1',
    name: 'Jane Doe',
    phone: '+1234567890',
  } as unknown as Employee;

  beforeEach(() => {
    employeeRepo = {
      findById: jest.fn().mockResolvedValue(employee),
    } as unknown as jest.Mocked<IEmployeeRepository>;

    assignmentRepo = {
      findById: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<IShiftAssignmentRepository>;

    templateRepo = {
      findById: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<IShiftTemplateRepository>;

    managerNotifications = {
      notifyManagerForEmployee: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ManagerNotificationService>;

    handler = new AbsenceReportedHandler(
      employeeRepo,
      assignmentRepo,
      templateRepo,
      managerNotifications,
    );
  });

  it('renderea mensaje urgente con nombre del empleado y delega en ManagerNotificationService', async () => {
    // Con assignment afectado el handler sugiere reemplazo urgente.
    // Sin ninguno cae al mensaje "no había turnos" — eso se cubre en otro test.
    assignmentRepo.findById.mockResolvedValue({
      templateId: 'tpl-1',
      date: '2026-05-20',
    } as any);
    templateRepo.findById.mockResolvedValue({
      name: 'Morning',
      startTime: '08:00:00',
      endTime: '14:00:00',
    } as any);

    const event = new AbsenceReportedEvent(
      'emp-1',
      'shift-1',
      'Sick',
      'comp-1',
      true,
      '2026-05-20',
      '2026-05-20',
      ['assign-1'],
    );

    await handler.handle(event);

    expect(employeeRepo.findById).toHaveBeenCalledWith('emp-1', 'comp-1');
    expect(managerNotifications.notifyManagerForEmployee).toHaveBeenCalledTimes(
      1,
    );
    const [companyId, employeeId, message] =
      managerNotifications.notifyManagerForEmployee.mock.calls[0];
    expect(companyId).toBe('comp-1');
    expect(employeeId).toBe('emp-1');
    expect(message).toContain('🚨 *ALERTA URGENTE*');
    expect(message).toContain('Jane Doe');
    expect(message).toContain('+1234567890');
    expect(message).toContain('Sick');
    expect(message).toContain('🔴 Se necesita reemplazo urgente.');
  });

  it('renderea mensaje estándar (no urgent)', async () => {
    const event = new AbsenceReportedEvent(
      'emp-1',
      'shift-1',
      'Vacation',
      'comp-1',
      false,
    );

    await handler.handle(event);

    const [, , message] =
      managerNotifications.notifyManagerForEmployee.mock.calls[0];
    expect(message).toContain('⚠️ *Ausencia reportada*');
    expect(message).toContain('Vacation');
    // Sin assignments afectados, sugiere reasignar (no urgente).
    expect(message).toContain(
      'No había turnos asignados en ese período. El scheduler lo respetará al generar.',
    );
  });

  it('no notifica si el empleado no se encuentra', async () => {
    employeeRepo.findById.mockResolvedValue(null);

    const event = new AbsenceReportedEvent(
      'emp-1',
      'shift-1',
      'Sick',
      'comp-1',
      false,
    );
    await handler.handle(event);

    expect(
      managerNotifications.notifyManagerForEmployee,
    ).not.toHaveBeenCalled();
  });

  it('incluye listado de turnos afectados cuando los hay', async () => {
    assignmentRepo.findById.mockResolvedValue({
      templateId: 'tpl-1',
      date: '2026-05-20',
    } as any);
    templateRepo.findById.mockResolvedValue({
      name: 'Morning',
      startTime: '08:00:00',
      endTime: '14:00:00',
    } as any);

    const event = new AbsenceReportedEvent(
      'emp-1',
      'shift-1',
      'Sick',
      'comp-1',
      false,
      '2026-05-20',
      '2026-05-20',
      ['assign-1'],
    );

    await handler.handle(event);

    const [, , message] =
      managerNotifications.notifyManagerForEmployee.mock.calls[0];
    expect(message).toContain('*Turno afectado:*');
    expect(message).toContain('Morning · 2026-05-20 08:00–14:00');
    expect(message).toContain('Se necesita reasignar el/los turno(s).');
  });
});
