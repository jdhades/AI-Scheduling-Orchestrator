import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Query,
  BadRequestException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';

/**
 * DepartmentsController — write operations sobre departments.
 *
 * Phase 15.1 — el primer caso de uso es asignar el `managerEmployeeId`
 * (employee designado como manager del depto). Sin este campo, todos los
 * managers del tenant ven todas las approvals; con él, el routing puede
 * filtrar por depto.
 *
 * El listado read-only sigue en `ScopeTargetsController` (GET /departments)
 * porque ya devolvemos el shape extendido que el frontend usa.
 */
export class UpdateDepartmentDto {
  /**
   * UUID del employee a designar como manager del depto. Mandar `null`
   * para limpiar la asignación (vuelve al fallback "cualquier manager
   * del tenant"). Mandar undefined para no tocarlo.
   */
  // Nota: NO usamos @IsUUID() porque los UUIDs del seed legacy no son
  // v4 estrictos (vienen con `aaaa-bbbb-cccc` por legibilidad). La FK
  // de la BD + el cross-tenant lookup hacen la validación real.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @IsNotEmpty()
  managerEmployeeId?: string | null;

  /** Reservado para futuras ediciones (rename del depto). */
  @IsOptional()
  @IsString()
  name?: string;

  /**
   * Phase 15.3 — si true, los swap requests originados por empleados
   * del depto se aprueban automáticamente sin esperar al manager. El
   * flag vive a nivel depto: cada manager controla la política de su
   * equipo (Retail puede confiar, Seguridad puede exigir aprobación).
   */
  @IsOptional()
  @IsBoolean()
  swapAutoApprove?: boolean;
}

@Controller('departments')
export class DepartmentsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  /**
   * PATCH /departments/:id?companyId=...
   *
   * Asigna o limpia el manager del depto. Valida que el employee
   * pertenezca al mismo tenant para evitar cross-tenant assignment.
   * NO valida `role='manager'`: dejamos al frontend marcar la
   * advertencia, pero el backend permite asignar cualquier employee
   * del tenant (un superuser podría querer hacerlo y class-validator
   * no es el lugar para reglas de negocio).
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @CurrentCompany() companyId: string,
    @Body() dto: UpdateDepartmentDto,
  ): Promise<DepartmentMutateResponse> {
    const existing = await this.supabase
      .from('departments')
      .select('id, name, manager_employee_id, swap_auto_approve')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) {
      throw new NotFoundException(`Department ${id} not found`);
    }

    if (dto.managerEmployeeId) {
      // Cross-tenant guard: el employee debe pertenecer al mismo company.
      const emp = await this.supabase
        .from('employees')
        .select('id, company_id')
        .eq('id', dto.managerEmployeeId)
        .maybeSingle();
      if (emp.error) throw new Error(emp.error.message);
      if (!emp.data || emp.data.company_id !== companyId) {
        throw new BadRequestException(
          `Employee ${dto.managerEmployeeId} does not belong to this tenant`,
        );
      }
    }

    const patch: Record<string, unknown> = {};
    if (dto.managerEmployeeId !== undefined) {
      patch.manager_employee_id = dto.managerEmployeeId;
    }
    if (dto.name !== undefined) {
      patch.name = dto.name.trim();
    }
    if (dto.swapAutoApprove !== undefined) {
      patch.swap_auto_approve = dto.swapAutoApprove;
    }

    if (Object.keys(patch).length === 0) {
      // Nada que actualizar — devolvemos el estado actual.
      return {
        id: existing.data.id,
        name: existing.data.name,
        managerEmployeeId:
          (existing.data.manager_employee_id as string | null) ?? null,
        swapAutoApprove:
          (existing.data.swap_auto_approve as boolean | null) ?? false,
      };
    }

    const updated = await this.supabase
      .from('departments')
      .update(patch)
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id, name, manager_employee_id, swap_auto_approve')
      .single();
    if (updated.error) throw new Error(updated.error.message);

    return {
      id: updated.data.id,
      name: updated.data.name,
      managerEmployeeId:
        (updated.data.manager_employee_id as string | null) ?? null,
      swapAutoApprove:
        (updated.data.swap_auto_approve as boolean | null) ?? false,
    };
  }
}

interface DepartmentMutateResponse {
  id: string;
  name: string;
  managerEmployeeId: string | null;
  swapAutoApprove: boolean;
}
