import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import { ScopeService } from '../../infrastructure/auth/services/scope.service';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  BadRequestException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
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
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID('loose')
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

export class CreateDepartmentDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  name!: string;

  @IsUUID('loose')
  branchId!: string;
}

@Controller('departments')
export class DepartmentsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly scope: ScopeService,
  ) {}

  @Post()
  @Requires('departments:write')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthContext,
    @CurrentCompany() companyId: string,
    @Body() dto: CreateDepartmentDto,
  ): Promise<DepartmentMutateResponse> {
    // Validar que la branch pertenece al tenant + scope check.
    const { data: branch, error: bErr } = await this.supabase
      .from('branches')
      .select('id')
      .eq('id', dto.branchId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (bErr) throw new BadRequestException(bErr.message);
    if (!branch) throw new NotFoundException('Branch not found in this tenant');

    // Manager scope: si la branch no está en su scope, 403
    if (user.role !== 'owner') {
      const visibleBranches = await this.scope.visibleBranchIds(user);
      if (visibleBranches !== null && !visibleBranches.includes(dto.branchId)) {
        throw new BadRequestException(
          'Branch is not in your scope — cannot create department here',
        );
      }
    }

    const { data, error } = await this.supabase
      .from('departments')
      .insert({
        company_id: companyId,
        branch_id: dto.branchId,
        name: dto.name.trim(),
      })
      .select('id, name, manager_employee_id, swap_auto_approve')
      .single();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException(
          'Department name already exists in this branch',
        );
      }
      throw new BadRequestException(error.message);
    }
    return {
      id: data.id as string,
      name: data.name as string,
      managerEmployeeId: (data.manager_employee_id as string | null) ?? null,
      swapAutoApprove: (data.swap_auto_approve as boolean | null) ?? false,
    };
  }

  @Delete(':id')
  @Requires('departments:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthContext,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    // Pre-check: dept existe en este tenant + en scope del user
    const { data: dept, error: dErr } = await this.supabase
      .from('departments')
      .select('id, branch_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (dErr) throw new BadRequestException(dErr.message);
    if (!dept) throw new NotFoundException('Department not found');

    if (user.role !== 'owner') {
      await this.scope.assertDeptInScope(user, id);
    }

    // Check: tiene empleados? Bloquear con error claro.
    const { count } = await this.supabase
      .from('employees')
      .select('id', { count: 'exact', head: true })
      .eq('department_id', id);
    if ((count ?? 0) > 0) {
      throw new BadRequestException(
        `Cannot delete department with ${count} employee(s) — reassign them first`,
      );
    }

    const { error } = await this.supabase
      .from('departments')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) throw new BadRequestException(error.message);
  }

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
  @Requires('departments:write')
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
