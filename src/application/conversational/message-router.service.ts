import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { IConversationalService } from '../../domain/services/conversational.service.interface';
import { CONVERSATIONAL_SERVICE } from '../../domain/services/conversational.service.interface';
import type { INotificationService } from '../../domain/services/notification.service';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import type { Employee } from '../../domain/aggregates/employee.aggregate';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import { ShiftSlotGeneratorService } from '../../domain/services/shift-slot-generator.service';
import type { VirtualShiftSlot } from '../../domain/value-objects/virtual-shift-slot.vo';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import { ConversationSessionRepository } from '../../infrastructure/conversational/conversation-session.repository';
import { ConversationSessionVO } from '../../domain/value-objects/conversation-session.vo';
import {
  ConversationIntentVO,
  type IntentEntities,
} from '../../domain/value-objects/conversation-intent.vo';
import { GetMyScheduleQuery } from '../queries/get-my-schedule.query';
import { GetUpcomingShiftsQuery } from '../queries/get-upcoming-shifts.query';
import type { UpcomingShiftDto } from '../handlers/get-upcoming-shifts.handler';
import { CommandMapperService } from './command-mapper.service';
import { SwapShiftCommand } from '../commands/swap-shift.command';
import { TakeOpenShiftCommand } from '../commands/take-open-shift.command';
import { ReportAbsenceCommand } from '../commands/report-absence.command';
import { AbsenceReportCreator } from '../../domain/services/absence-report-creator.service';
import { GenerateHybridScheduleCommand } from '../commands/generate-hybrid-schedule.command';
import { ScheduleGenerationLockedException } from '../../domain/services/schedule-generation-lock.service';
import { ScheduleGenerationDispatcher } from '../jobs/schedule-generation-dispatcher.service';
import { CompanyPreferencesService } from '../services/company-preferences.service';
import { weekStartOf, nextWeekStartIso } from '../../domain/shared/week';
import { CreateSemanticRuleCommand } from '../commands/create-semantic-rule.command';
import type { CreateSemanticRuleResult } from '../handlers/create-semantic-rule.handler';
import {
  WHATSAPP_PENDING_CLARIFICATION_REPOSITORY,
  type IWhatsappPendingClarificationRepository,
} from '../../domain/repositories/whatsapp-pending-clarification.repository';
import { WhatsappPendingClarification } from '../../domain/aggregates/whatsapp-pending-clarification.aggregate';
import { WhatsappPolicyPermissionService } from '../../domain/services/whatsapp-policy-permission.service';
import {
  CompanyPolicyCreator,
  type CreateCompanyPolicyInput,
} from '../../domain/services/company-policy-creator.service';
import { PolicyScopeResolver } from './policy-scope-resolver.service';
import type { PolicyScope } from '../../domain/aggregates/company-policy.aggregate';
import { LLMUsageTracker } from '../../infrastructure/observability/llm-usage-tracker.service';
import { LLMUsageLogger } from '../../infrastructure/observability/llm-usage-logger.service';
import { I18nService } from 'nestjs-i18n';
import { SupabaseClient } from '@supabase/supabase-js';

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
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IShiftAssignmentRepository,
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly shiftTemplateRepo: IShiftTemplateRepository,
    private readonly slotGenerator: ShiftSlotGeneratorService,
    private readonly sessionRepository: ConversationSessionRepository,
    private readonly commandMapper: CommandMapperService,
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly i18n: I18nService,
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    @Inject(WHATSAPP_PENDING_CLARIFICATION_REPOSITORY)
    private readonly pendingClarificationRepo: IWhatsappPendingClarificationRepository,
    private readonly policyPermission: WhatsappPolicyPermissionService,
    private readonly companyPolicyCreator: CompanyPolicyCreator,
    private readonly policyScopeResolver: PolicyScopeResolver,
    private readonly llmUsageTracker: LLMUsageTracker,
    private readonly llmUsageLogger: LLMUsageLogger,
    /**
     * Phase 18.4 — habilita el flow nuevo de report_absence:
     *   - manager-on-behalf via targetEmployeeName.
     *   - period via startDate/endDate (multi-day).
     * Si el extractor LLM no detecta ninguno, sigue el flow legacy
     * (FETCH_SHIFTS guiado para reportar self single-shift).
     */
    private readonly absenceCreator: AbsenceReportCreator,
    /**
     * Fase 1 async migration — encola jobs `schedule.generate` cuando
     * el env var `USE_ASYNC_SCHEDULE_GEN=true`. Si está apagado, el
     * helper `_executeScheduleGenAndReply` cae al CommandBus síncrono.
     */
    private readonly scheduleDispatcher: ScheduleGenerationDispatcher,
    private readonly companyPreferences: CompanyPreferencesService,
  ) {}

  async route(msg: IncomingMessage): Promise<void> {
    const { from, employeeId, companyId } = msg;
    let locale = 'es';

    try {
      // 1. Detect type and classify intent
      const intent = await this._classifyMessage(msg);
      
      const employee = await this.employeeRepo.findById(employeeId, companyId);
      if (employee) {
        const detectedLang = intent.getEntities().detectedLanguage;
        if (detectedLang && detectedLang.length === 2 && detectedLang.toLowerCase() !== employee.locale) {
          employee.updateLocale(detectedLang);
          await this.employeeRepo.save(employee);
          this.logger.log(`Updated employee ${employeeId} locale to ${employee.locale}`);
        }
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

      // Phase 14 — durante el flow `generate_schedule` (o cuando el intent
      // recién clasificado lo abre), acumulamos los tokens del classifier
      // en la sesión para reportarlos en el reply final junto con los del
      // schedule generation.
      const isGenerateFlow =
        sessionEntities.pendingAction === 'generate_schedule' ||
        currentIntent === 'generate_schedule';
      if (isGenerateFlow && this.lastClassifierUsage.calls > 0) {
        mergedEntities.scheduleClassifierCalls =
          (Number(sessionEntities.scheduleClassifierCalls) || 0) +
          this.lastClassifierUsage.calls;
        mergedEntities.scheduleClassifierPrompt =
          (Number(sessionEntities.scheduleClassifierPrompt) || 0) +
          this.lastClassifierUsage.prompt;
        mergedEntities.scheduleClassifierCompletion =
          (Number(sessionEntities.scheduleClassifierCompletion) || 0) +
          this.lastClassifierUsage.completion;
        mergedEntities.scheduleClassifierTotal =
          (Number(sessionEntities.scheduleClassifierTotal) || 0) +
          this.lastClassifierUsage.total;
      }

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

      // Handle response to a pending suggestion-loop for rule creation.
      // El manager ya recibió las opciones numeradas y ahora elige una
      // (o escribe texto libre que reinicia el flow desde el extractor).
      if (
        (currentIntent === 'select_option' || currentIntent === 'unknown') &&
        sessionEntities.pendingAction === 'create_rule_clarification'
      ) {
        const handled = await this._handleRuleClarificationResponse(
          from,
          employeeId,
          companyId,
          sessionEntities,
          intentEntities,
          intent.getRawText(),
          locale,
        );
        if (handled) return;
      }

      // Handle response to a pending suggestion-loop for policy creation.
      // Mismo patrón que rule pero target_kind='policy'.
      if (
        (currentIntent === 'select_option' || currentIntent === 'unknown') &&
        sessionEntities.pendingAction === 'create_policy_clarification'
      ) {
        const handled = await this._handlePolicyClarificationResponse(
          from,
          employeeId,
          companyId,
          sessionEntities,
          intentEntities,
          intent.getRawText(),
          locale,
        );
        if (handled) return;
      }

      // Handle create_policy intent (tenant-wide policy via WhatsApp).
      // Inline — no usa CommandMapper porque la lógica vive en
      // CompanyPolicyCreator, accesible directamente.
      if (currentIntent === 'create_policy') {
        const handled = await this._handleCreatePolicy(
          from,
          employeeId,
          companyId,
          employee,
          mergedEntities,
          intent.getRawText(),
          locale,
        );
        if (handled) return;
      }

      // Handle Option Selection for rule creation
      if (session.getActionRequired() === 'RULE_SELECT_SCOPE') {
        await this._handleRuleScopeSelection(
          from,
          session,
          intent.getRawText(),
          intentEntities,
          locale,
        );
        return;
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

      // Handle Option Selection for generate_schedule (SELECT_TEMPLATE)
      if (
        (currentIntent === 'select_option' || currentIntent === 'unknown' || currentIntent === 'generate_schedule') &&
        sessionEntities.pendingAction === 'generate_schedule'
      ) {
        const rawText = intent.getRawText().trim().toLowerCase();
        const selection = intentEntities.selection?.toLowerCase() || rawText;

        const handled = await this._handleGenerateSelection(
          from,
          companyId,
          session,
          sessionEntities,
          selection,
          locale,
        );
        if (handled) return;
      }

      // Phase 18.6 — manager-on-behalf for check_schedule.
      // Si el LLM extrajo targetEmployeeName y la intent es check_schedule,
      // resolvemos al empleado y corremos GetMyScheduleQuery contra él en
      // vez de contra el remitente. El short-path responde solo y corta
      // el flow; si no aplica, sigue al CommandMapper normal.
      if (
        currentIntent === 'check_schedule' &&
        mergedEntities.targetEmployeeName?.trim()
      ) {
        const handled = await this._tryHandleScheduleOnBehalf(
          from,
          employeeId,
          companyId,
          mergedEntities,
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

      if (mapResult.command?.constructor.name === 'CreateSemanticRuleCommand') {
        const handled = await this._handleSemanticRuleScopeBranch(
          from,
          companyId,
          employee,
          session,
          mapResult,
          locale,
        );
        if (handled) return;
      }

      // 4a. Handle SWAP_SELECT_SHIFT — start the guided swap flow
      if (mapResult.actionRequired === 'SWAP_SELECT_SHIFT') {
        await this._startSwapFlow(from, employeeId, companyId, session, mergedEntities, locale);
        return;
      }

      // 4b. Handle FETCH_SHIFTS (report_absence flow)
      if (mapResult.actionRequired === 'FETCH_SHIFTS') {
        const handled = await this._handleAbsenceFetchShifts(
          from,
          employeeId,
          companyId,
          session,
          mergedEntities,
          locale,
        );
        if (handled) return;
      }

      // 4c. Handle GENERATE_SELECT_TEMPLATE — flow jerárquico
      if (mapResult.actionRequired === 'GENERATE_SELECT_TEMPLATE') {
        await this._handleGenerateScheduleHierarchicalFlow(
          from,
          companyId,
          session,
          mergedEntities,
          locale,
        );
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

      await this._resolveExecuteAndReply(
        from,
        employeeId,
        companyId,
        mapResult.command,
        locale,
      );
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

  // ─── Generate Schedule Helpers ───────────────────────────────────────────

  /**
   * Phase 14 — flow jerárquico (branch → department → template) con
   * smart-skip de niveles con 1 sola opción.
   */
  private async _handleGenerateSelection(
    from: string,
    companyId: string,
    session: ConversationSessionVO,
    sessionEntities: Readonly<Record<string, any>>,
    selection: string,
    locale: string,
  ): Promise<boolean> {
    const step = sessionEntities.generateStep;
    const weekStart = sessionEntities.weekStart;

    if (step === 'SELECT_BRANCH') {
      const branchId = sessionEntities[`option${selection}_branchId`];
      if (!branchId) {
        this._reply(from, this.i18n.t('bot.general.invalid_choice', { lang: locale }));
        return true;
      }
      // Avanzar a SELECT_DEPARTMENT (con smart-skip si solo hay 1).
      const departments = (await this._loadDepartments(companyId)).filter(
        (d) => d.branchId === branchId,
      );
      if (departments.length <= 1) {
        const deptId = departments[0]?.id ?? null;
        await this._promptTemplateSelection(
          from,
          session,
          { ...sessionEntities, selectedBranchId: branchId },
          companyId,
          weekStart,
          deptId,
          locale,
        );
        return true;
      }
      let msg = `¿Para qué departamento?\n\n`;
      const opts: Record<string, string> = {
        pendingAction: 'generate_schedule',
        generateStep: 'SELECT_DEPARTMENT',
        weekStart,
        selectedBranchId: branchId,
      };
      departments.slice(0, 5).forEach((d, idx) => {
        const num = idx + 1;
        msg += `${num}. ${d.name}\n`;
        opts[`option${num}_departmentId`] = d.id;
      });
      session = session.withIntent('generate_schedule', opts);
      await this.sessionRepository.saveSession(session);
      this._reply(from, msg.trim());
      return true;
    }

    if (step === 'SELECT_DEPARTMENT') {
      const departmentId = sessionEntities[`option${selection}_departmentId`];
      if (!departmentId) {
        this._reply(from, this.i18n.t('bot.general.invalid_choice', { lang: locale }));
        return true;
      }
      await this._promptTemplateSelection(
        from,
        session,
        sessionEntities,
        companyId,
        weekStart,
        departmentId,
        locale,
      );
      return true;
    }

    if (step === 'SELECT_TEMPLATE') {
      const departmentId = sessionEntities.selectedDepartmentId ?? undefined;
      let cmd: GenerateHybridScheduleCommand;
      if (selection === '1' || selection === 'todos' || selection === 'todos los turnos') {
        cmd = new GenerateHybridScheduleCommand(
          companyId,
          weekStart,
          undefined,
          undefined,
          locale,
          departmentId,
        );
      } else {
        const templateId = sessionEntities[`option${selection}_templateId`];
        if (!templateId) {
          this._reply(from, this.i18n.t('bot.general.invalid_choice', { lang: locale }));
          return true;
        }
        cmd = new GenerateHybridScheduleCommand(
          companyId,
          weekStart,
          undefined,
          templateId,
          locale,
          departmentId,
        );
      }
      await this._executeScheduleGenAndReply(cmd, from, sessionEntities, locale);
      return true;
    }

    return false;
  }

  /**
   * Pregunta por el turno (o "todos") filtrando por el departmentId si
   * lo tenemos. Persiste opciones numeradas en la sesión y replica al
   * manager. Si no hay templates en el dept, ejecuta inmediatamente con
   * todos (degenera al comportamiento legacy).
   */
  private async _promptTemplateSelection(
    from: string,
    session: ConversationSessionVO,
    sessionEntities: Record<string, any>,
    companyId: string,
    weekStart: string,
    departmentId: string | null,
    locale: string,
  ): Promise<void> {
    const allTemplates = await this.shiftTemplateRepo.findAllByCompany(companyId);
    const templates = departmentId
      ? allTemplates.filter((t) => (t as any).departmentId === departmentId)
      : allTemplates;

    if (templates.length === 0) {
      const cmd = new GenerateHybridScheduleCommand(
        companyId,
        weekStart,
        undefined,
        undefined,
        locale,
        departmentId ?? undefined,
      );
      await this._executeScheduleGenAndReply(cmd, from, sessionEntities, locale);
      return;
    }

    if (templates.length === 1) {
      // Único template → no hay nada que elegir, ejecutamos.
      const cmd = new GenerateHybridScheduleCommand(
        companyId,
        weekStart,
        undefined,
        templates[0].id,
        locale,
        departmentId ?? undefined,
      );
      await this._executeScheduleGenAndReply(cmd, from, sessionEntities, locale);
      return;
    }

    let msg = `¿Qué turno generar?\n\n1. Todos los turnos\n`;
    const opts: Record<string, string> = {
      ...sessionEntities,
      pendingAction: 'generate_schedule',
      generateStep: 'SELECT_TEMPLATE',
      weekStart,
      ...(departmentId ? { selectedDepartmentId: departmentId } : {}),
    };
    templates.slice(0, 5).forEach((t, idx) => {
      const num = idx + 2;
      msg += `${num}. ${t.name}\n`;
      opts[`option${num}_templateId`] = t.id;
    });
    session = session.withIntent('generate_schedule', opts);
    await this.sessionRepository.saveSession(session);
    this._reply(from, msg.trim());
  }

  /** Phase 14 — listas de branches/departments con company_id (read-only). */
  private async _loadBranches(
    companyId: string,
  ): Promise<{ id: string; name: string }[]> {
    const { data, error } = await this.supabase
      .from('branches')
      .select('id, name')
      .eq('company_id', companyId)
      .order('name', { ascending: true });
    if (error) {
      this.logger.warn(`_loadBranches: ${error.message}`);
      return [];
    }
    return (data ?? []) as { id: string; name: string }[];
  }

  private async _loadDepartments(
    companyId: string,
  ): Promise<{ id: string; name: string; branchId: string | null }[]> {
    const { data, error } = await this.supabase
      .from('departments')
      .select('id, name, branch_id')
      .eq('company_id', companyId)
      .order('name', { ascending: true });
    if (error) {
      this.logger.warn(`_loadDepartments: ${error.message}`);
      return [];
    }
    return (data ?? []).map((d: any) => ({
      id: d.id,
      name: d.name,
      branchId: d.branch_id ?? null,
    }));
  }

  /**
   * Ejecuta el GenerateHybridScheduleCommand desde el flow de WhatsApp,
   * formatea la respuesta y limpia la sesión. Si choca con un lock
   * activo (`ScheduleGenerationLockedException`), responde con i18n
   * `bot.schedule.generation_in_progress` y limpia la sesión también.
   * Otros errores se propagan tal cual (la sesión NO se limpia, para
   * que el manager pueda reintentar desde el mismo paso).
   */
  private async _executeScheduleGenAndReply(
    cmd: GenerateHybridScheduleCommand,
    from: string,
    sessionEntities: Record<string, any>,
    locale: string,
  ): Promise<void> {
    const useAsync = process.env.USE_ASYNC_SCHEDULE_GEN === 'true';

    // Path async (Fase 1) — encola, responde inmediato "generando…",
    // limpia sesión. El worker dispara el outbound real cuando termina.
    if (useAsync) {
      try {
        const weekStartsOn = await this.companyPreferences.getWeekStartsOn(cmd.companyId);
        await this.scheduleDispatcher.enqueue({
          companyId: cmd.companyId,
          weekStart: cmd.weekStart,
          weekStartsOn,
          shiftTemplateId: cmd.shiftTemplateId,
          departmentId: cmd.departmentId,
          locale: cmd.locale ?? locale,
          source: { type: 'whatsapp', from },
        });
        this._reply(
          from,
          this.i18n.t('bot.schedule.queued', {
            lang: locale,
            args: { weekStart: cmd.weekStart },
          }),
        );
        await this.sessionRepository.clearSession(from);
        return;
      } catch (err) {
        if (err instanceof ScheduleGenerationLockedException) {
          this._reply(
            from,
            this.i18n.t('bot.schedule.generation_in_progress', {
              lang: locale,
              args: { weekStart: err.weekStart },
            }),
          );
          await this.sessionRepository.clearSession(from);
          return;
        }
        throw err;
      }
    }

    // Path síncrono (Fase 0) — bloquea el handler hasta terminar.
    try {
      const result = await this.commandBus.execute(cmd);
      this._reply(from, this._formatScheduleReply(result, locale, sessionEntities));
      await this.sessionRepository.clearSession(from);
    } catch (err) {
      if (err instanceof ScheduleGenerationLockedException) {
        this._reply(
          from,
          this.i18n.t('bot.schedule.generation_in_progress', {
            lang: locale,
            args: { weekStart: err.weekStart },
          }),
        );
        await this.sessionRepository.clearSession(from);
        return;
      }
      throw err;
    }
  }

  /**
   * Formatea la respuesta del hybrid schedule incluyendo explanation +
   * warnings + LLM usage (proposer + catch-all + classifier).
   */
  private _formatScheduleReply(
    result: any,
    locale: string,
    sessionEntities?: Readonly<Record<string, any>>,
  ): string {
    // Phase 14 — sumar los tokens del classifier acumulados en la sesión
    // (mensajes "generar horario" + "1" + "1" del flow jerárquico) al
    // bloque del LLM usage para que el manager vea el costo total.
    if (sessionEntities && result?.llmUsage) {
      const cCalls = Number(sessionEntities.scheduleClassifierCalls) || 0;
      const cPrompt = Number(sessionEntities.scheduleClassifierPrompt) || 0;
      const cCompletion =
        Number(sessionEntities.scheduleClassifierCompletion) || 0;
      const cTotal = Number(sessionEntities.scheduleClassifierTotal) || 0;
      if (cCalls > 0) {
        result.llmUsage = {
          calls: result.llmUsage.calls + cCalls,
          prompt: result.llmUsage.prompt + cPrompt,
          completion: result.llmUsage.completion + cCompletion,
          total: result.llmUsage.total + cTotal,
        };
      }
    }
    return this._formatScheduleReplyInner(result, locale);
  }

  private _formatScheduleReplyInner(result: any, locale: string): string {
    let reply = this.i18n.t('bot.general.success', { lang: locale });
    if (result && typeof result === 'object' && result.explanation) {
      reply = result.explanation;
    }
    if (result && Array.isArray(result.warnings) && result.warnings.length > 0) {
      const header = this.i18n.t('bot.schedule.warnings_header', { lang: locale });
      reply += `\n\n${header}\n` +
        result.warnings.map((w: string) => `• ${w}`).join('\n');
    }
    // Phase 14 — incluir consumo de tokens del LLM en el reply al manager
    // (cubre LLM-proposer + catch-all llm_runtime + traducción de reglas).
    // No incluye los tokens del clasificador conversacional — ésos viven
    // fuera del scope del handler.
    if (
      result &&
      result.llmUsage &&
      typeof result.llmUsage.total === 'number' &&
      result.llmUsage.calls > 0
    ) {
      const u = result.llmUsage;
      const fmt = (n: number) => n.toLocaleString('es-AR');
      reply +=
        `\n\n🧮 LLM: ${u.calls} llamada${u.calls === 1 ? '' : 's'} · ` +
        `prompt ${fmt(u.prompt)} · completion ${fmt(u.completion)} · ` +
        `total ${fmt(u.total)} tokens`;
    }
    return reply;
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
    if (step === 'SELECT_OWN' || step === 'SELECT_SWAP_TYPE') {
      return this._handleSwapSelectOwnOrType(
        from,
        employeeId,
        companyId,
        session,
        sessionEntities,
        selection,
        locale,
      );
    }
    if (step === 'SELECT_TARGET') {
      return this._handleSwapSelectTarget(
        from,
        companyId,
        session,
        sessionEntities,
        selection,
        locale,
      );
    }
    if (step === 'CONFIRM') {
      return this._handleSwapConfirm(
        from,
        employeeId,
        companyId,
        sessionEntities,
        selection,
        locale,
      );
    }
    return false; // not a swap selection step
  }

  /**
   * Steps 2 + 2b del swap flow:
   *   SELECT_OWN  — el user eligió su turno; resolvemos qué tipo de
   *                 target ofrecer (OPEN, SWAP, o intercept si hay ambos).
   *   SELECT_SWAP_TYPE — solo si vino del intercept, el user eligió tipo.
   * Output: lista de opciones (cap 5) para SELECT_TARGET.
   */
  private async _handleSwapSelectOwnOrType(
    from: string,
    employeeId: string,
    companyId: string,
    session: ConversationSessionVO,
    sessionEntities: Readonly<Record<string, any>>,
    selection: string,
    locale: string,
  ): Promise<boolean> {
    const step = sessionEntities.swapStep;
    const shiftId =
      step === 'SELECT_OWN'
        ? sessionEntities[`option${selection}_shiftId`]
        : sessionEntities.selectedOwnShiftId;

    if (!shiftId) {
      this._reply(from, this.i18n.t('bot.swap.invalid_choice', { lang: locale }));
      return true;
    }

    const now = new Date();
    const { slots: allSlots, assignments: allAssignments } =
      await this._loadTwoWeekContext(companyId, now);

    const openSlots = this._findOpenSlots(allSlots, allAssignments, now);
    const otherAssignments = allAssignments.filter(
      (a) => a.employeeId !== employeeId,
    );

    let targetTypeFilter: 'OPEN' | 'SWAP';

    if (step === 'SELECT_OWN') {
      const hasOpen = openSlots.length > 0;
      const hasSwap = otherAssignments.length > 0;

      if (!hasOpen && !hasSwap) {
        await this.sessionRepository.clearSession(from);
        this._reply(from, this.i18n.t('bot.swap.no_target_shifts', { lang: locale }));
        return true;
      }

      // Intercept: si hay ambos tipos, preguntar al user qué prefiere.
      if (hasOpen && hasSwap) {
        await this._promptSwapTypeIntercept(from, session, shiftId, locale);
        return true;
      }

      targetTypeFilter = hasOpen ? 'OPEN' : 'SWAP';
    } else {
      // step === 'SELECT_SWAP_TYPE'
      const parsed = this._parseSwapTypeSelection(selection);
      if (!parsed) {
        this._reply(from, this.i18n.t('bot.swap.invalid_choice', { lang: locale }));
        return true;
      }
      targetTypeFilter = parsed;
    }

    const employees = await this.employeeRepo.findAllByCompany(companyId);
    const empMap = new Map(employees.map((e) => [e.id, e.name]));

    const ownDateLabel = this._formatOwnShiftDate(allSlots, allAssignments, shiftId, locale);
    let responseText =
      this.i18n.t('bot.swap.select_target_shift', {
        lang: locale,
        args: { date: ownDateLabel },
      }) + '\n\n';

    const optionsEntities: Record<string, string> = {
      pendingAction: 'swap_shift',
      swapStep: 'SELECT_TARGET',
      selectedOwnShiftId: shiftId,
    };

    const { text: optionsText, count } =
      targetTypeFilter === 'OPEN'
        ? this._buildOpenSlotOptions(openSlots, locale, optionsEntities)
        : this._buildColleagueOptions(otherAssignments, allSlots, empMap, now, optionsEntities);

    responseText += optionsText;

    if (count === 0) {
      await this.sessionRepository.clearSession(from);
      this._reply(from, this.i18n.t('bot.swap.no_target_shifts', { lang: locale }));
      return true;
    }

    const updated = session.withIntent('swap_shift', optionsEntities);
    await this.sessionRepository.saveSession(updated);
    this._reply(from, responseText.trim());
    return true;
  }

  /** Filtra slots con capacidad libre y endTime futuro. */
  private _findOpenSlots(
    allSlots: VirtualShiftSlot[],
    allAssignments: ShiftAssignment[],
    now: Date,
  ): VirtualShiftSlot[] {
    const fillBySlotKey = new Map<string, number>();
    for (const a of allAssignments) {
      fillBySlotKey.set(a.slotKey, (fillBySlotKey.get(a.slotKey) ?? 0) + 1);
    }
    return allSlots.filter((s) => {
      if (s.endTime <= now) return false;
      const cap = s.requiredEmployees;
      if (cap === null || cap === undefined) return false;
      return (fillBySlotKey.get(s.slotKey) ?? 0) < cap;
    });
  }

  private async _promptSwapTypeIntercept(
    from: string,
    session: ConversationSessionVO,
    ownShiftId: string,
    locale: string,
  ): Promise<void> {
    let responseText =
      this.i18n.t('bot.swap.select_swap_type', { lang: locale }) + '\n\n';
    responseText += `1. ${this.i18n.t('bot.swap.swap_type_open', { lang: locale })}\n`;
    responseText += `2. ${this.i18n.t('bot.swap.swap_type_colleague', { lang: locale })}\n`;

    const updated = session.withIntent('swap_shift', {
      pendingAction: 'swap_shift',
      swapStep: 'SELECT_SWAP_TYPE',
      selectedOwnShiftId: ownShiftId,
    });
    await this.sessionRepository.saveSession(updated);
    this._reply(from, responseText.trim());
  }

  private _parseSwapTypeSelection(selection: string): 'OPEN' | 'SWAP' | null {
    if (
      !['1', '2', 'uno', 'dos', 'libre', 'compañero', 'open', 'colleague'].includes(selection)
    ) {
      return null;
    }
    return ['1', 'uno', 'libre', 'open'].includes(selection) ? 'OPEN' : 'SWAP';
  }

  private _formatOwnShiftDate(
    allSlots: VirtualShiftSlot[],
    allAssignments: ShiftAssignment[],
    ownAssignmentId: string,
    locale: string,
  ): string {
    const ownAssignment = allAssignments.find((a) => a.id === ownAssignmentId);
    const ownSlot = ownAssignment
      ? allSlots.find((s) => s.slotKey === ownAssignment.slotKey)
      : undefined;
    return ownSlot
      ? ownSlot.startTime.toLocaleDateString(
          locale === 'en' ? 'en-US' : 'es-ES',
          { weekday: 'short', month: 'short', day: 'numeric' },
        )
      : '';
  }

  private _buildOpenSlotOptions(
    openSlots: VirtualShiftSlot[],
    locale: string,
    optionsEntities: Record<string, string>,
  ): { text: string; count: number } {
    let text = '';
    let count = 0;
    const openLabel = this.i18n.t('bot.swap.open_shift_label', {
      lang: locale,
      defaultValue: 'Turno Libre',
    });
    for (const slot of openSlots) {
      if (count >= 5) break;
      count++;
      const desc = this._formatShiftLine(
        {
          shiftId: slot.slotKey,
          startTime: slot.startTime,
          endTime: slot.endTime,
        },
        locale,
      );
      text += `${count}. *[${openLabel}]* — ${desc}\n`;
      optionsEntities[`option${count}_shiftId`] = slot.slotKey;
      optionsEntities[`option${count}_type`] = 'OPEN';
    }
    return { text, count };
  }

  private _buildColleagueOptions(
    otherAssignments: ShiftAssignment[],
    allSlots: VirtualShiftSlot[],
    empMap: Map<string, string>,
    now: Date,
    optionsEntities: Record<string, string>,
  ): { text: string; count: number } {
    const groupedBySlot = new Map<
      string,
      { slot: VirtualShiftSlot; assignments: ShiftAssignment[] }
    >();
    for (const assignment of otherAssignments) {
      const slot = allSlots.find((s) => s.slotKey === assignment.slotKey);
      if (!slot || slot.endTime <= now) continue;
      if (!groupedBySlot.has(slot.slotKey)) {
        groupedBySlot.set(slot.slotKey, { slot, assignments: [] });
      }
      groupedBySlot.get(slot.slotKey)!.assignments.push(assignment);
    }

    let text = '';
    let count = 0;
    for (const group of groupedBySlot.values()) {
      if (count >= 5) break;
      const timeDesc = this._formatShiftLine(
        {
          shiftId: group.slot.slotKey,
          startTime: group.slot.startTime,
          endTime: group.slot.endTime,
        },
        'es', // locale-independent line builder
      );
      text += `\n*${timeDesc}*\n`;
      for (const assignment of group.assignments) {
        if (count >= 5) break;
        count++;
        const empName = empMap.get(assignment.employeeId) || 'Compañero';
        text += `${count}. ${empName}\n`;
        optionsEntities[`option${count}_shiftId`] = assignment.id;
        optionsEntities[`option${count}_employeeId`] = assignment.employeeId;
        optionsEntities[`option${count}_type`] = 'SWAP';
      }
    }
    return { text, count };
  }

  /**
   * Step 3: user eligió un target shift → buildea el mensaje de
   * confirmación con ambos shifts descriptos.
   */
  private async _handleSwapSelectTarget(
    from: string,
    companyId: string,
    session: ConversationSessionVO,
    sessionEntities: Readonly<Record<string, any>>,
    selection: string,
    locale: string,
  ): Promise<boolean> {
    const targetShiftId = sessionEntities[`option${selection}_shiftId`];
    const targetType = sessionEntities[`option${selection}_type`];
    const targetEmployeeId = sessionEntities[`option${selection}_employeeId`];

    if (!targetShiftId || !targetType) {
      this._reply(from, this.i18n.t('bot.swap.invalid_choice', { lang: locale }));
      return true;
    }

    const ownShiftId = sessionEntities.selectedOwnShiftId;
    const { slots: allSlots, assignments: allAssignments } =
      await this._loadTwoWeekContext(companyId, new Date());

    const ownAssignment = allAssignments.find((a) => a.id === ownShiftId);
    const ownSlot = ownAssignment
      ? allSlots.find((s) => s.slotKey === ownAssignment.slotKey)
      : undefined;

    // Target puede ser un slotKey (OPEN) o el UUID de la assignment del compañero (SWAP)
    let targetSlot: VirtualShiftSlot | undefined;
    if (targetType === 'OPEN') {
      targetSlot = allSlots.find((s) => s.slotKey === targetShiftId);
    } else {
      const targetAssignment = allAssignments.find((a) => a.id === targetShiftId);
      targetSlot = targetAssignment
        ? allSlots.find((s) => s.slotKey === targetAssignment.slotKey)
        : undefined;
    }

    const ownDesc = ownSlot
      ? this._formatShiftLine(
          { shiftId: ownSlot.slotKey, startTime: ownSlot.startTime, endTime: ownSlot.endTime },
          locale,
        )
      : ownShiftId;
    const targetDesc = targetSlot
      ? this._formatShiftLine(
          { shiftId: targetSlot.slotKey, startTime: targetSlot.startTime, endTime: targetSlot.endTime },
          locale,
        )
      : targetShiftId;

    let confirmMsg: string;
    if (targetType === 'OPEN') {
      confirmMsg = this.i18n.t('bot.swap.confirm_open_prompt', {
        lang: locale,
        args: { myShift: ownDesc, targetShift: targetDesc },
      });
    } else {
      const employees = await this.employeeRepo.findAllByCompany(companyId);
      const targetName =
        employees.find((e) => e.id === targetEmployeeId)?.name || 'Compañero';
      confirmMsg = this.i18n.t('bot.swap.confirm_prompt', {
        lang: locale,
        args: { myShift: ownDesc, targetShift: targetDesc, targetName },
      });
    }

    const updated = session.withIntent('swap_shift', {
      pendingAction: 'swap_shift',
      swapStep: 'CONFIRM',
      selectedOwnShiftId: ownShiftId,
      selectedTargetShiftId: targetShiftId,
      selectedTargetEmployeeId: targetEmployeeId,
      selectedTargetType: targetType,
    });
    await this.sessionRepository.saveSession(updated);
    this._reply(from, confirmMsg);
    return true;
  }

  /**
   * Step 4: user confirma / cancela. Ejecuta TakeOpenShift o SwapShift
   * según el targetType guardado en sesión.
   */
  private async _handleSwapConfirm(
    from: string,
    employeeId: string,
    companyId: string,
    sessionEntities: Readonly<Record<string, any>>,
    selection: string,
    locale: string,
  ): Promise<boolean> {
    if (['sí', 'si', 'yes', 'y', '1'].includes(selection)) {
      const ownShiftId = sessionEntities.selectedOwnShiftId;
      const targetShiftId = sessionEntities.selectedTargetShiftId;
      const targetEmployeeId = sessionEntities.selectedTargetEmployeeId;
      const targetType = sessionEntities.selectedTargetType;

      const command =
        targetType === 'OPEN'
          ? new TakeOpenShiftCommand(employeeId, ownShiftId, targetShiftId, companyId)
          : new SwapShiftCommand(
              employeeId,
              ownShiftId,
              targetEmployeeId,
              targetShiftId,
              companyId,
            );
      await this.commandBus.execute(command);
      await this.sessionRepository.clearSession(from);
      this._reply(
        from,
        targetType === 'OPEN'
          ? this.i18n.t('bot.swap.open_shift_success', { lang: locale })
          : this.i18n.t('bot.swap.request_received', { lang: locale }),
      );
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

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async _classifyMessage(msg: IncomingMessage) {
    // Phase 14 — envolvemos la call del classifier con un scope del
    // LLMUsageTracker para capturar tokens. Lo guardamos en
    // `lastClassifierUsage` para que `route()` decida si acumularlos en
    // sesión (solo cuando el flow del manager es generate_schedule, así
    // el reply final puede mostrar el costo total incluyendo classifier).
    const isAudio = msg.mimeType?.startsWith('audio/') && msg.mediaUrl;
    const isText = !!msg.body && !msg.mediaUrl;

    if (!isText && !isAudio) {
      this.logger.warn(`Unsupported media type: ${msg.mimeType}`);
      this.lastClassifierUsage = { calls: 0, prompt: 0, completion: 0, total: 0 };
      return ConversationIntentVO.unknown('unsupported');
    }

    const { result, usage } = await this.llmUsageTracker.run(() =>
      // F.6 — etiqueta cada call del classifier con
      // operation='whatsapp_classify' + companyId del mensaje. Los
      // tokens persistidos alimentan el dashboard de costo por
      // subsistema.
      this.llmUsageLogger.withContext(
        {
          operation: isAudio ? 'whatsapp_classify_audio' : 'whatsapp_classify',
          companyId: msg.companyId,
        },
        async () => {
          if (isText) return this.conversationalService.processText(msg.body!);
          return this.conversationalService.processAudio(
            msg.mediaUrl!,
            msg.mimeType!,
            msg.twilioSid,
            msg.twilioToken,
          );
        },
      ),
    );
    this.lastClassifierUsage = usage;
    return result;
  }

  /**
   * Tokens consumidos por el último call al classifier. Set por
   * `_classifyMessage`, leído por `route()` para acumular en la sesión
   * cuando el flow es `generate_schedule`.
   */
  private lastClassifierUsage: { calls: number; prompt: number; completion: number; total: number } = {
    calls: 0,
    prompt: 0,
    completion: 0,
    total: 0,
  };

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
      shiftId = command.assignmentId;
    }

    if (!shiftId || shiftId.length >= UUID_LENGTH) {
      return command; // already a full UUID or not applicable
    }

    const fullId = await this.assignmentRepo.resolveShortId(shiftId, companyId);
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

  /**
   * Carga slots virtuales + asignaciones de la empresa para la semana que
   * contiene `reference` y la siguiente. Base común para swap/open-shift.
   */
  private async _loadTwoWeekContext(
    companyId: string,
    reference: Date,
  ): Promise<{ slots: VirtualShiftSlot[]; assignments: ShiftAssignment[] }> {
    const weekStartsOn = await this.companyPreferences.getWeekStartsOn(companyId);
    const w1Start = weekStartOf(reference, weekStartsOn);
    const w2Start = new Date(w1Start);
    w2Start.setUTCDate(w2Start.getUTCDate() + 7);

    const templates = await this.shiftTemplateRepo.findAllByCompany(companyId);
    const activeTemplates = templates.filter((t) => t.isActive);
    const slotsW1 = this.slotGenerator.generateSlotsForWeek(activeTemplates, w1Start);
    const slotsW2 = this.slotGenerator.generateSlotsForWeek(activeTemplates, w2Start);

    const fromISO = w1Start.toISOString().split('T')[0];
    const endOfW2 = new Date(w2Start);
    endOfW2.setUTCDate(endOfW2.getUTCDate() + 6);
    const toISO = endOfW2.toISOString().split('T')[0];
    const assignments = await this.assignmentRepo.findByCompanyAndDateRange(
      companyId,
      fromISO,
      toISO,
    );

    return { slots: [...slotsW1, ...slotsW2], assignments };
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

  /**
   * Persiste la WhatsappPendingClarification y le contesta al manager
   * la lista numerada de sugerencias. La sesión queda con
   * pendingAction='create_rule_clarification' + memoria de
   * priority/ruleType/branch para reconstruir el comando cuando el
   * manager elija una opción.
   */
  private async _persistAndReplyRuleClarification(
    from: string,
    employeeId: string,
    companyId: string,
    cmd: CreateSemanticRuleCommand,
    suggestions: NonNullable<CreateSemanticRuleResult['suggestions']>,
  ): Promise<void> {
    const persisted = suggestions.map((s) => ({
      id: s.id,
      suggestedText: s.suggestedText,
      meta: { previewIntent: s.previewIntent ?? null },
    }));

    const pending = WhatsappPendingClarification.create({
      employeeId,
      companyId,
      targetKind: 'rule',
      originalText: cmd.ruleText,
      suggestions: persisted,
    });
    await this.pendingClarificationRepo.save(pending);

    // Memoria en la sesión para reconstruir el comando cuando el
    // manager elija. Stringificamos porque las entities son
    // Record<string, string>.
    let session = await this.sessionRepository.getSession(from);
    if (!session) {
      session = ConversationSessionVO.create({ employeePhone: from, companyId });
    }
    session = session.withIntent('create_rule_clarification', {
      pendingAction: 'create_rule_clarification',
      rulePriority: String(cmd.priorityLevel),
      ruleType: cmd.ruleType,
      branchId: cmd.branchId ?? '',
    });
    await this.sessionRepository.saveSession(session);

    let msg = '⚠️ Tu regla es ambigua. Elegí una versión:\n\n';
    suggestions.forEach((s, i) => {
      msg += `${i + 1}. ${s.suggestedText}\n`;
    });
    msg += '\n_Respondé con el número (1, 2, 3...) o escribí una nueva regla._';
    this._reply(from, msg);
  }

  /**
   * Procesa la respuesta del manager al suggestion-loop. Devuelve true
   * si la respuesta fue manejada (la sesión ya quedó cerrada o lista
   * para el siguiente paso); false si el caller debe seguir el flow
   * normal.
   */
  private async _handleRuleClarificationResponse(
    from: string,
    employeeId: string,
    companyId: string,
    sessionEntities: Record<string, string>,
    intentEntities: Record<string, string>,
    rawText: string,
    locale: string,
  ): Promise<boolean> {
    const pending = await this.pendingClarificationRepo.findActiveByEmployee(
      employeeId,
      companyId,
    );
    if (!pending) {
      this._reply(
        from,
        '⏰ Esa propuesta ya expiró. Volvé a escribir la regla cuando quieras.',
      );
      await this.sessionRepository.clearSession(from);
      return true;
    }

    const selectionRaw = (intentEntities.selection ?? rawText).trim();
    const n = parseInt(selectionRaw, 10);
    if (Number.isNaN(n)) {
      // Texto libre — el manager está reformulando manualmente.
      // Marcamos la pending como resuelta para no dejar fantasmas y
      // dejamos que el flow normal procese el nuevo texto como una
      // creación fresh. Limpiamos la sesión para que no se mezcle.
      await this.pendingClarificationRepo.markResolved(pending.getId(), companyId);
      await this.sessionRepository.clearSession(from);
      return false; // que el flow normal haga su trabajo
    }

    const pick = pending.pickByNumber(n);
    if (!pick) {
      this._reply(
        from,
        `Número fuera de rango. Elegí entre 1 y ${pending.getSuggestions().length}, o escribí una regla nueva.`,
      );
      return true; // sesión sigue
    }

    await this.pendingClarificationRepo.markResolved(pending.getId(), companyId);

    const priority = parseInt(sessionEntities.rulePriority ?? '3', 10) as 1 | 2 | 3;
    const ruleType = (sessionEntities.ruleType ?? 'preference') as
      | 'restriction'
      | 'preference'
      | 'requirement';
    const branchId = sessionEntities.branchId
      ? sessionEntities.branchId
      : null;

    const cmd = new CreateSemanticRuleCommand(
      companyId,
      pick.suggestedText,
      priority,
      ruleType,
      employeeId,
      undefined,
      null,
      branchId,
    );

    const result = (await this._execute(cmd)) as unknown as CreateSemanticRuleResult;

    // Si la sugerencia elegida ALSO sale complex (improbable pero
    // posible — el LLM puede fallar en verificar), repetimos el loop.
    if (
      result &&
      typeof result === 'object' &&
      Array.isArray(result.suggestions) &&
      result.suggestions.length > 0
    ) {
      await this._persistAndReplyRuleClarification(
        from,
        employeeId,
        companyId,
        cmd,
        result.suggestions,
      );
      return true;
    }

    await this.sessionRepository.clearSession(from);
    this._reply(
      from,
      `✅ Regla creada: "${pick.suggestedText}"`,
    );
    return true;
  }

  /**
   * Handler del intent create_policy (tenant-wide). Llama a
   * CompanyPolicyCreator que se encarga del suggestion-loop. Tres
   * resultados:
   *   - 'created' + matched   → persistido con interpreter, reply ✓.
   *   - 'created' + llm_only  → persistido sin interpreter, reply con
   *                              warning honesto (el solver lo trata
   *                              como contexto LLM, no como constraint
   *                              hard).
   *   - 'needs_clarification' → persiste pending + reply numerado.
   */
  private async _handleCreatePolicy(
    from: string,
    employeeId: string,
    companyId: string,
    employee: { role: string } | null,
    mergedEntities: Record<string, string>,
    rawText: string,
    locale: string,
  ): Promise<boolean> {
    // Permiso configurable por tenant — mismo flow que create_rule.
    const allowed = employee
      ? await this.policyPermission.canCreatePolicy({
          employeeRole: employee.role,
          companyId,
        })
      : false;
    if (!allowed) {
      this._reply(
        from,
        this.i18n.t('bot.general.unauthorized', {
          lang: locale,
          defaultValue: '⚠️ No tienes permisos para crear políticas de la empresa.',
        }),
      );
      await this.sessionRepository.clearSession(from);
      return true;
    }

    const text = mergedEntities.ruleText ?? rawText.trim();
    if (!text || text.trim().length < 10) {
      this._reply(
        from,
        '⚠️ La política tiene que tener al menos 10 caracteres. Probá ser más específico.',
      );
      return true;
    }

    // Phase 14.2 — resolver scope si el LLM lo extrajo del texto.
    const resolvedScope = await this.policyScopeResolver.resolve({
      companyId,
      scopeType: mergedEntities.scopeType as PolicyScope['type'] | undefined,
      scopeName: mergedEntities.scopeName,
    });
    const scope = resolvedScope.scope;
    const scopeLabel = this._formatScopeLabel(scope, resolvedScope.targetName);

    const input: CreateCompanyPolicyInput = {
      companyId,
      text,
      severity: 'hard',
      scope,
      createdBy: employeeId,
    };
    const result = await this.companyPolicyCreator.create(input);

    if (result.status === 'needs_clarification') {
      // Persistimos las sugerencias y replicamos el suggestion-loop por mensaje.
      const persisted = result.suggestions.map((s) => ({
        id: s.id,
        suggestedText: s.suggestedText,
        meta: {
          matchedInterpreterId: s.matchedInterpreterId,
          matchedParams: s.matchedParams,
        },
      }));
      const pending = WhatsappPendingClarification.create({
        employeeId,
        companyId,
        targetKind: 'policy',
        originalText: text,
        suggestions: persisted,
      });
      await this.pendingClarificationRepo.save(pending);

      let session = await this.sessionRepository.getSession(from);
      if (!session) {
        session = ConversationSessionVO.create({ employeePhone: from, companyId });
      }
      session = session.withIntent('create_policy_clarification', {
        pendingAction: 'create_policy_clarification',
        policySeverity: 'hard',
        // Phase 14.2 — recordamos el scope resuelto para que la elección
        // de la sugerencia (handler de clarification) lo pueda reusar.
        policyScopeType: scope.type,
        policyScopeId: scope.id ?? '',
      });
      await this.sessionRepository.saveSession(session);

      let msg = '⚠️ Tu política es ambigua. Elegí una versión:\n\n';
      result.suggestions.forEach((s, i) => {
        msg += `${i + 1}. ${s.suggestedText}\n`;
      });
      msg += scopeLabel ? `\n_(Alcance detectado: ${scopeLabel})_\n` : '';
      msg += '\n_Respondé con el número (1, 2, 3...) o escribí una nueva política._';
      this._reply(from, msg);
      return true;
    }

    // status === 'created'
    await this.sessionRepository.clearSession(from);
    const scopeSuffix = scopeLabel ? ` (alcance: ${scopeLabel})` : '';
    if (result.mode === 'matched') {
      this._reply(
        from,
        `✅ Política creada y aplicable directamente${scopeSuffix}: "${result.policy.getText()}"`,
      );
    } else {
      // mode === 'llm_only' — guardamos pero el solver no la aplica
      // determinísticamente; advertimos al manager.
      this._reply(
        from,
        `⚠️ Política guardada como LLM-only${scopeSuffix}: "${result.policy.getText()}". El scheduler determinístico no la aplica directo; solo la considera al pasarla al LLM. Si querés que se aplique automáticamente, reformulala matcheando un patrón estructurado.`,
      );
    }
    return true;
  }

  /**
   * Phase 14.2 — render legible del scope para el reply al manager.
   * Devuelve null para scope=company (no hace falta decoración).
   */
  private _formatScopeLabel(scope: PolicyScope, targetName: string | null): string | null {
    if (scope.type === 'company') return null;
    const label =
      scope.type === 'branch'
        ? 'sucursal'
        : scope.type === 'department'
          ? 'departamento'
          : 'empleado';
    return targetName ? `${label} "${targetName}"` : label;
  }

  /**
   * Procesa la respuesta del manager al suggestion-loop de policy.
   * Espejo de _handleRuleClarificationResponse pero usando el
   * CompanyPolicyCreator con el texto elegido.
   */
  private async _handlePolicyClarificationResponse(
    from: string,
    employeeId: string,
    companyId: string,
    sessionEntities: Record<string, string>,
    intentEntities: Record<string, string>,
    rawText: string,
    locale: string,
  ): Promise<boolean> {
    const pending = await this.pendingClarificationRepo.findActiveByEmployee(
      employeeId,
      companyId,
    );
    if (!pending || pending.getTargetKind() !== 'policy') {
      this._reply(
        from,
        '⏰ Esa propuesta de política ya expiró. Volvé a escribirla cuando quieras.',
      );
      await this.sessionRepository.clearSession(from);
      return true;
    }

    const selectionRaw = (intentEntities.selection ?? rawText).trim();
    const n = parseInt(selectionRaw, 10);
    if (Number.isNaN(n)) {
      // Texto libre — el manager está reformulando manualmente.
      // Cleanup + dejar que el flow normal lo procese.
      await this.pendingClarificationRepo.markResolved(pending.getId(), companyId);
      await this.sessionRepository.clearSession(from);
      return false;
    }

    const pick = pending.pickByNumber(n);
    if (!pick) {
      this._reply(
        from,
        `Número fuera de rango. Elegí entre 1 y ${pending.getSuggestions().length}, o escribí una política nueva.`,
      );
      return true;
    }

    await this.pendingClarificationRepo.markResolved(pending.getId(), companyId);

    const severity = (sessionEntities.policySeverity ?? 'hard') as 'hard' | 'soft';
    // Phase 14.2 — recuperamos el scope decidido cuando se abrió el loop.
    const persistedScopeType = sessionEntities.policyScopeType as
      | PolicyScope['type']
      | undefined;
    const persistedScopeId = sessionEntities.policyScopeId;
    const scope: PolicyScope | undefined = persistedScopeType
      ? {
          type: persistedScopeType,
          id:
            persistedScopeType === 'company'
              ? null
              : persistedScopeId && persistedScopeId.length > 0
                ? persistedScopeId
                : null,
        }
      : undefined;
    const result = await this.companyPolicyCreator.create({
      companyId,
      text: pick.suggestedText,
      severity,
      scope,
      createdBy: employeeId,
    });

    // Si la sugerencia elegida ALSO sale needs_clarification (improbable,
    // estaban pre-verificadas), repetimos el loop.
    if (result.status === 'needs_clarification') {
      const persisted = result.suggestions.map((s) => ({
        id: s.id,
        suggestedText: s.suggestedText,
        meta: {
          matchedInterpreterId: s.matchedInterpreterId,
          matchedParams: s.matchedParams,
        },
      }));
      const newPending = WhatsappPendingClarification.create({
        employeeId,
        companyId,
        targetKind: 'policy',
        originalText: pick.suggestedText,
        suggestions: persisted,
      });
      await this.pendingClarificationRepo.save(newPending);

      let msg = '⚠️ La elección sigue siendo ambigua. Elegí otra:\n\n';
      result.suggestions.forEach((s, i) => {
        msg += `${i + 1}. ${s.suggestedText}\n`;
      });
      msg += '\n_Respondé con el número o escribí una nueva._';
      this._reply(from, msg);
      return true;
    }

    await this.sessionRepository.clearSession(from);
    if (result.mode === 'matched') {
      this._reply(
        from,
        `✅ Política creada: "${result.policy.getText()}"`,
      );
    } else {
      this._reply(
        from,
        `⚠️ Política guardada como LLM-only: "${result.policy.getText()}". El scheduler la considera como contexto pero no la aplica determinísticamente.`,
      );
    }
    return true;
  }

  // ── Phase 18.4 — absence report short-paths ──────────────────────────

  /**
   * Atajo del flow `report_absence` cuando el LLM extrajo period o
   * targetEmployeeName. Devuelve `true` si se manejó (no seguir con el
   * FETCH_SHIFTS guiado), `false` si hay que caer al flow legacy.
   *
   * Reglas:
   *  - manager-on-behalf: targetEmployeeName + remitente con role='manager'.
   *    Resuelve nombre → employeeId via fuzzy match. Si 0 → mensaje "no
   *    encontrado". Si >1 → lista candidatos y pide especificar (sin
   *    suggestion-loop persistente; el manager re-envía con apellido).
   *  - self-period: startDate/endDate (con o sin equality), reporter es
   *    el target.
   *  - reason mínimo: si no hay reason, pide reason inline (no creator
   *    sin razón).
   */
  private async _tryHandleAbsenceShortPath(
    from: string,
    senderEmployeeId: string,
    companyId: string,
    entities: IntentEntities,
    locale: string,
  ): Promise<boolean> {
    const startDate = entities.startDate ?? entities.date;
    const endDate = entities.endDate ?? startDate;
    const targetName = entities.targetEmployeeName?.trim();

    // Sin period y sin target → no aplica este short-path; flow legacy.
    if (!startDate && !targetName) return false;

    // Reason obligatorio para ambos casos.
    if (!entities.reason || !entities.reason.trim()) {
      this._reply(
        from,
        this.i18n.t('bot.absence.missing_reason', { lang: locale }),
      );
      return true;
    }

    // Resolver target: o el remitente (self) o el empleado mencionado.
    let targetEmployeeId = senderEmployeeId;
    let targetEmployeeName = '';
    if (targetName) {
      const sender = await this.employeeRepo.findById(senderEmployeeId, companyId);
      if (!sender || sender.role !== 'manager') {
        this._reply(
          from,
          this.i18n.t('bot.absence.manager_only', { lang: locale }),
        );
        return true;
      }
      const matches = await this._resolveEmployeeByName(companyId, targetName);
      if (matches.length === 0) {
        this._reply(
          from,
          this.i18n.t('bot.absence.name_not_found', {
            lang: locale,
            args: { name: targetName },
          }),
        );
        return true;
      }
      if (matches.length > 1) {
        const list = matches
          .slice(0, 5)
          .map((e, i) => `${i + 1}. ${e.name}${e.phone ? ` (${e.phone})` : ''}`)
          .join('\n');
        this._reply(
          from,
          this.i18n.t('bot.absence.name_ambiguous', {
            lang: locale,
            args: { name: targetName, list },
          }),
        );
        return true;
      }
      targetEmployeeId = matches[0].id;
      targetEmployeeName = matches[0].name;
    } else {
      const self = await this.employeeRepo.findById(senderEmployeeId, companyId);
      targetEmployeeName = self?.name ?? '';
    }

    // Llamar al creator. Devuelve report (puede ser null) + rules creadas.
    try {
      const result = await this.absenceCreator.create({
        companyId,
        employeeId: targetEmployeeId,
        reason: entities.reason!.trim(),
        startDate: startDate ?? undefined,
        endDate: endDate ?? undefined,
        // El audit del actor queda en metadata.source de la rule. La
        // FK created_by exige UUID válido, así que pasamos solo el
        // UUID del remitente sin prefix.
        createdByUserId: senderEmployeeId,
      });

      // Mensaje de confirmación al remitente — todo via i18n.
      const isSingleDay = startDate === endDate;
      const lines: string[] = [
        isSingleDay
          ? this.i18n.t('bot.absence.registered_for_period_single', {
              lang: locale,
              args: { name: targetEmployeeName, date: startDate },
            })
          : this.i18n.t('bot.absence.registered_for_period_range', {
              lang: locale,
              args: {
                name: targetEmployeeName,
                start: startDate,
                end: endDate,
              },
            }),
      ];

      if (result.deletedAssignmentIds.length > 0) {
        const n = result.deletedAssignmentIds.length;
        lines.push(
          this.i18n.t(
            n === 1
              ? 'bot.absence.deleted_assignments_single'
              : 'bot.absence.deleted_assignments_other',
            { lang: locale, args: { count: n } },
          ),
        );
      } else {
        // Sin deletes — distinguimos "semana generada sin turnos del
        // empleado" vs "semana sin generar". Si hay assignments de OTROS
        // empleados en el rango, decimos explícito que el empleado no
        // tenía turno; si no hay nada, omitimos (la rule futura ya
        // explica que el scheduler la respetará).
        const otherAssignments = await this.assignmentRepo.findByCompanyAndDateRange(
          companyId,
          startDate ?? '',
          endDate ?? '',
        );
        if (otherAssignments.length > 0) {
          lines.push(
            this.i18n.t('bot.absence.no_shift_in_period', {
              lang: locale,
              args: { name: targetEmployeeName },
            }),
          );
        }
      }

      if (result.rulesCreated.length > 0) {
        const n = result.rulesCreated.length;
        lines.push(
          this.i18n.t(
            n === 1
              ? 'bot.absence.rules_created_single'
              : 'bot.absence.rules_created_other',
            { lang: locale, args: { count: n } },
          ),
        );
      }

      this._reply(from, lines.join('\n'));
      return true;
    } catch (err) {
      this.logger.error(
        `_tryHandleAbsenceShortPath failed: ${(err as Error).message}`,
      );
      this._reply(
        from,
        this.i18n.t('bot.absence.create_failed', { lang: locale }),
      );
      return true;
    }
  }

  /**
   * Phase 18.6 — manager-on-behalf para check_schedule. Si el remitente
   * es manager y mencionó otro empleado, resuelve el nombre y dispatcha
   * GetMyScheduleQuery contra ese empleado. Reutiliza los mensajes i18n
   * de bot.absence.* (manager_only / name_not_found / name_ambiguous)
   * porque la lógica de resolución es idéntica.
   */
  private async _tryHandleScheduleOnBehalf(
    from: string,
    senderEmployeeId: string,
    companyId: string,
    entities: IntentEntities,
    locale: string,
  ): Promise<boolean> {
    const targetName = entities.targetEmployeeName!.trim();

    const sender = await this.employeeRepo.findById(senderEmployeeId, companyId);
    if (!sender || sender.role !== 'manager') {
      this._reply(from, this.i18n.t('bot.absence.manager_only', { lang: locale }));
      return true;
    }

    const matches = await this._resolveEmployeeByName(companyId, targetName);
    if (matches.length === 0) {
      this._reply(
        from,
        this.i18n.t('bot.absence.name_not_found', {
          lang: locale,
          args: { name: targetName },
        }),
      );
      return true;
    }
    if (matches.length > 1) {
      const list = matches
        .slice(0, 5)
        .map((e, i) => `${i + 1}. ${e.name}${e.phone ? ` (${e.phone})` : ''}`)
        .join('\n');
      this._reply(
        from,
        this.i18n.t('bot.absence.name_ambiguous', {
          lang: locale,
          args: { name: targetName, list },
        }),
      );
      return true;
    }

    const target = matches[0];
    const weekStart = entities.weekStart || entities.date;
    const reply = await this.queryBus.execute<GetMyScheduleQuery, string>(
      new GetMyScheduleQuery(target.id, companyId, weekStart, locale, target.name),
    );
    this._reply(from, reply);
    return true;
  }

  /**
   * Resolución por nombre — case-insensitive, contiene match. v1: si el
   * input es solo primer nombre y hay 2+ empleados con ese nombre,
   * devolvemos la lista para que el manager especifique. Sin Levenshtein
   * todavía; la fuzziness real se agrega cuando aparezcan typos en prod.
   */
  private async _resolveEmployeeByName(
    companyId: string,
    nameQuery: string,
  ): Promise<Array<{ id: string; name: string; phone: string }>> {
    const { data, error } = await this.supabase
      .from('employees')
      .select('id, name, phone_number')
      .eq('company_id', companyId)
      .ilike('name', `%${nameQuery}%`);
    if (error) {
      this.logger.warn(`_resolveEmployeeByName failed: ${error.message}`);
      return [];
    }
    return (data ?? []).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      phone: (r.phone_number as string) ?? '',
    }));
  }

  /**
   * Flow legacy de report_absence cuando el LLM no extrajo shiftId/period.
   * Intenta short-paths primero (manager-on-behalf, period explícito); si
   * no aplican, lista los próximos turnos del empleado y pide selección.
   *
   * Devuelve `true` cuando manejó el reply (caller debe `return`).
   */
  private async _handleAbsenceFetchShifts(
    from: string,
    employeeId: string,
    companyId: string,
    session: ConversationSessionVO,
    mergedEntities: Record<string, any>,
    locale: string,
  ): Promise<boolean> {
    // Phase 18.4 — antes del flow legacy, intentamos atajos:
    //   (a) manager-on-behalf: targetEmployeeName presente Y remitente
    //       tiene role='manager'.
    //   (b) period: startDate/endDate explícitos.
    const shortPathHandled = await this._tryHandleAbsenceShortPath(
      from,
      employeeId,
      companyId,
      mergedEntities,
      locale,
    );
    if (shortPathHandled) return true;

    const rawShifts = await this.queryBus.execute<
      GetUpcomingShiftsQuery,
      UpcomingShiftDto[]
    >(new GetUpcomingShiftsQuery(employeeId, companyId, 5));

    if (rawShifts.length === 0) {
      this._reply(from, this.i18n.t('bot.absence.no_shifts', { lang: locale }));
      return true;
    }

    const shifts = this._filterUpcomingShifts(rawShifts, mergedEntities);

    if (shifts.length === 1) {
      await this._promptAbsenceConfirmationForSingleShift(
        from,
        session,
        mergedEntities,
        shifts[0],
        locale,
      );
      return true;
    }

    await this._promptAbsenceShiftListSelection(
      from,
      session,
      mergedEntities,
      shifts,
      locale,
    );
    return true;
  }

  /**
   * Filtra los upcoming shifts por `date` y `timeOfDay` que el LLM
   * pudo haber extraído. Si el filtro deja 0, fallback al set original
   * (mejor mostrar más que dejar al user sin opciones).
   */
  private _filterUpcomingShifts(
    rawShifts: UpcomingShiftDto[],
    entities: Record<string, any>,
  ): UpcomingShiftDto[] {
    let filtered = rawShifts;
    if (entities.date) {
      filtered = filtered.filter((s) =>
        new Date(s.startTime).toISOString().startsWith(entities.date!),
      );
    }
    if (entities.timeOfDay && filtered.length > 1) {
      filtered = filtered.filter((s) => {
        const h = new Date(s.startTime).getHours();
        if (entities.timeOfDay === 'morning') return h < 12;
        if (entities.timeOfDay === 'afternoon') return h >= 12 && h < 18;
        if (entities.timeOfDay === 'night') return h >= 18;
        return true;
      });
    }
    return filtered.length > 0 ? filtered : rawShifts;
  }

  private async _promptAbsenceConfirmationForSingleShift(
    from: string,
    session: ConversationSessionVO,
    mergedEntities: Record<string, any>,
    shift: UpcomingShiftDto,
    locale: string,
  ): Promise<void> {
    const dateStr = new Date(shift.startTime).toLocaleDateString('es-ES', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const startHora = new Date(shift.startTime).toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const endHora = new Date(shift.endTime).toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const shiftStr = `${dateStr}, de ${startHora} a ${endHora}`;
    const updated = session.withIntent('report_absence', {
      ...mergedEntities,
      pendingAction: 'report_absence',
      pendingConfirmationShiftId: shift.shiftId,
    });
    await this.sessionRepository.saveSession(updated);

    const resp = this.i18n.t('bot.absence.confirm_single_shift', {
      lang: locale,
      args: {
        shiftStr,
        reasonPrompt: mergedEntities.reason
          ? ''
          : this.i18n.t('bot.absence.reason_prompt', { lang: locale }),
      },
    });
    this._reply(from, resp.trim());
  }

  /**
   * Pre-execute branch para CreateSemanticRule: chequea permiso
   * (`canCreatePolicy`), y si el tenant tiene >1 sucursal abre el flow
   * SELECT_SCOPE; con 1 sucursal completa el branch_id en el comando;
   * sin sucursales el comando queda como llegó (scope global).
   *
   * Devuelve `true` si manejó el reply (caller debe `return`); `false`
   * si solo mutó `mapResult.command` y route() debe seguir al execute.
   */
  private async _handleSemanticRuleScopeBranch(
    from: string,
    companyId: string,
    employee: Employee | null,
    session: ConversationSessionVO,
    mapResult: { command: object | null },
    locale: string,
  ): Promise<boolean> {
    const allowed = employee
      ? await this.policyPermission.canCreatePolicy({
          employeeRole: employee.role,
          companyId,
        })
      : false;
    if (!allowed) {
      this._reply(
        from,
        this.i18n.t('bot.general.unauthorized', {
          lang: locale,
          defaultValue: '⚠️ No tienes permisos para crear reglas de negocio.',
        }),
      );
      await this.sessionRepository.clearSession(from);
      return true;
    }

    const { data: branches, error } = await this.supabase
      .from('branches')
      .select('id, name')
      .eq('company_id', companyId);

    if (!error && branches && branches.length > 1) {
      let responseText = `Veo que la empresa tiene múltiples sucursales. ¿A qué sucursal aplica esta regla?\n\n0. A todas las sucursales (Global)\n`;
      const optionsEntities: Record<string, string> = {
        pendingAction: 'create_rule',
        ruleStep: 'SELECT_SCOPE',
      };
      branches.slice(0, 8).forEach((b, idx) => {
        const num = idx + 1;
        responseText += `${num}. ${b.name}\n`;
        optionsEntities[`option${num}_branchId`] = b.id;
      });

      const updated = session.withAction('RULE_SELECT_SCOPE', {
        ...optionsEntities,
        commandPayload: { ...mapResult.command },
      });
      await this.sessionRepository.saveSession(updated);
      this._reply(from, responseText.trim());
      return true;
    }

    if (!error && branches && branches.length === 1) {
      const mCmd = mapResult.command as CreateSemanticRuleCommand;
      mapResult.command = new CreateSemanticRuleCommand(
        mCmd.companyId,
        mCmd.ruleText,
        mCmd.priorityLevel,
        mCmd.ruleType,
        mCmd.createdBy,
        mCmd.metadata,
        mCmd.expiresAt,
        branches[0].id,
      );
    }
    return false;
  }

  /**
   * Final steps de route(): resolver short-IDs → execute → interceptar
   * suggestion-loop si la regla salió complex → formatear reply (incluye
   * warnings si vienen).
   */
  private async _resolveExecuteAndReply(
    from: string,
    employeeId: string,
    companyId: string,
    rawCommand: object,
    locale: string,
  ): Promise<void> {
    const command = await this._resolveShortShiftId(
      rawCommand,
      companyId,
      from,
      locale,
    );
    if (!command) return; // resolution failed, user was notified

    const result = await this._execute(command);

    // Suggestion-loop interception: CreateSemanticRuleHandler puede
    // marcar la regla como complex y devolver suggestions sin persistir.
    // Persistimos una WhatsappPendingClarification y replicamos el
    // suggestion-loop de la web por mensaje.
    if (command instanceof CreateSemanticRuleCommand && result && typeof result === 'object') {
      const ruleResult = result as CreateSemanticRuleResult;
      if (Array.isArray(ruleResult.suggestions) && ruleResult.suggestions.length > 0) {
        await this._persistAndReplyRuleClarification(
          from,
          employeeId,
          companyId,
          command,
          ruleResult.suggestions,
        );
        return;
      }
    }

    await this.sessionRepository.clearSession(from);

    let reply = this.i18n.t('bot.general.success', { lang: locale });
    if (typeof result === 'string') {
      reply = result;
    } else {
      const resObj = result as any;
      if (resObj && typeof resObj === 'object' && resObj.explanation) {
        reply = resObj.explanation;
      }
      // Anexar warnings (reglas en supervisión manual, turnos sin cubrir).
      if (resObj && Array.isArray(resObj.warnings) && resObj.warnings.length > 0) {
        reply +=
          `\n\n⚠️ *Requieren tu revisión:*\n` +
          resObj.warnings.map((w: string) => `• ${w}`).join('\n');
      }
    }
    this._reply(from, reply);
  }

  /**
   * Selección de scope (sucursal) al crear una semantic rule cuando el
   * tenant tiene >1 branch. La sesión guarda el payload del Command
   * pendiente; al elegir el branch, reconstruimos y ejecutamos.
   */
  private async _handleRuleScopeSelection(
    from: string,
    session: ConversationSessionVO,
    rawText: string,
    intentEntities: Record<string, any>,
    locale: string,
  ): Promise<void> {
    const selection =
      intentEntities.selection?.toLowerCase() || rawText.trim().toLowerCase();
    const payload = session.getActionPayload()!;
    let targetBranchId: string | undefined | null;

    if (
      selection === '0' ||
      selection === 'todas' ||
      selection === 'todas las sucursales'
    ) {
      targetBranchId = null; // global
    } else {
      targetBranchId = payload[`option${selection}_branchId`];
      if (!targetBranchId) {
        this._reply(from, this.i18n.t('bot.general.invalid_choice', { lang: locale }));
        return;
      }
    }

    const baseCmd = payload.commandPayload;
    const cmd = new CreateSemanticRuleCommand(
      baseCmd.companyId,
      baseCmd.ruleText,
      baseCmd.priorityLevel,
      baseCmd.ruleType,
      baseCmd.createdBy,
      baseCmd.metadata,
      baseCmd.expiresAt ? new Date(baseCmd.expiresAt) : null,
      targetBranchId,
    );
    await this._execute(cmd);
    await this.sessionRepository.clearSession(from);
    this._reply(from, this.i18n.t('bot.general.success', { lang: locale }));
  }

  /**
   * Flow jerárquico de generate_schedule: SELECT_BRANCH → SELECT_DEPARTMENT
   * → SELECT_TEMPLATE. Niveles con 0/1 opción se auto-resuelven; con >1
   * se pregunta al user. Si el tenant no tiene estructura (sin branches
   * ni departments), genera el horario completo al toque.
   */
  private async _handleGenerateScheduleHierarchicalFlow(
    from: string,
    companyId: string,
    session: ConversationSessionVO,
    mergedEntities: Record<string, any>,
    locale: string,
  ): Promise<void> {
    const weekStartsOn = await this.companyPreferences.getWeekStartsOn(companyId);
    const weekStart = mergedEntities.weekStart || nextWeekStartIso(weekStartsOn);
    const branches = await this._loadBranches(companyId);
    const departments = await this._loadDepartments(companyId);

    // Caso degenerado: tenant sin estructura. Generamos directo (todo).
    if (branches.length === 0 && departments.length === 0) {
      const command = new GenerateHybridScheduleCommand(companyId, weekStart);
      await this._execute(command);
      await this.sessionRepository.clearSession(from);
      this._reply(from, this.i18n.t('bot.general.success', { lang: locale }));
      return;
    }

    // ── ¿Smart-skip de branch? ──
    let chosenBranchId: string | null;
    if (branches.length <= 1) {
      chosenBranchId = branches[0]?.id ?? null;
    } else {
      await this._promptBranchSelection(from, session, mergedEntities, branches, weekStart);
      return;
    }

    // ── ¿Smart-skip de department? ──
    const deptsForBranch = chosenBranchId
      ? departments.filter((d) => d.branchId === chosenBranchId)
      : departments;
    let chosenDeptId: string | null;
    if (deptsForBranch.length <= 1) {
      chosenDeptId = deptsForBranch[0]?.id ?? null;
    } else {
      await this._promptDepartmentSelection(
        from,
        session,
        mergedEntities,
        deptsForBranch,
        weekStart,
        chosenBranchId,
      );
      return;
    }

    // ── SELECT_TEMPLATE (filtrado por dept si lo tenemos) ──
    await this._promptTemplateSelection(
      from,
      session,
      mergedEntities,
      companyId,
      weekStart,
      chosenDeptId,
      locale,
    );
  }

  private async _promptBranchSelection(
    from: string,
    session: ConversationSessionVO,
    mergedEntities: Record<string, any>,
    branches: Array<{ id: string; name: string }>,
    weekStart: string,
  ): Promise<void> {
    let responseText = `¿Para qué sucursal querés generar el horario?\n\n`;
    const optionsEntities: Record<string, string> = {
      pendingAction: 'generate_schedule',
      generateStep: 'SELECT_BRANCH',
      weekStart,
    };
    branches.slice(0, 5).forEach((b, idx) => {
      const num = idx + 1;
      responseText += `${num}. ${b.name}\n`;
      optionsEntities[`option${num}_branchId`] = b.id;
    });
    const updated = session.withIntent('generate_schedule', {
      ...mergedEntities,
      ...optionsEntities,
    });
    await this.sessionRepository.saveSession(updated);
    this._reply(from, responseText.trim());
  }

  private async _promptDepartmentSelection(
    from: string,
    session: ConversationSessionVO,
    mergedEntities: Record<string, any>,
    departments: Array<{ id: string; name: string; branchId: string | null }>,
    weekStart: string,
    chosenBranchId: string | null,
  ): Promise<void> {
    let responseText = `¿Para qué departamento?\n\n`;
    const optionsEntities: Record<string, string> = {
      pendingAction: 'generate_schedule',
      generateStep: 'SELECT_DEPARTMENT',
      weekStart,
      ...(chosenBranchId ? { selectedBranchId: chosenBranchId } : {}),
    };
    departments.slice(0, 5).forEach((d, idx) => {
      const num = idx + 1;
      responseText += `${num}. ${d.name}\n`;
      optionsEntities[`option${num}_departmentId`] = d.id;
    });
    const updated = session.withIntent('generate_schedule', {
      ...mergedEntities,
      ...optionsEntities,
    });
    await this.sessionRepository.saveSession(updated);
    this._reply(from, responseText.trim());
  }

  private async _promptAbsenceShiftListSelection(
    from: string,
    session: ConversationSessionVO,
    mergedEntities: Record<string, any>,
    shifts: UpcomingShiftDto[],
    locale: string,
  ): Promise<void> {
    let responseText = this.i18n.t('bot.absence.select_shift', { lang: locale });
    const optionsEntities: Record<string, string> = {
      pendingAction: 'report_absence',
    };
    shifts.slice(0, 3).forEach((shift, index) => {
      const num = index + 1;
      const dateStr = new Date(shift.startTime).toLocaleDateString('es-ES', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const startHora = new Date(shift.startTime).toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const endHora = new Date(shift.endTime).toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const ds = `${dateStr}, de ${startHora} a ${endHora}`;
      responseText += `${num}. ${ds}\n`;
      optionsEntities[`option${num}_shiftId`] = shift.shiftId;
    });

    const updated = session.withIntent('report_absence', {
      ...mergedEntities,
      ...optionsEntities,
    });
    await this.sessionRepository.saveSession(updated);

    if (!mergedEntities.reason) {
      responseText += this.i18n.t('bot.absence.reason_prompt_inline', {
        lang: locale,
      });
    }
    this._reply(from, responseText.trim());
  }
}
