import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { IConversationalService } from '../../domain/services/conversational.service.interface';
import { CONVERSATIONAL_SERVICE } from '../../domain/services/conversational.service.interface';
import type { INotificationService } from '../../domain/services/notification.service';
import { NOTIFICATION_SERVICE } from '../../domain/services/notification.service';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import { ShiftSlotGeneratorService } from '../../domain/services/shift-slot-generator.service';
import type { VirtualShiftSlot } from '../../domain/value-objects/virtual-shift-slot.vo';
import type { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import { ConversationSessionRepository } from '../../infrastructure/conversational/conversation-session.repository';
import { ConversationSessionVO } from '../../domain/value-objects/conversation-session.vo';
import { ConversationIntentVO } from '../../domain/value-objects/conversation-intent.vo';
import { GetMyScheduleQuery } from '../queries/get-my-schedule.query';
import { GetUpcomingShiftsQuery } from '../queries/get-upcoming-shifts.query';
import type { UpcomingShiftDto } from '../handlers/get-upcoming-shifts.handler';
import { CommandMapperService } from './command-mapper.service';
import { SwapShiftCommand } from '../commands/swap-shift.command';
import { TakeOpenShiftCommand } from '../commands/take-open-shift.command';
import { ReportAbsenceCommand } from '../commands/report-absence.command';
import { GenerateHybridScheduleCommand } from '../commands/generate-hybrid-schedule.command';
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
        const rawText = intent.getRawText().trim().toLowerCase();
        const selection = intentEntities.selection?.toLowerCase() || rawText;

        const payload = session.getActionPayload()!;
        let targetBranchId: string | undefined | null = undefined;

        if (selection === '0' || selection === 'todas' || selection === 'todas las sucursales') {
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
             targetBranchId
        );
        await this._execute(cmd);
        await this.sessionRepository.clearSession(from);
        this._reply(from, this.i18n.t('bot.general.success', { lang: locale }));
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
        // Permiso configurable por tenant (commits 9 / follow-up). Antes
        // estaba hardcodeado a role==='manager'; ahora cada tenant
        // ajusta companies.whatsapp_policy_creator_roles.
        const allowed = employee
          ? await this.policyPermission.canCreatePolicy({
              employeeRole: employee.role,
              companyId,
            })
          : false;
        if (!allowed) {
          this._reply(from, this.i18n.t('bot.general.unauthorized', { lang: locale, defaultValue: '⚠️ No tienes permisos para crear reglas de negocio.' }));
          await this.sessionRepository.clearSession(from);
          return;
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

          session = session.withAction('RULE_SELECT_SCOPE', {
              ...optionsEntities,
              commandPayload: { ...mapResult.command }
          });
          await this.sessionRepository.saveSession(session);
          this._reply(from, responseText.trim());
          return;
        } else if (!error && branches && branches.length === 1) {
          const mCmd = mapResult.command as CreateSemanticRuleCommand;
          mapResult.command = new CreateSemanticRuleCommand(
             mCmd.companyId,
             mCmd.ruleText,
             mCmd.priorityLevel,
             mCmd.ruleType,
             mCmd.createdBy,
             mCmd.metadata,
             mCmd.expiresAt,
             branches[0].id
          );
        }
      }

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

      // 4c. Handle GENERATE_SELECT_TEMPLATE — flow jerárquico:
      //     [SELECT_BRANCH if >1] → [SELECT_DEPARTMENT if >1] → SELECT_TEMPLATE.
      //     Niveles con 1 sola opción se auto-seleccionan (smart-skip).
      if (mapResult.actionRequired === 'GENERATE_SELECT_TEMPLATE') {
        const weekStart = mergedEntities.weekStart || this._getNextMondayStr();
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
          // >1 sucursal — preguntar.
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
          session = session.withIntent('generate_schedule', {
            ...mergedEntities,
            ...optionsEntities,
          });
          await this.sessionRepository.saveSession(session);
          this._reply(from, responseText.trim());
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
          let responseText = `¿Para qué departamento?\n\n`;
          const optionsEntities: Record<string, string> = {
            pendingAction: 'generate_schedule',
            generateStep: 'SELECT_DEPARTMENT',
            weekStart,
            ...(chosenBranchId ? { selectedBranchId: chosenBranchId } : {}),
          };
          deptsForBranch.slice(0, 5).forEach((d, idx) => {
            const num = idx + 1;
            responseText += `${num}. ${d.name}\n`;
            optionsEntities[`option${num}_departmentId`] = d.id;
          });
          session = session.withIntent('generate_schedule', {
            ...mergedEntities,
            ...optionsEntities,
          });
          await this.sessionRepository.saveSession(session);
          this._reply(from, responseText.trim());
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

      // 6.5 Suggestion-loop interception: si CreateSemanticRuleHandler
      // marcó la regla como complex y devolvió suggestions, NO se persistió.
      // Persistimos una WhatsappPendingClarification y replicamos el
      // suggestion-loop de la web por mensaje. La sesión queda con
      // pendingAction='create_rule_clarification' a la espera de la
      // elección del manager.
      if (
        command instanceof CreateSemanticRuleCommand &&
        result &&
        typeof result === 'object'
      ) {
        const ruleResult = result as CreateSemanticRuleResult;
        if (
          Array.isArray(ruleResult.suggestions) &&
          ruleResult.suggestions.length > 0
        ) {
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
          // Anexar warnings (reglas en supervisión manual, turnos sin cubrir, etc.)
          if (resObj && Array.isArray(resObj.warnings) && resObj.warnings.length > 0) {
              reply += `\n\n⚠️ *Requieren tu revisión:*\n` +
                  resObj.warnings.map((w: string) => `• ${w}`).join('\n');
          }
      }
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
      const result = await this.commandBus.execute(cmd);
      this._reply(from, this._formatScheduleReply(result, locale, sessionEntities));
      await this.sessionRepository.clearSession(from);
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
      const result = await this.commandBus.execute(cmd);
      this._reply(from, this._formatScheduleReply(result, locale, sessionEntities));
      await this.sessionRepository.clearSession(from);
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
      const result = await this.commandBus.execute(cmd);
      this._reply(from, this._formatScheduleReply(result, locale, sessionEntities));
      await this.sessionRepository.clearSession(from);
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

  private _getNextMondayStr(): string {
    const d = new Date();
    const day = d.getDay();
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMonday);
    return d.toISOString().split('T')[0];
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

    // ── Step 2 & 2b: User selected their own shift OR selected the swap type ──
    if (step === 'SELECT_OWN' || step === 'SELECT_SWAP_TYPE') {
      const shiftId = step === 'SELECT_OWN'
        ? sessionEntities[`option${selection}_shiftId`]
        : sessionEntities.selectedOwnShiftId;

      if (!shiftId) {
        this._reply(from, this.i18n.t('bot.swap.invalid_choice', { lang: locale }));
        return true;
      }

      const now = new Date();
      const { slots: allSlots, assignments: allAssignments } =
        await this._loadTwoWeekContext(companyId, now);

      // Open slots: aún tienen capacidad libre (y el cierre es futuro)
      const fillBySlotKey = new Map<string, number>();
      for (const a of allAssignments) {
        fillBySlotKey.set(a.slotKey, (fillBySlotKey.get(a.slotKey) ?? 0) + 1);
      }
      const openSlots = allSlots.filter((s) => {
        if (s.endTime <= now) return false;
        const cap = s.requiredEmployees;
        if (cap === null || cap === undefined) return false;
        return (fillBySlotKey.get(s.slotKey) ?? 0) < cap;
      });

      // Asignaciones de otros empleados (para swap con compañeros)
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

        // Intercept: If both types exist, ask the user what they prefer
        if (hasOpen && hasSwap) {
          let responseText = this.i18n.t('bot.swap.select_swap_type', { lang: locale }) + '\n\n';
          responseText += `1. ${this.i18n.t('bot.swap.swap_type_open', { lang: locale })}\n`;
          responseText += `2. ${this.i18n.t('bot.swap.swap_type_colleague', { lang: locale })}\n`;
          
          session = session.withIntent('swap_shift', {
            pendingAction: 'swap_shift',
            swapStep: 'SELECT_SWAP_TYPE',
            selectedOwnShiftId: shiftId,
          });
          await this.sessionRepository.saveSession(session);
          this._reply(from, responseText.trim());
          return true;
        }

        // If only one exists, bypass intercept
        targetTypeFilter = hasOpen ? 'OPEN' : 'SWAP';
      } else {
        // step === 'SELECT_SWAP_TYPE'
        if (!['1', '2', 'uno', 'dos', 'libre', 'compañero', 'open', 'colleague'].includes(selection)) {
          this._reply(from, this.i18n.t('bot.swap.invalid_choice', { lang: locale }));
          return true;
        }
        targetTypeFilter = (selection === '1' || selection === 'uno' || selection === 'libre' || selection === 'open') ? 'OPEN' : 'SWAP';
      }

      // Load employee names
      const employees = await this.employeeRepo.findAllByCompany(companyId);
      const empMap = new Map(employees.map((e) => [e.id, e.name]));

      // Build options list (cap at 5)
      // `shiftId` en este flujo transporta el UUID de la assignment propia.
      const ownAssignment = allAssignments.find((a) => a.id === shiftId);
      const ownSlot = ownAssignment
        ? allSlots.find((s) => s.slotKey === ownAssignment.slotKey)
        : undefined;
      const ownShiftDate = ownSlot
        ? ownSlot.startTime.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES', { weekday: 'short', month: 'short', day: 'numeric' })
        : '';
        
      let responseText = this.i18n.t('bot.swap.select_target_shift', { lang: locale, args: { date: ownShiftDate } }) + '\n\n';
      const optionsEntities: Record<string, string> = {
        pendingAction: 'swap_shift',
        swapStep: 'SELECT_TARGET',
        selectedOwnShiftId: shiftId,
      };

      let count = 0;

      // 1. Add Open Slots — el target se guarda como slotKey (templateId|YYYY-MM-DD)
      if (targetTypeFilter === 'OPEN') {
        for (const slot of openSlots) {
          if (count >= 5) break;
          count++;
          const desc = this._formatShiftLine({
            shiftId: slot.slotKey,
            startTime: slot.startTime,
            endTime: slot.endTime,
          }, locale);
          const openLabel = this.i18n.t('bot.swap.open_shift_label', { lang: locale, defaultValue: 'Turno Libre' });
          responseText += `${count}. *[${openLabel}]* — ${desc}\n`;
          optionsEntities[`option${count}_shiftId`] = slot.slotKey;
          optionsEntities[`option${count}_type`] = 'OPEN';
        }
      }

      // 2. Add Colleague Assignments — agrupamos por slot (templateId|fecha)
      if (targetTypeFilter === 'SWAP') {
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

        for (const group of groupedBySlot.values()) {
          if (count >= 5) break;

          const timeDesc = this._formatShiftLine({
            shiftId: group.slot.slotKey,
            startTime: group.slot.startTime,
            endTime: group.slot.endTime,
          }, locale);

          responseText += `\n*${timeDesc}*\n`;

          for (const assignment of group.assignments) {
            if (count >= 5) break;
            count++;
            const empName = empMap.get(assignment.employeeId) || 'Compañero';
            responseText += `${count}. ${empName}\n`;

            // Para swap con compañero guardamos el UUID de SU assignment.
            optionsEntities[`option${count}_shiftId`] = assignment.id;
            optionsEntities[`option${count}_employeeId`] = assignment.employeeId;
            optionsEntities[`option${count}_type`] = 'SWAP';
          }
        }
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

      const employees = await this.employeeRepo.findAllByCompany(companyId);

      const ownDesc = ownSlot
        ? this._formatShiftLine({ shiftId: ownSlot.slotKey, startTime: ownSlot.startTime, endTime: ownSlot.endTime }, locale)
        : ownShiftId;
      const targetDesc = targetSlot
        ? this._formatShiftLine({ shiftId: targetSlot.slotKey, startTime: targetSlot.startTime, endTime: targetSlot.endTime }, locale)
        : targetShiftId;

      let confirmMsg = '';
      if (targetType === 'OPEN') {
        confirmMsg = this.i18n.t('bot.swap.confirm_open_prompt', {
          lang: locale,
          args: { myShift: ownDesc, targetShift: targetDesc }
        });
      } else {
        const targetName = employees.find((e) => e.id === targetEmployeeId)?.name || 'Compañero';
        confirmMsg = this.i18n.t('bot.swap.confirm_prompt', {
          lang: locale,
          args: { myShift: ownDesc, targetShift: targetDesc, targetName }
        });
      }

      session = session.withIntent('swap_shift', {
        pendingAction: 'swap_shift',
        swapStep: 'CONFIRM',
        selectedOwnShiftId: ownShiftId,
        selectedTargetShiftId: targetShiftId,
        selectedTargetEmployeeId: targetEmployeeId,
        selectedTargetType: targetType,
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
        const targetType = sessionEntities.selectedTargetType;

        if (targetType === 'OPEN') {
          const command = new TakeOpenShiftCommand(
            employeeId,
            ownShiftId,
            targetShiftId,
            companyId,
          );
          await this.commandBus.execute(command);
          await this.sessionRepository.clearSession(from);
          this._reply(from, this.i18n.t('bot.swap.open_shift_success', { lang: locale }));
          return true;
        } else {
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

    const { result, usage } = await this.llmUsageTracker.run(async () => {
      if (isText) return this.conversationalService.processText(msg.body!);
      return this.conversationalService.processAudio(
        msg.mediaUrl!,
        msg.mimeType!,
        msg.twilioSid,
        msg.twilioToken,
      );
    });
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
    const monday = this._getMonday(reference);
    const nextMonday = new Date(monday);
    nextMonday.setDate(nextMonday.getDate() + 7);

    const templates = await this.shiftTemplateRepo.findAllByCompany(companyId);
    const activeTemplates = templates.filter((t) => t.isActive);
    const slotsW1 = this.slotGenerator.generateSlotsForWeek(activeTemplates, monday);
    const slotsW2 = this.slotGenerator.generateSlotsForWeek(activeTemplates, nextMonday);

    const fromISO = monday.toISOString().split('T')[0];
    const endSunday = new Date(nextMonday);
    endSunday.setDate(endSunday.getDate() + 6);
    const toISO = endSunday.toISOString().split('T')[0];
    const assignments = await this.assignmentRepo.findByCompanyAndDateRange(
      companyId,
      fromISO,
      toISO,
    );

    return { slots: [...slotsW1, ...slotsW2], assignments };
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
}
