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
        if (mergedEntities.durationStr) {
          expiresAt = this._parseDurationAsDate(mergedEntities.durationStr);
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

  /** Returns next Monday in YYYY-MM-DD format. Used when generate_schedule has no weekStart. */
  private _getNextMonday(): string {
    const d = new Date();
    const day = d.getDay();
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMonday);
    return d.toISOString().split('T')[0];
  }

  /**
   * Naively maps conversational duration strings (extracted by Gemini) to future
   * dates. If it fails to parse, it returns undefined (null expiration).
   */
  private _parseDurationAsDate(durationStr: string): Date | undefined {
    const text = durationStr.toLowerCase();
    const d = new Date();
    
    if (text.includes('mes') || text.includes('month')) {
      const numMatch = text.match(/\d+/);
      const months = numMatch ? parseInt(numMatch[0], 10) : 1;
      d.setMonth(d.getMonth() + months);
      return d;
    }
    
    if (text.includes('semana') || text.includes('week')) {
      const numMatch = text.match(/\d+/);
      const weeks = numMatch ? parseInt(numMatch[0], 10) : 1;
      d.setDate(d.getDate() + (weeks * 7));
      return d;
    }
    
    if (text.match(/d[íi]a|day|hoy|today|ma[ñn]ana|tomorrow/)) {
      const numMatch = text.match(/\d+/);
      let days = numMatch ? parseInt(numMatch[0], 10) : 1;
      if (text.includes('mañana') || text.includes('tomorrow')) days = 1;
      if (text.includes('hoy') || text.includes('today')) days = 0;
      
      d.setDate(d.getDate() + days);
      // set to end of day
      d.setHours(23, 59, 59, 999);
      return d;
    }
    
    return undefined;
  }
}
