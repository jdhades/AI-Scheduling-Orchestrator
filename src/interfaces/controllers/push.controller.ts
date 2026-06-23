import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import type { SupabaseClient } from '@supabase/supabase-js';

import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';

export class RegisterDeviceDto {
  @IsString()
  token!: string;

  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';
}

export class UnregisterDeviceDto {
  @IsString()
  token!: string;
}

/**
 * PushController — device token registration for push notifications.
 *   POST /push/register   → upsert the current employee's device token
 *   POST /push/unregister → remove a token (on logout / token rotation)
 * Tenant + employee come from the JWT.
 */
@Controller('push')
export class PushController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.NO_CONTENT)
  async register(
    @Body() dto: RegisterDeviceDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    if (!user?.employeeId) {
      throw new NotFoundException('No employee is linked to this account');
    }
    const now = new Date().toISOString();
    const { error } = await this.supabase.from('device_tokens').upsert(
      {
        company_id: companyId,
        employee_id: user.employeeId,
        token: dto.token,
        platform: dto.platform,
        updated_at: now,
        last_seen_at: now,
      },
      { onConflict: 'token' },
    );
    if (error) throw new Error(error.message);
  }

  @Post('unregister')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregister(
    @Body() dto: UnregisterDeviceDto,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    await this.supabase
      .from('device_tokens')
      .delete()
      .eq('token', dto.token)
      .eq('company_id', companyId);
  }
}
