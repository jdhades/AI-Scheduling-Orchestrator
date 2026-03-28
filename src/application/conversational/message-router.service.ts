import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { IConversationalService } from '../../domain/services/conversational.service.interface';
import { CONVERSATIONAL_SERVICE } from '../../domain/services/conversational.service.interface';
import type { INotificationService } from '../../domain/services/notification.service';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import { ConversationSessionRepository } from '../../infrastructure/conversational/conversation-session.repository';
import { ConversationSessionVO } from '../../domain/value-objects/conversation-session.vo';
import { ConversationIntentVO } from '../../domain/value-objects/conversation-intent.vo';
import { GetMyScheduleQuery } from '../queries/get-my-schedule.query';
import { GetUpcomingShiftsQuery } from '../queries/get-upcoming-shifts.query';
import type { UpcomingShiftDto } from '../handlers/get-upcoming-shifts.handler';
import { CommandMapperService } from './command-mapper.service';
import { SwapShiftCommand } from '../commands/swap-shift.command';
import { ReportAbsenceCommand } from '../commands/report-absence.command';
import { I18nService } from 'nestjs-i18n';

export interface IncomingMessage {
  from: string; // E.164 phone number of sender
  companyId: string; // resolved from DB via phone lookup
  employeeId: string; // resolved from DB
  body?: string; // text body (if text message)
  mediaUrl?: string; // Twilio media URL (if audio/image)
  mimeType?: string; // MIME type of the media
  twilioSid: string; // for Basic Auth when downloading audio
  twilioToken: string;
}

/**
 * MessageRouterService
 *
 * Orchestrates the full incoming-message pipeline:
 * 1. Detect message type (text | audio | unsupported)
 * 2. Call IConversationalService for classification
 * 3. Merge with existing Redis session (multi-turn)
 * 4. Map intent to CQRS Command
 * 5. Execute command / query
 * 6. Fire-and-forget WhatsApp reply
 */
@Injectable()
export class MessageRouterService {
  private readonly logger = new Logger(MessageRouterService.name);

  constructor(
    @Inject(CONVERSATIONAL_SERVICE)
    private readonly conversationalService: IConversationalService,
    @Inject(NOTIFICATION_SERVICE)
    private readonly notificationService: INotificationService,
    @Inject(SHIFT_REPOSITORY)
    private readonly shiftRepo: IShiftRepository,
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    private readonly sessionRepository: ConversationSessionRepository,
    private readonly commandMapper: CommandMapperService,
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly i18n: I18nService,
  ) {}

