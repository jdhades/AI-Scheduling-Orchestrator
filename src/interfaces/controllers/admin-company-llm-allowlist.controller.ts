import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { PlatformAdmin } from '../../infrastructure/auth/decorators/platform-admin.decorator';
import { AllowExpiredTrial } from '../../infrastructure/auth/decorators/allow-expired-trial.decorator';
import {
  CompanyLlmAllowlistService,
  type AllowlistEntry,
} from '../../domain/services/company-llm-allowlist.service';

class AddAllowlistEntryDto {
  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsString()
  @IsNotEmpty()
  model!: string;
}

/**
 * AdminCompanyLlmAllowlistController — administra la whitelist de
 * (provider, model) que un tenant puede usar para LLM calls. El check
 * en runtime lo hace LlmResolverService antes de devolver el cliente.
 *
 *   GET    /admin/companies/:id/llm-allowlist     → lista
 *   POST   /admin/companies/:id/llm-allowlist     → agregar (provider+model)
 *   DELETE /admin/companies/:id/llm-allowlist/:entryId
 *
 * Convención: sin filas = todos los modelos permitidos. Con N filas =
 * solo esos. Soporte la usa para forzar a un tenant a Local LLM (cost
 * control) o bloquear modelos en prueba.
 */
@Controller('admin/companies/:id/llm-allowlist')
@PlatformAdmin()
@AllowExpiredTrial()
export class AdminCompanyLlmAllowlistController {
  constructor(private readonly service: CompanyLlmAllowlistService) {}

  @Get()
  async list(@Param('id') companyId: string): Promise<AllowlistEntry[]> {
    return this.service.listForCompany(companyId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async add(
    @Param('id') companyId: string,
    @Body() body: AddAllowlistEntryDto,
  ): Promise<AllowlistEntry> {
    const entry = await this.service.add(companyId, body.provider, body.model);
    if (!entry) {
      throw new BadRequestException(
        'Failed to add allowlist entry (probably a duplicate (provider, model) for this tenant)',
      );
    }
    return entry;
  }

  @Delete(':entryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') companyId: string,
    @Param('entryId') entryId: string,
  ): Promise<void> {
    const ok = await this.service.remove(companyId, entryId);
    if (!ok) {
      throw new NotFoundException(
        `Allowlist entry ${entryId} not found for company ${companyId}`,
      );
    }
  }
}
