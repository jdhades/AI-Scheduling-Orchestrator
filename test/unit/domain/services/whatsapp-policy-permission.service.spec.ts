import { WhatsappPolicyPermissionService } from '../../../../src/domain/services/whatsapp-policy-permission.service';

const makeSupabase = (rolesByCompany: Record<string, string[] | null | undefined> | null) => ({
  from: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        maybeSingle: jest.fn().mockImplementation(async function () {
          if (rolesByCompany === null) {
            return { data: null, error: { message: 'connection lost' } };
          }
          // Resolve via the eq() chain — companyId comes from outer mock.
          return { data: null, error: null };
        }),
      }),
    }),
  }),
});

/** Versión más realista que simula respuestas según companyId. */
const makeSupabaseFor = (
  companyId: string,
  payload: { whatsapp_policy_creator_roles?: string[] | null } | null,
) => ({
  from: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockImplementation((col: string, val: string) => ({
        maybeSingle: jest.fn().mockResolvedValue(
          col === 'id' && val === companyId
            ? { data: payload, error: null }
            : { data: null, error: null },
        ),
      })),
    }),
  }),
});

describe('WhatsappPolicyPermissionService', () => {
  it('canCreatePolicy=true cuando el role del empleado está en la lista', async () => {
    const supabase = makeSupabaseFor('c1', {
      whatsapp_policy_creator_roles: ['manager', 'shift-leader'],
    });
    const service = new WhatsappPolicyPermissionService(supabase as any);

    expect(
      await service.canCreatePolicy({ employeeRole: 'manager', companyId: 'c1' }),
    ).toBe(true);
    expect(
      await service.canCreatePolicy({ employeeRole: 'shift-leader', companyId: 'c1' }),
    ).toBe(true);
    expect(
      await service.canCreatePolicy({ employeeRole: 'employee', companyId: 'c1' }),
    ).toBe(false);
  });

  it('cuando la columna está vacía o NULL, cae al default ["manager"]', async () => {
    const supabase = makeSupabaseFor('c1', {
      whatsapp_policy_creator_roles: null,
    });
    const service = new WhatsappPolicyPermissionService(supabase as any);

    expect(
      await service.canCreatePolicy({ employeeRole: 'manager', companyId: 'c1' }),
    ).toBe(true);
    expect(
      await service.canCreatePolicy({ employeeRole: 'employee', companyId: 'c1' }),
    ).toBe(false);
  });

  it('cuando el tenant no existe (data=null), fail closed (false)', async () => {
    const supabase = makeSupabaseFor('c1', null);
    const service = new WhatsappPolicyPermissionService(supabase as any);

    expect(
      await service.canCreatePolicy({ employeeRole: 'manager', companyId: 'c1' }),
    ).toBe(false);
  });

  it('propaga error de DB como Error con prefijo del servicio', async () => {
    const supabase = makeSupabase(null);
    const service = new WhatsappPolicyPermissionService(supabase as any);

    await expect(
      service.canCreatePolicy({ employeeRole: 'manager', companyId: 'c1' }),
    ).rejects.toThrow(/getAllowedRoles/);
  });

  it('getAllowedRoles devuelve la lista cruda de la DB', async () => {
    const supabase = makeSupabaseFor('c1', {
      whatsapp_policy_creator_roles: ['owner', 'manager', 'lead'],
    });
    const service = new WhatsappPolicyPermissionService(supabase as any);
    expect(await service.getAllowedRoles('c1')).toEqual([
      'owner',
      'manager',
      'lead',
    ]);
  });
});