  async route(msg: IncomingMessage): Promise<void> {
    const { from, employeeId, companyId } = msg;
    let locale = 'es';

    try {
      // 1. Detect type and classify intent
      const intent = await this._classifyMessage(msg);
      
      const employee = await this.employeeRepo.findById(employeeId, companyId);
      if (employee?.locale) {
        locale = employee.locale;
      }

      // 2. Load or create session, merge entities
      let session = await this.sessionRepository.getSession(from);
      if (!session) {
        session = ConversationSessionVO.create({
          employeePhone: from,
          companyId,
        });
      }

      const intentEntities = intent.getEntities();
      const sessionEntities = session.getCollectedEntities();
      let mergedEntities = { ...sessionEntities, ...intentEntities };

      let currentIntent = intent.getIntent();

      // Context Retention: If NLP loses context answering a clarification, inherit pending intent
      if ((currentIntent === 'unknown' || currentIntent === session.getPendingIntent()) && session.getPendingIntent()) {
          currentIntent = session.getPendingIntent()!;
          
          // Harvest the raw text as the reason if it was missing 
          if (currentIntent === 'report_absence' && !mergedEntities.reason) {
              mergedEntities.reason = intent.getRawText().trim();
          }
      }

      // Handle Option Selection for report_absence
      if (
        currentIntent === 'select_option' &&
        sessionEntities.pendingAction === 'report_absence'
      ) {
        const selection = intentEntities.selection?.toLowerCase() || '';

        if (sessionEntities.pendingConfirmationShiftId) {
          if (['sí', 'si', 'yes', 'y', '1'].includes(selection)) {
            mergedEntities.shiftId = sessionEntities.pendingConfirmationShiftId;
            currentIntent = 'report_absence';
          } else if (['no', 'n'].includes(selection)) {
            await this.sessionRepository.clearSession(from);
            this._reply(
              from,
              this.i18n.t('bot.absence.cancelled', { lang: locale }),
            );
            return;
          }
        } else if (sessionEntities[`option${selection}_shiftId`]) {
          mergedEntities.shiftId =
            sessionEntities[`option${selection}_shiftId`];
          currentIntent = 'report_absence';
        } else {
          this._reply(
            from,
            this.i18n.t('bot.general.invalid_choice', { lang: locale }),
          );
          return;
        }
      }

      // Handle Option Selection for swap_shift (multi-step)
      if (
        (currentIntent === 'select_option' || currentIntent === 'unknown') &&
        sessionEntities.pendingAction === 'swap_shift'
      ) {
        const rawText = intent.getRawText().trim().toLowerCase();
        const selection = intentEntities.selection?.toLowerCase() || rawText;

        const handled = await this._handleSwapSelection(
          from,
          employeeId,
          companyId,
          session,
          sessionEntities,
          selection,
          locale,
        );
        if (handled) return;
      }

      const pseudoIntent = ConversationIntentVO.create({
        intent: currentIntent,
        confidence: 1, // assume high confidence for internal processing
        entities: mergedEntities,
        rawText: intent.getRawText(),
      });

      // Update session
      session = session.withIntent(currentIntent, mergedEntities);

      // 3. Map to command
      const mapResult = this.commandMapper.map(
        pseudoIntent,
        employeeId,
        companyId,
        mergedEntities,
        locale,
      );

      // 4a. Handle SWAP_SELECT_SHIFT — start the guided swap flow
      if (mapResult.actionRequired === 'SWAP_SELECT_SHIFT') {
        await this._startSwapFlow(from, employeeId, companyId, session, mergedEntities, locale);
        return;
      }

      // 4b. Handle FETCH_SHIFTS (report_absence flow)
      if (mapResult.actionRequired === 'FETCH_SHIFTS') {
        const rawShifts = await this.queryBus.execute<
          GetUpcomingShiftsQuery,
          UpcomingShiftDto[]
        >(new GetUpcomingShiftsQuery(employeeId, companyId, 5));

        if (rawShifts.length === 0) {
          this._reply(
            from,
            this.i18n.t('bot.absence.no_shifts', { lang: locale }),
          );
          return;
        }

        // Filter shifts based on NLP extractions
        let filteredShifts = rawShifts;
        if (mergedEntities.date) {
          filteredShifts = filteredShifts.filter((s) =>
            new Date(s.startTime)
              .toISOString()
              .startsWith(mergedEntities.date!),
          );
        }
        if (mergedEntities.timeOfDay && filteredShifts.length > 1) {
          filteredShifts = filteredShifts.filter((s) => {
            const h = new Date(s.startTime).getHours();
            if (mergedEntities.timeOfDay === 'morning') return h < 12;
            if (mergedEntities.timeOfDay === 'afternoon')
              return h >= 12 && h < 18;
            if (mergedEntities.timeOfDay === 'night') return h >= 18;
            return true;
          });
        }
        const shifts = filteredShifts.length > 0 ? filteredShifts : rawShifts;

        if (shifts.length === 1) {
          const shift = shifts[0];
          const dateStr = new Date(shift.startTime).toLocaleDateString(
            'es-ES',
            {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            },
          );
          const startHora = new Date(shift.startTime).toLocaleTimeString(
            'es-ES',
            { hour: '2-digit', minute: '2-digit' },
          );
          const endHora = new Date(shift.endTime).toLocaleTimeString('es-ES', {
            hour: '2-digit',
            minute: '2-digit',
          });
          const startStr = `${dateStr}, de ${startHora} a ${endHora}`;
          session = session.withIntent('report_absence', {
            ...mergedEntities,
            pendingAction: 'report_absence',
            pendingConfirmationShiftId: shift.shiftId,
          });
          await this.sessionRepository.saveSession(session);

          let resp = this.i18n.t('bot.absence.confirm_single_shift', { 
            lang: locale, 
            args: { 
              shiftStr: startStr,
              reasonPrompt: mergedEntities.reason ? '' : this.i18n.t('bot.absence.reason_prompt', { lang: locale })
            }
          });
          this._reply(from, resp.trim());
          return;
        }

        // Multiple shifts -> List options
        let responseText = this.i18n.t('bot.absence.select_shift', { lang: locale });
        const optionsEntities: Record<string, string> = {
          pendingAction: 'report_absence',
        };
        shifts.slice(0, 3).forEach((shift, index) => {
          const num = index + 1;
          const dateStr = new Date(shift.startTime).toLocaleDateString(
            'es-ES',
            {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            },
          );
          const startHora = new Date(shift.startTime).toLocaleTimeString(
            'es-ES',
            { hour: '2-digit', minute: '2-digit' },
          );
          const endHora = new Date(shift.endTime).toLocaleTimeString('es-ES', {
            hour: '2-digit',
            minute: '2-digit',
          });
          const ds = `${dateStr}, de ${startHora} a ${endHora}`;
          responseText += `${num}. ${ds}\n`;
          optionsEntities[`option${num}_shiftId`] = shift.shiftId;
        });

        session = session.withIntent('report_absence', {
          ...mergedEntities,
          ...optionsEntities,
        });
        await this.sessionRepository.saveSession(session);

        if (!mergedEntities.reason) {
          responseText += this.i18n.t('bot.absence.reason_prompt_inline', { lang: locale });
        }

        this._reply(from, responseText.trim());
        return;
      }

      if (mapResult.clarificationMessage) {
        // Missing fields — save session state and ask the user
        await this.sessionRepository.saveSession(session);
        this._reply(from, mapResult.clarificationMessage);
        return;
      }

      if (!mapResult.command) {
        this._reply(
          from,
          this.i18n.t('bot.general.clarification', { lang: locale }),
        );
        return;
      }

      // 5. Resolve short shift IDs to full UUIDs before executing
      const command = await this._resolveShortShiftId(
        mapResult.command,
        companyId,
        from,
        locale,
      );
      if (!command) return; // resolution failed, user was notified

      // 6. Execute command/query
      const result = await this._execute(command);
      await this.sessionRepository.clearSession(from);

      // 7. Reply to user
      const reply =
        typeof result === 'string'
          ? result
          : this.i18n.t('bot.general.success', { lang: locale });
      this._reply(from, reply);
    } catch (err) {
      this.logger.error(
        `[route] Error processing message from ${from}: ${(err as Error).message}`,
      );
      this._reply(
        from,
        this.i18n.t('bot.general.error', { lang: locale }),
      );
    }
  }

