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
  actionRequired?: 'FETCH_SHIFTS' | 'SWAP_SELECT_SHIFT' | 'GENERATE_SELECT_TEMPLATE' | null;
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
        clarificationMessage: this.i18n.t('bot.general.system_unavailable', { lang: locale, defaultValue: '⚠️ El sistema de IA no está disponible temporalmente debido a alta demanda. Por favor, intenta enviar tu mensaje nuevamente en unos minutos.' }),
      };
    }

    if (intent.isUnknown() || !intent.isActionable()) {
      return {
        command: null,
        missingFields: [],
        clarificationMessage: this.i18n.t('bot.general.unknown_intent', { lang: locale }),
      };
    }

    const type = intent.getIntent();

    switch (type) {
      case 'check_schedule':
        return {
          command: new GetMyScheduleQuery(
            employeeId,
            companyId,
            mergedEntities.weekStart || mergedEntities.date,
            locale,
          ),
          missingFields: [],
          clarificationMessage: null,
        };

      case 'swap_shift': {
        return {
          command: null,
          missingFields: [],
          clarificationMessage: null,
          actionRequired: 'SWAP_SELECT_SHIFT',
        };
      }

      case 'report_absence': {
        const missingFields: string[] = [];
        if (!mergedEntities.shiftId) missingFields.push('shiftId');
        if (!mergedEntities.reason) missingFields.push('reason');

        if (missingFields.length > 0) {
          const onlyMissingShift =
            missingFields.length === 1 && missingFields[0] === 'shiftId';

          if (onlyMissingShift || missingFields.includes('shiftId')) {
            return {
              command: null,
              missingFields,
              clarificationMessage: null,
              actionRequired: 'FETCH_SHIFTS',
            };
          }

          return {
            command: null,
            missingFields,
            clarificationMessage: this._askForAbsenceFields(mergedEntities, locale),
          };
        }
        return {
          command: new ReportAbsenceCommand(
            employeeId,
            // `entities.shiftId` ahora transporta el UUID de la assignment (nuevo modelo).
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
            clarificationMessage: this.i18n.t('bot.day_off.missing_date', { lang: locale }),
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
        return {
          command: null,
          missingFields: [],
          clarificationMessage: null,
          actionRequired: 'GENERATE_SELECT_TEMPLATE',
        };
      }

      case 'create_rule': {
        if (!mergedEntities.ruleText) {
          return {
            command: null,
            missingFields: ['ruleText'],
            clarificationMessage: this.i18n.t('bot.rules.missing_text', { lang: locale }),
          };
        }

        let expiresAt: Date | undefined;
        if (mergedEntities.expiresAt) {
          // Si el LLM devolvió un YYYY-MM-DD, creamos la expiración hacia el final de ese día UTC
          expiresAt = new Date(`${mergedEntities.expiresAt}T23:59:59Z`);
        }

        return {
          command: new CreateSemanticRuleCommand(
            companyId,
            mergedEntities.ruleText,
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

      default:
        this.logger.warn(`Unhandled intent type: ${type}`);
        return { command: null, missingFields: [], clarificationMessage: null };
    }
  }

  private _askForAbsenceFields(entities: IntentEntities, locale: string): string {
    if (!entities.shiftId && !entities.reason) {
      return this.i18n.t('bot.absence.missing_both', { lang: locale });
    }
    if (!entities.shiftId) {
      return this.i18n.t('bot.absence.missing_shift', { lang: locale });
    }
    return this.i18n.t('bot.absence.missing_reason', { lang: locale });
  }

}
