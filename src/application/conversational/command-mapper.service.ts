import { Injectable, Logger } from '@nestjs/common';
import {
    ConversationIntentVO,
    IntentEntities,
} from '../../domain/value-objects/conversation-intent.vo';
import { SwapShiftCommand } from '../commands/swap-shift.command';
import { ReportAbsenceCommand } from '../commands/report-absence.command';
import { RequestDayOffCommand } from '../commands/request-day-off.command';
import { GetMyScheduleQuery } from '../queries/get-my-schedule.query';
import { GenerateHybridScheduleCommand } from '../commands/generate-hybrid-schedule.command';

export interface CommandMapperResult {
    command: SwapShiftCommand | ReportAbsenceCommand | RequestDayOffCommand | GetMyScheduleQuery | GenerateHybridScheduleCommand | null;
    missingFields: string[];
    clarificationMessage: string | null;
}

/**
 * CommandMapperService
 *
 * Converts a ConversationIntentVO with sufficient entities into a CQRS Command.
 * If entities are missing, returns missingFields with a human-readable question.
 */
@Injectable()
export class CommandMapperService {
    private readonly logger = new Logger(CommandMapperService.name);

    map(
        intent: ConversationIntentVO,
        employeeId: string,
        companyId: string,
        mergedEntities: IntentEntities,
    ): CommandMapperResult {
        if (intent.isUnknown() || !intent.isActionable()) {
            return {
                command: null,
                missingFields: [],
                clarificationMessage:
                    '🤔 No entendí bien tu solicitud. Puedo ayudarte a:\n' +
                    '• Ver tu horario\n' +
                    '• Reportar una ausencia\n' +
                    '• Pedir intercambio de turno\n' +
                    '• Solicitar día libre\n' +
                    '• Generar el horario de la semana (managers)\n' +
                    '¿Qué necesitas?',
            };
        }

        const type = intent.getIntent();

        switch (type) {
            case 'check_schedule':
                return {
                    command: new GetMyScheduleQuery(employeeId, companyId),
                    missingFields: [],
                    clarificationMessage: null,
                };

            case 'swap_shift': {
                const missingFields: string[] = [];
                if (!mergedEntities.targetEmployeePhone) missingFields.push('targetEmployeePhone');
                if (!mergedEntities.shiftId) missingFields.push('shiftId');

                if (missingFields.length > 0) {
                    return {
                        command: null,
                        missingFields,
                        clarificationMessage: this._askForSwapFields(mergedEntities),
                    };
                }
                return {
                    command: new SwapShiftCommand(
                        employeeId,
                        mergedEntities.targetEmployeePhone!,
                        mergedEntities.shiftId!,
                        companyId,
                    ),
                    missingFields: [],
                    clarificationMessage: null,
                };
            }

            case 'report_absence': {
                const missingFields: string[] = [];
                if (!mergedEntities.shiftId) missingFields.push('shiftId');
                if (!mergedEntities.reason) missingFields.push('reason');

                if (missingFields.length > 0) {
                    return {
                        command: null,
                        missingFields,
                        clarificationMessage: this._askForAbsenceFields(mergedEntities),
                    };
                }
                return {
                    command: new ReportAbsenceCommand(
                        employeeId,
                        mergedEntities.shiftId!,
                        mergedEntities.reason!,
                        companyId,
                    ),
                    missingFields: [],
                    clarificationMessage: null,
                };
            }

            case 'request_day_off': {
                if (!mergedEntities.date) {
                    return {
                        command: null,
                        missingFields: ['date'],
                        clarificationMessage: '📅 ¿Para qué fecha quieres pedir el día libre? (ej: "el viernes 10 de marzo")',
                    };
                }
                return {
                    command: new RequestDayOffCommand(
                        employeeId,
                        mergedEntities.date,
                        mergedEntities.reason ?? 'No especificado',
                        companyId,
                    ),
                    missingFields: [],
                    clarificationMessage: null,
                };
            }

            case 'generate_schedule': {
                if (!mergedEntities.weekStart) {
                    // Default to next Monday if not specified
                    const nextMonday = this._getNextMonday();
                    return {
                        command: new GenerateHybridScheduleCommand(companyId, nextMonday),
                        missingFields: [],
                        clarificationMessage: null,
                    };
                }
                return {
                    command: new GenerateHybridScheduleCommand(companyId, mergedEntities.weekStart),
                    missingFields: [],
                    clarificationMessage: null,
                };
            }

            default:
                this.logger.warn(`Unhandled intent type: ${type}`);
                return { command: null, missingFields: [], clarificationMessage: null };
        }
    }

    private _askForSwapFields(entities: IntentEntities): string {
        if (!entities.targetEmployeePhone && !entities.shiftId) {
            return '🔄 Para el intercambio necesito saber:\n1️⃣ ¿El número de WhatsApp de tu compañero?\n2️⃣ ¿El ID del turno que quieres intercambiar?';
        }
        if (!entities.targetEmployeePhone) {
            return '🔄 ¿Cuál es el número de WhatsApp de tu compañero con quien quieres intercambiar?';
        }
        return '🔄 ¿Cuál es el ID del turno que quieres intercambiar?';
    }

    private _askForAbsenceFields(entities: IntentEntities): string {
        if (!entities.shiftId && !entities.reason) {
            return '⚠️ Para reportar tu ausencia necesito:\n1️⃣ ¿El ID del turno al que no puedes asistir?\n2️⃣ ¿Cuál es el motivo?';
        }
        if (!entities.shiftId) {
            return '⚠️ ¿Cuál es el ID del turno al que no puedes asistir?';
        }
        return '⚠️ ¿Cuál es el motivo de tu ausencia?';
    }

    /** Returns next Monday in YYYY-MM-DD format. Used when generate_schedule has no weekStart. */
    private _getNextMonday(): string {
        const d = new Date();
        const day = d.getDay();
        const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
        d.setDate(d.getDate() + daysUntilMonday);
        return d.toISOString().split('T')[0];
    }
}