  // ─── Swap Flow Helpers ───────────────────────────────────────────────────

  /**
   * Step 1: Show the user's upcoming shifts and ask which one they want to swap.
   */
  private async _startSwapFlow(
    from: string,
    employeeId: string,
    companyId: string,
    session: ConversationSessionVO,
    mergedEntities: Record<string, any>,
    locale: string,
  ): Promise<void> {
    const rawShifts = await this.queryBus.execute<
      GetUpcomingShiftsQuery,
      UpcomingShiftDto[]
    >(new GetUpcomingShiftsQuery(employeeId, companyId, 5));

    if (rawShifts.length === 0) {
      this._reply(from, this.i18n.t('bot.swap.no_upcoming_shifts', { lang: locale }));
      return;
    }

    let responseText = this.i18n.t('bot.swap.select_own_shift', { lang: locale }) + '\n\n';
    const optionsEntities: Record<string, string> = {
      pendingAction: 'swap_shift',
      swapStep: 'SELECT_OWN',
    };

    rawShifts.slice(0, 5).forEach((shift, index) => {
      const num = index + 1;
      const desc = this._formatShiftLine(shift, locale);
      responseText += `${num}. ${desc}\n`;
      optionsEntities[`option${num}_shiftId`] = shift.shiftId;
    });

    session = session.withIntent('swap_shift', {
      ...mergedEntities,
      ...optionsEntities,
    });
    await this.sessionRepository.saveSession(session);
    this._reply(from, responseText.trim());
  }

