import { Injectable, Logger } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import {
  ConversationIntentVO,
  IntentEntities,
} from '../../domain/value-objects/conversation-intent.vo';
import { ReportAbsenceCommand } from '../commands/report-absence.command';
import { RequestDayOffCommand } from '../commands/request-day-off.command';
import { GetMyScheduleQuery } from '../queries/get-my-schedule.query';
import { GenerateHybridScheduleCommand } from '../commands/generate-hybrid-schedule.command';
import { CreateSemanticRuleCommand } from '../commands/create-semantic-rule.command';

export interface CommandMapperResult {
  command:
    | ReportAbsenceCommand
    | RequestDayOffCommand
    | GetMyScheduleQuery
    | GenerateHybridScheduleCommand
    | CreateSemanticRuleCommand
    | null;
  missingFields: string[];
  clarificationMessage: string | null;
  actionRequired?:
    | 'FETCH_SHIFTS'
    | 'SWAP_SELECT_SHIFT'
    | 'GENERATE_SELECT_TEMPLATE'
    | null;
}

/**
 * CommandMapperService
 *
 * Converts a ConversationIntentVO with sufficient entities into a CQRS Command.
 * If entities are missing, returns missingFields with a human-readable question.
 *
 * El dispatcher `map()` solo decide qué handler invocar por `intent.type`;
 * cada `_mapX` encapsula la lógica de su intent (missing-field checks +
 * construcción del Command). Pattern: un handler por intent, fácil de
 * sumar/quitar/testear independientemente.
 */
@Injectable()
export class CommandMapperService {
  private readonly logger = new Logger(CommandMapperService.name);

  constructor(private readonly i18n: I18nService) {}

  map(
    intent: ConversationIntentVO,
    employeeId: string,
    companyId: string,
    mergedEntities: IntentEntities,
    locale: string = 'es',
  ): CommandMapperResult {
    if (intent.getIntent() === 'system_unavailable') {
      return {
        command: null,
        missingFields: [],
        clarificationMessage: this.i18n.t('bot.general.system_unavailable', {
          lang: locale,
          defaultValue:
            '⚠️ El sistema de IA no está disponible temporalmente debido a alta demanda. Por favor, intenta enviar tu mensaje nuevamente en unos minutos.',
        }),
      };
    }

    if (intent.isUnknown() || !intent.isActionable()) {
      return {
        command: null,
        missingFields: [],
        clarificationMessage: this.i18n.t('bot.general.unknown_intent', {
          lang: locale,
        }),
      };
    }

    const type = intent.getIntent();
    switch (type) {
      case 'check_schedule':
        return this._mapCheckSchedule(
          employeeId,
          companyId,
          mergedEntities,
          locale,
        );
      case 'swap_shift':
        return this._mapSwapShift();
      case 'report_absence':
        return this._mapReportAbsence(
          employeeId,
          companyId,
          mergedEntities,
          locale,
        );
      case 'request_day_off':
        return this._mapRequestDayOff(
          employeeId,
          companyId,
          mergedEntities,
          locale,
        );
      case 'generate_schedule':
        return this._mapGenerateSchedule();
      case 'create_rule':
        return this._mapCreateRule(
          employeeId,
          companyId,
          mergedEntities,
          locale,
        );
      default:
        this.logger.warn(`Unhandled intent type: ${type}`);
        return { command: null, missingFields: [], clarificationMessage: null };
    }
  }

  private _mapCheckSchedule(
    employeeId: string,
    companyId: string,
    entities: IntentEntities,
    locale: string,
  ): CommandMapperResult {
    return {
      command: new GetMyScheduleQuery(
        employeeId,
        companyId,
        entities.weekStart || entities.date,
        locale,
      ),
      missingFields: [],
      clarificationMessage: null,
    };
  }

  private _mapSwapShift(): CommandMapperResult {
    return {
      command: null,
      missingFields: [],
      clarificationMessage: null,
      actionRequired: 'SWAP_SELECT_SHIFT',
    };
  }

  private _mapReportAbsence(
    employeeId: string,
    companyId: string,
    entities: IntentEntities,
    locale: string,
  ): CommandMapperResult {
    const missingFields: string[] = [];
    if (!entities.shiftId) missingFields.push('shiftId');
    if (!entities.reason) missingFields.push('reason');

    if (missingFields.length > 0) {
      // Falta el shift: redirigir al flow FETCH_SHIFTS para que el bot
      // muestre la lista al user y pueda elegir uno (cubrir ambos casos:
      // solo falta shiftId, y falta shiftId + reason).
      if (missingFields.includes('shiftId')) {
        return {
          command: null,
          missingFields,
          clarificationMessage: null,
          actionRequired: 'FETCH_SHIFTS',
        };
      }
      // Solo falta reason: pedirlo en chat.
      return {
        command: null,
        missingFields,
        clarificationMessage: this._askForAbsenceFields(entities, locale),
      };
    }

    return {
      command: new ReportAbsenceCommand(
        employeeId,
        // `entities.shiftId` ahora transporta el UUID de la assignment (nuevo modelo).
        entities.shiftId!,
        entities.reason!,
        companyId,
      ),
      missingFields: [],
      clarificationMessage: null,
    };
  }

  private _mapRequestDayOff(
    employeeId: string,
    companyId: string,
    entities: IntentEntities,
    locale: string,
  ): CommandMapperResult {
    if (!entities.date) {
      return {
        command: null,
        missingFields: ['date'],
        clarificationMessage: this.i18n.t('bot.day_off.missing_date', {
          lang: locale,
        }),
      };
    }
    return {
      command: new RequestDayOffCommand(
        employeeId,
        entities.date,
        entities.reason ?? 'No especificado',
        companyId,
      ),
      missingFields: [],
      clarificationMessage: null,
    };
  }

  private _mapGenerateSchedule(): CommandMapperResult {
    return {
      command: null,
      missingFields: [],
      clarificationMessage: null,
      actionRequired: 'GENERATE_SELECT_TEMPLATE',
    };
  }

  private _mapCreateRule(
    employeeId: string,
    companyId: string,
    entities: IntentEntities,
    locale: string,
  ): CommandMapperResult {
    if (!entities.ruleText) {
      return {
        command: null,
        missingFields: ['ruleText'],
        clarificationMessage: this.i18n.t('bot.rules.missing_text', {
          lang: locale,
        }),
      };
    }

    let expiresAt: Date | undefined;
    if (entities.expiresAt) {
      // Si el LLM devolvió un YYYY-MM-DD, creamos la expiración hacia el final de ese día UTC
      expiresAt = new Date(`${entities.expiresAt}T23:59:59Z`);
    }

    return {
      command: new CreateSemanticRuleCommand(
        companyId,
        entities.ruleText,
        2, // Priority 2: semantic
        'restriction',
        employeeId, // createdBy
        undefined, // metadata
        expiresAt,
      ),
      missingFields: [],
      clarificationMessage: null,
    };
  }

  private _askForAbsenceFields(
    entities: IntentEntities,
    locale: string,
  ): string {
    if (!entities.shiftId && !entities.reason) {
      return this.i18n.t('bot.absence.missing_both', { lang: locale });
    }
    if (!entities.shiftId) {
      return this.i18n.t('bot.absence.missing_shift', { lang: locale });
    }
    return this.i18n.t('bot.absence.missing_reason', { lang: locale });
  }
}
