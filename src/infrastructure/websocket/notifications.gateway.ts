import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtValidatorService } from '../auth/services/jwt-validator.service';

/**
 * NotificationsGateway — eventos en tiempo real al frontend.
 *
 * PR 10 — auth + scoping por tenant:
 *   1. handleConnection valida JWT del handshake.auth.token. Si falla
 *      → disconnect. DEV_AUTH_BYPASS=true + companyId en handshake
 *      permite conexiones sin JWT (compat con dev path).
 *   2. Cada socket entra a la room `company:${companyId}`. Los emits
 *      pasan de `server.emit()` (broadcast global) a
 *      `server.to(room).emit()` — isolation por tenant garantizada.
 *
 * CORS: el origin viene de `FRONTEND_URL` env. Sin variable → wildcard
 * (dev only). En prod nunca debería quedar sin setear.
 */
@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL ?? '*',
    credentials: true,
  },
})
export class NotificationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(private readonly jwtValidator: JwtValidatorService) {}

  afterInit(_server: Server) {
    this.logger.log('WebSocket Gateway Initialized');
  }

  async handleConnection(client: Socket): Promise<void> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
    const devCompanyId =
      (client.handshake.auth?.companyId as string | undefined) ??
      (client.handshake.headers['x-company-id'] as string | undefined);

    // ─── DEV bypass ────────────────────────────────────────────────────
    if (process.env.DEV_AUTH_BYPASS === 'true' && devCompanyId && !token) {
      void client.join(`company:${devCompanyId}`);
      client.data.companyId = devCompanyId;
      this.logger.log(
        `Client ${client.id} connected via DEV bypass (company=${devCompanyId})`,
      );
      return;
    }

    if (!token) {
      this.logger.warn(`Client ${client.id} rejected — no auth token`);
      client.disconnect(true);
      return;
    }

    try {
      const claims = await this.jwtValidator.verify(token);
      const companyId = claims.company_id;
      if (!companyId) {
        this.logger.warn(
          `Client ${client.id} rejected — JWT without company_id claim`,
        );
        client.disconnect(true);
        return;
      }
      void client.join(`company:${companyId}`);
      client.data.companyId = companyId;
      client.data.userId = claims.sub;
      this.logger.log(
        `Client ${client.id} connected (company=${companyId} user=${claims.sub})`,
      );
    } catch (err) {
      this.logger.warn(
        `Client ${client.id} rejected — invalid JWT: ${(err as Error).message}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Emite a la room del tenant — todos los sockets autenticados con
   * ese companyId reciben. Reemplaza al `server.emit()` global de
   * pre-PR 10 que llegaba a sockets de TODOS los tenants.
   */
  private emitToCompany(
    companyId: string,
    event: string,
    payload: object,
  ): void {
    if (!this.server) return;
    this.server.to(`company:${companyId}`).emit(event, payload);
  }

  /**
   * Broadcasts a new chat message to the tenant. Clients filter by `roomId`
   * (only the ones with that room open / in their list react). Tenant
   * isolation is guaranteed by the `company:${id}` room.
   */
  notifyChatMessage(companyId: string, roomId: string, message: object) {
    this.emitToCompany(companyId, 'ChatMessageCreated', { roomId, message });
  }

  /** Broadcasts a typing indicator for a room. */
  notifyChatTyping(companyId: string, roomId: string, employeeId: string) {
    this.emitToCompany(companyId, 'ChatTyping', { roomId, employeeId });
  }

  /**
   * Broadcasts that a new schedule has been successfully generated.
   * Clients should listen to 'ScheduleGenerated' to invalidate their caches.
   */
  notifyScheduleGenerated(companyId: string, weekStart: string) {
    this.emitToCompany(companyId, 'ScheduleGenerated', {
      companyId,
      weekStart,
    });
    this.logger.log(
      `Broadcasted ScheduleGenerated for company ${companyId}, week ${weekStart}`,
    );
  }

  /**
   * Broadcast cuando una assignment se mueve manualmente (drag & drop
   * desde el panel). El front invalida la query del horario para que
   * todos los managers viendo la grilla vean el cambio en vivo.
   */
  notifyAssignmentMoved(companyId: string, assignmentId: string) {
    this.emitToCompany(companyId, 'AssignmentMoved', {
      companyId,
      assignmentId,
    });
    this.logger.log(
      `Broadcasted AssignmentMoved company=${companyId} assignment=${assignmentId}`,
    );
  }

  /**
   * Broadcast genérico cuando se crea/borra una assignment manual.
   * El front se suscribe y refresca el horario sin distinguir el
   * tipo de cambio (granularidad fina podría diferenciarse en el
   * futuro si hace falta UI distinta — toast con detalle, etc).
   */
  notifyAssignmentChanged(companyId: string) {
    this.emitToCompany(companyId, 'AssignmentChanged', { companyId });
    this.logger.log(`Broadcasted AssignmentChanged company=${companyId}`);
  }

  /**
   * Broadcast del fallo terminal de un job `schedule.generate` (después
   * de exhaustar retries). El front muestra toast de error desde
   * cualquier página, sin que el manager tenga que estar en /generate.
   */
  notifyScheduleGenerationFailed(
    companyId: string,
    weekStart: string,
    reason?: string,
  ) {
    this.emitToCompany(companyId, 'ScheduleGenerationFailed', {
      companyId,
      weekStart,
      reason,
    });
    this.logger.log(
      `Broadcasted ScheduleGenerationFailed for company ${companyId}, week ${weekStart}`,
    );
  }

  /**
   * Phase 4 — broadcast cuando el worker pickea un job (transición
   * created/retry → active). El front lo usa para invalidar las
   * queries `['jobs', 'active']` y `['jobs', id]` y refrescar el
   * banner de "queued" → "active" sin esperar el polling de 2s.
   */
  notifyScheduleGenerationStarted(
    companyId: string,
    weekStart: string,
    jobId: string,
  ) {
    this.emitToCompany(companyId, 'ScheduleGenerationStarted', {
      companyId,
      weekStart,
      jobId,
    });
    this.logger.log(
      `Broadcasted ScheduleGenerationStarted job=${jobId} company=${companyId} week=${weekStart}`,
    );
  }

  /**
   * Phase 4 — broadcast cuando el manager cancela un job desde el
   * panel. Se emite después de `boss.cancel + registry.abort` en el
   * controller, sin esperar a que el worker confirme el abort. El
   * front cierra el banner inmediato.
   */
  notifyScheduleGenerationCancelled(
    companyId: string,
    weekStart: string,
    jobId: string,
  ) {
    this.emitToCompany(companyId, 'ScheduleGenerationCancelled', {
      companyId,
      weekStart,
      jobId,
    });
    this.logger.log(
      `Broadcasted ScheduleGenerationCancelled job=${jobId} company=${companyId} week=${weekStart}`,
    );
  }

  /**
   * Broadcasts that a new HR routing incident has occurred (e.g., employee absence).
   */
  notifyIncidentCreated(
    companyId: string,
    message: string,
    severity: 'warning' | 'critical',
  ) {
    this.emitToCompany(companyId, 'IncidentCreated', {
      companyId,
      message,
      severity,
      timestamp: new Date(),
    });
    this.logger.log(`Broadcasted IncidentCreated: [${severity}] ${message}`);
  }

  /**
   * Broadcast cuando una approval entity (swap, dayoff, absence, incident)
   * se crea/aprueba/rechaza. El frontend lo usa para invalidar las queries
   * del NotificationsBell sin polling.
   *
   * Payload mínimo: solo el companyId — el front re-fetchea las listas
   * pendientes y actualiza count + items.
   */
  notifyApprovalsChanged(companyId: string, type?: string) {
    this.emitToCompany(companyId, 'ApprovalsChanged', {
      companyId,
      type,
      timestamp: new Date().toISOString(),
    });
  }

  // ─── LLM jobs (sprint async LLM) ──────────────────────────────────
  // Shape estándar: { jobId, type, companyId } + result | error.
  // El frontend (LlmJobsStore) acumula los jobs en curso, los muestra
  // en un banner global y emite toast con el resultado.

  notifyLlmJobStarted(
    companyId: string,
    jobId: string,
    type: string,
    label?: string,
  ): void {
    this.emitToCompany(companyId, 'LlmJobStarted', {
      jobId,
      type,
      companyId,
      label: label ?? null,
    });
    this.logger.log(`Broadcasted LlmJobStarted job=${jobId} type=${type}`);
  }

  notifyLlmJobCompleted(
    companyId: string,
    jobId: string,
    type: string,
    result: unknown,
  ): void {
    this.emitToCompany(companyId, 'LlmJobCompleted', {
      jobId,
      type,
      companyId,
      result,
    });
    this.logger.log(`Broadcasted LlmJobCompleted job=${jobId} type=${type}`);
  }

  notifyLlmJobFailed(
    companyId: string,
    jobId: string,
    type: string,
    error: string,
  ): void {
    this.emitToCompany(companyId, 'LlmJobFailed', {
      jobId,
      type,
      companyId,
      error,
    });
    this.logger.log(
      `Broadcasted LlmJobFailed job=${jobId} type=${type}: ${error}`,
    );
  }
}
