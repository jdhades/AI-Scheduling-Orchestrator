import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { NotificationsGateway } from './notifications.gateway';

/**
 * ApprovalsBroadcastInterceptor — emite WS `ApprovalsChanged` después
 * de cualquier mutación exitosa (POST/PATCH/DELETE) sobre las 4 entities
 * de approvals: shift-swap-requests, day-off-requests, absence-reports,
 * incidents.
 *
 * Registrado como APP_INTERCEPTOR global — no requiere tocar los
 * controllers existentes. Detecta el tipo desde el path; si no matchea
 * approvals, deja pasar sin side effect.
 *
 * El frontend escucha el evento y invalida las queries del bell:
 *   `['shift-swap-requests', ...]`, `['day-off-requests', ...]`, etc.
 */
@Injectable()
export class ApprovalsBroadcastInterceptor implements NestInterceptor {
  constructor(private readonly gateway: NotificationsGateway) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method?: string;
      url?: string;
      path?: string;
      auth?: { companyId?: string };
    }>();
    const method = (req.method ?? '').toUpperCase();
    const mutating = method === 'POST' || method === 'PATCH' || method === 'DELETE';
    if (!mutating) return next.handle();

    const path = req.path ?? req.url ?? '';
    const type = this.detectApprovalType(path);
    if (!type) return next.handle();

    return next.handle().pipe(
      tap(() => {
        const companyId = req.auth?.companyId;
        if (!companyId) return;
        this.gateway.notifyApprovalsChanged(companyId, type);
      }),
    );
  }

  private detectApprovalType(path: string): string | null {
    if (path.includes('/shift-swap-requests')) return 'swap';
    if (path.includes('/day-off-requests')) return 'dayoff';
    if (path.includes('/absence-reports')) return 'absence';
    if (path.includes('/incidents')) return 'incident';
    return null;
  }
}