  /**
   * Handle all swap_shift selection steps: SELECT_OWN → SELECT_TARGET → CONFIRM
   * Returns true if the message was handled, false if it should continue normal routing.
   */
  private async _handleSwapSelection(
    from: string,
    employeeId: string,
    companyId: string,
    session: ConversationSessionVO,
    sessionEntities: Readonly<Record<string, any>>,
    selection: string,
    locale: string,
  ): Promise<boolean> {
    const step = sessionEntities.swapStep;

    // ── Step 2: User selected their own shift → show target shifts ──
    if (step === 'SELECT_OWN') {
      const shiftId = sessionEntities[`option${selection}_shiftId`];
      if (!shiftId) {
        this._reply(from, this.i18n.t('bot.swap.invalid_choice', { lang: locale }));
        return true;
      }

      // Fetch all company shifts & assignments for the week
      const now = new Date();
      const monday = this._getMonday(now);
      const nextMonday = new Date(monday);
      nextMonday.setDate(nextMonday.getDate() + 7);

      const [shiftsW1, shiftsW2, assignmentsW1, assignmentsW2] = await Promise.all([
        this.shiftRepo.findByCompanyAndWeek(companyId, monday),
        this.shiftRepo.findByCompanyAndWeek(companyId, nextMonday),
        this.shiftRepo.findAssignmentsByCompanyAndWeek(companyId, monday),
        this.shiftRepo.findAssignmentsByCompanyAndWeek(companyId, nextMonday),
      ]);
      const allShifts = [...shiftsW1, ...shiftsW2];
      const allAssignments = [...assignmentsW1, ...assignmentsW2];

      // Find other employees' assignments (exclude current user)
      const otherAssignments = allAssignments.filter(
        (a) => a.employeeId !== employeeId,
      );

      if (otherAssignments.length === 0) {
        await this.sessionRepository.clearSession(from);
        this._reply(from, this.i18n.t('bot.swap.no_target_shifts', { lang: locale }));
        return true;
      }

      // Load employee names
      const employees = await this.employeeRepo.findAllByCompany(companyId);
      const empMap = new Map(employees.map((e) => [e.id, e.name]));

      // Build options list (cap at 5)
      const ownShiftRecord = allShifts.find((s) => s.id === shiftId);
      const ownShiftDate = ownShiftRecord 
        ? ownShiftRecord.startTime.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES', { weekday: 'short', month: 'short', day: 'numeric' })
        : '';
        
      let responseText = this.i18n.t('bot.swap.select_target_shift', { lang: locale, args: { date: ownShiftDate } }) + '\n\n';
      const optionsEntities: Record<string, string> = {
        pendingAction: 'swap_shift',
        swapStep: 'SELECT_TARGET',
        selectedOwnShiftId: shiftId,
      };

      let count = 0;
      for (const assignment of otherAssignments) {
        if (count >= 5) break;
        const shift = allShifts.find((s) => s.id === assignment.shiftId);
        if (!shift || shift.endTime <= now) continue;

        count++;
        const empName = empMap.get(assignment.employeeId) || 'Compañero';
        const desc = this._formatShiftLine({
          shiftId: shift.id,
          startTime: shift.startTime,
          endTime: shift.endTime,
        }, locale);
        responseText += `${count}. *${empName}* — ${desc}\n`;
        optionsEntities[`option${count}_shiftId`] = shift.id;
        optionsEntities[`option${count}_employeeId`] = assignment.employeeId;
      }

      if (count === 0) {
        await this.sessionRepository.clearSession(from);
        this._reply(from, this.i18n.t('bot.swap.no_target_shifts', { lang: locale }));
        return true;
      }

      session = session.withIntent('swap_shift', optionsEntities);
      await this.sessionRepository.saveSession(session);
      this._reply(from, responseText.trim());
      return true;
    }

    // ── Step 3: User selected target shift → ask for confirmation ──
    if (step === 'SELECT_TARGET') {
      const targetShiftId = sessionEntities[`option${selection}_shiftId`];
      const targetEmployeeId = sessionEntities[`option${selection}_employeeId`];
      if (!targetShiftId || !targetEmployeeId) {
        this._reply(from, this.i18n.t('bot.swap.invalid_choice', { lang: locale }));
        return true;
      }

      const ownShiftId = sessionEntities.selectedOwnShiftId;

      // Load shift details for confirmation
      const monday = this._getMonday(new Date());
      const nextMonday = new Date(monday);
      nextMonday.setDate(nextMonday.getDate() + 7);
      const [shiftsW1, shiftsW2] = await Promise.all([
        this.shiftRepo.findByCompanyAndWeek(companyId, monday),
        this.shiftRepo.findByCompanyAndWeek(companyId, nextMonday),
      ]);
      const allShifts = [...shiftsW1, ...shiftsW2];

      const ownShift = allShifts.find((s) => s.id === ownShiftId);
      const targetShift = allShifts.find((s) => s.id === targetShiftId);

      const employees = await this.employeeRepo.findAllByCompany(companyId);
      const targetName = employees.find((e) => e.id === targetEmployeeId)?.name || 'Compañero';

      const ownDesc = ownShift
        ? this._formatShiftLine({ shiftId: ownShift.id, startTime: ownShift.startTime, endTime: ownShift.endTime }, locale)
        : ownShiftId;
      const targetDesc = targetShift
        ? this._formatShiftLine({ shiftId: targetShift.id, startTime: targetShift.startTime, endTime: targetShift.endTime }, locale)
        : targetShiftId;

      const confirmMsg = this.i18n.t('bot.swap.confirm_prompt', {
        lang: locale,
        args: { myShift: ownDesc, targetShift: targetDesc, targetName }
      });

      session = session.withIntent('swap_shift', {
        pendingAction: 'swap_shift',
        swapStep: 'CONFIRM',
        selectedOwnShiftId: ownShiftId,
        selectedTargetShiftId: targetShiftId,
        selectedTargetEmployeeId: targetEmployeeId,
      });
      await this.sessionRepository.saveSession(session);
      this._reply(from, confirmMsg);
      return true;
    }

    // ── Step 4: User confirms or cancels ──
    if (step === 'CONFIRM') {
      if (['sí', 'si', 'yes', 'y', '1'].includes(selection)) {
        const ownShiftId = sessionEntities.selectedOwnShiftId;
        const targetShiftId = sessionEntities.selectedTargetShiftId;
        const targetEmployeeId = sessionEntities.selectedTargetEmployeeId;

        const command = new SwapShiftCommand(
          employeeId,
          ownShiftId,
          targetEmployeeId,
          targetShiftId,
          companyId,
        );

        await this.commandBus.execute(command);
        await this.sessionRepository.clearSession(from);
        this._reply(from, this.i18n.t('bot.swap.request_received', { lang: locale }));
        return true;
      }

      if (['no', 'n', '2'].includes(selection)) {
        await this.sessionRepository.clearSession(from);
        this._reply(from, this.i18n.t('bot.swap.swap_cancelled', { lang: locale }));
        return true;
      }

      this._reply(from, this.i18n.t('bot.swap.invalid_choice', { lang: locale }));
      return true;
    }

    return false; // not a swap selection step
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async _classifyMessage(msg: IncomingMessage) {
    const isAudio = msg.mimeType?.startsWith('audio/') && msg.mediaUrl;
    const isText = !!msg.body && !msg.mediaUrl;

    if (isText) {
      return this.conversationalService.processText(msg.body!);
    }

    if (isAudio) {
      return this.conversationalService.processAudio(
        msg.mediaUrl!,
        msg.mimeType!,
        msg.twilioSid,
        msg.twilioToken,
      );
    }

    // Image, document, location — not supported
    this.logger.warn(`Unsupported media type: ${msg.mimeType}`);
    return ConversationIntentVO.unknown('unsupported');
  }

  private async _execute(command: object): Promise<string | void> {
    if (command instanceof GetMyScheduleQuery) {
      return this.queryBus.execute<GetMyScheduleQuery, string>(command);
    }
    return this.commandBus.execute(command) as Promise<string | void>;
  }

  /**
   * If the command contains a shiftId that looks like a short ID (< 36 chars),
   * resolve it to the full UUID via prefix match. Returns null if resolution
   * fails (user is notified inline).
   */
  private async _resolveShortShiftId(
    command: object,
    companyId: string,
    from: string,
    locale: string,
  ): Promise<object | null> {
    const UUID_LENGTH = 36;
    let shiftId: string | undefined;

    if (command instanceof ReportAbsenceCommand) {
      shiftId = command.shiftId;
    }

    if (!shiftId || shiftId.length >= UUID_LENGTH) {
      return command; // already a full UUID or not applicable
    }

    const fullId = await this.shiftRepo.resolveShortId(shiftId, companyId);
    if (!fullId) {
      this._reply(
        from,
        this.i18n.t('bot.general.shift_not_found', { lang: locale, args: { shiftId } }),
      );
      return null;
    }

    if (command instanceof ReportAbsenceCommand) {
      return new ReportAbsenceCommand(
        command.employeeId,
        fullId,
        command.reason,
        command.companyId,
      );
    }

    return command;
  }

  /** Format a shift as a human-readable line for WhatsApp. */
  private _formatShiftLine(shift: { shiftId: string; startTime: Date; endTime: Date }, locale: string = 'es'): string {
    const start = new Date(shift.startTime);
    const end = new Date(shift.endTime);
    const code = locale === 'en' ? 'en-US' : 'es-ES';
    const dateStr = start.toLocaleDateString(code, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const startHora = start.toLocaleTimeString(code, {
      hour: '2-digit',
      minute: '2-digit',
    });
    const endHora = end.toLocaleTimeString(code, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${dateStr}, ${startHora}–${endHora}`;
  }

  private _getMonday(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Fire-and-forget: respond immediately without blocking the webhook handler.
   * Errors are logged but do not throw — Twilio already got its 200.
   */
  private _reply(to: string, message: string): void {
    setImmediate(() => {
      this.notificationService.sendWhatsApp(to, message).catch((err: Error) => {
        this.logger.error(`Failed to send reply to ${to}: ${err.message}`);
      });
    });
  }
}
