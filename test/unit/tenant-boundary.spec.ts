import { ForbiddenException, Logger } from '@nestjs/common';
import { TenantBoundaryGuard } from '../../src/auth/tenant-boundary.guard';

describe('tenant boundary guard', () => {
  const identity = {
    sub: 'operator-1',
    tenant_id: 'tenant-1',
    institution_id: 'institution-1',
    roles: ['auditor'],
    permissions: ['finance.read'],
  };

  it('binds the signed tenant-institution pair before service execution', async () => {
    const prisma = { bindTenantReference: jest.fn().mockResolvedValue(undefined) };
    const guard = new TenantBoundaryGuard(reflector(false) as any, prisma as any, { recordSecurityFailure: jest.fn() } as any);

    await expect(guard.canActivate(context({ identity, headers: {} }) as any)).resolves.toBe(true);
    expect(prisma.bindTenantReference).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      institutionId: 'institution-1',
    });
  });

  it('returns a generic denial when the local financial reference differs', async () => {
    const prisma = { bindTenantReference: jest.fn().mockRejectedValue(new Error('database detail')) };
    const guard = new TenantBoundaryGuard(reflector(false) as any, prisma as any, { recordSecurityFailure: jest.fn() } as any);
    const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(guard.canActivate(context({ identity, headers: {} }) as any)).rejects.toEqual(
      new ForbiddenException('Authenticated tenant context is not valid'),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('tenant_boundary_denied'));
    expect(log.mock.calls.flat().join(' ')).not.toContain('database detail');
    log.mockRestore();
  });

  it('does not create a tenant reference for public routes', async () => {
    const prisma = { bindTenantReference: jest.fn() };
    const guard = new TenantBoundaryGuard(reflector(true) as any, prisma as any, { recordSecurityFailure: jest.fn() } as any);

    await expect(guard.canActivate(context({ headers: {} }) as any)).resolves.toBe(true);
    expect(prisma.bindTenantReference).not.toHaveBeenCalled();
  });
});

function reflector(isPublic: boolean) {
  return { getAllAndOverride: jest.fn().mockReturnValue(isPublic) };
}

function context(request: Record<string, unknown>) {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  };
}
