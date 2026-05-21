import { Controller, Get } from '@nestjs/common';
import { PolicyInterpreterRegistry } from '../../domain/services/policy-interpreter-registry';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';

export interface PolicyInterpreterRow {
  id: string;
  description: string;
  catchAll: boolean;
}

/**
 * AdminPolicyInterpretersController — vista read-only del registry de
 * interpreters de policies. Los interpreters viven en código (no en BD),
 * así que esto es solo introspección.
 *
 *   GET /admin/policy-interpreters → lista
 */
@Controller('admin/policy-interpreters')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminPolicyInterpretersController {
  constructor(private readonly registry: PolicyInterpreterRegistry) {}

  @Get()
  list(): PolicyInterpreterRow[] {
    return this.registry
      .getAll()
      .map((itp) => ({
        id: itp.id,
        description: itp.description,
        catchAll: !!itp.catchAll,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
