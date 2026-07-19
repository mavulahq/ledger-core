import { ForbiddenException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { InternalWorkerController } from '../../src/controllers/internal-worker.controller';
import { PERMISSIONS_KEY } from '../../src/auth/permissions.decorator';

describe('InternalWorkerController', () => {
  const requestBody = {
    tenant_id: 'tenant_1',
    institution_id: 'institution_1',
    period_from: '2026-07-01',
    period_to: '2026-07-31',
    legal_basis_code: 'MZ-AML-14-2023-ART-43',
    retention_until: '2036-07-15',
  };

  it('requires internal.worker and regulatory.export for regulatory source pages', () => {
    expect(Reflect.getMetadata(PATH_METADATA, InternalWorkerController)).toBe('internal/worker');
    expect(Reflect.getMetadata(PERMISSIONS_KEY, InternalWorkerController)).toEqual(['internal.worker']);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, InternalWorkerController.prototype.regulatoryTransactionRecords))
      .toEqual(['internal.worker', 'regulatory.export']);
  });

  it('audits successful regulatory export source pages', async () => {
    const page = { records: [{ transaction_id: 'txn_1' }], rejections: [] };
    const regulatoryExports = { page: jest.fn().mockResolvedValue(page) };
    const audit = { record: jest.fn() };
    const controller = new InternalWorkerController(
      {} as any, {} as any, {} as any, {} as any, regulatoryExports as any, audit as any,
    );
    const req = {
      tenantId: 'tenant_1',
      institutionId: 'institution_1',
      identity: {
        sub: 'worker-1',
        institution_id: 'institution_1',
        roles: ['worker'],
        permissions: ['internal.worker', 'regulatory.export'],
      },
    };

    await expect(controller.regulatoryTransactionRecords(req, requestBody)).resolves.toBe(page);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: 'tenant_1',
      action: 'regulatory.export.source',
      stage: 'DISPATCHED',
      result: 'SUCCEEDED',
      source: 'WORKER',
      metadata: expect.objectContaining({
        period_from: '2026-07-01',
        period_to: '2026-07-31',
        record_count: 1,
        rejection_count: 0,
        legal_basis_code: 'MZ-AML-14-2023-ART-43',
      }),
    }));
  });

  it('audits rejected regulatory export authz mismatches', async () => {
    const regulatoryExports = { page: jest.fn() };
    const audit = { record: jest.fn() };
    const controller = new InternalWorkerController(
      {} as any, {} as any, {} as any, {} as any, regulatoryExports as any, audit as any,
    );
    const req = {
      tenantId: 'tenant_1',
      institutionId: 'institution_1',
      identity: {
        sub: 'worker-1',
        institution_id: 'institution_other',
        roles: ['worker'],
        permissions: ['internal.worker', 'regulatory.export'],
      },
    };

    await expect(controller.regulatoryTransactionRecords(req, requestBody))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(regulatoryExports.page).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: 'tenant_1',
      action: 'regulatory.export.source',
      result: 'REJECTED',
      source: 'WORKER',
    }));
  });
});
