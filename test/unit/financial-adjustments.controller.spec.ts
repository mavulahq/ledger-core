import { PATH_METADATA } from '@nestjs/common/constants';
import { FinancialAdjustmentsController } from '../../src/controllers/financial-adjustments.controller';
import { PERMISSIONS_KEY } from '../../src/auth/permissions.decorator';

describe('FinancialAdjustmentsController', () => {
  const createdAt = new Date('2026-07-15T12:00:00.000Z');
  const requestRecord = {
    id: 'far_http_001',
    tenantId: 'tenant_http_001',
    targetType: 'JOURNAL_ENTRY' as const,
    targetId: 'je_http_001',
    adjustmentType: 'CORRECTION' as const,
    status: 'PENDING_APPROVAL' as const,
    reason: 'Correct the journal amount',
    targetJournalEntryId: 'je_http_001',
    requestedBy: 'operator_maker',
    requestedRoles: ['operations_maker'],
    institutionId: 'institution_001',
    correlationId: 'corr_http_001',
    createdAt,
    updatedAt: createdAt,
  };

  it('maps the versioned HTTP payload and authenticated operator context', async () => {
    const service = {
      submit: jest.fn().mockResolvedValue(requestRecord),
    } as any;
    const controller = new FinancialAdjustmentsController(service);

    const result = await controller.submit({
      tenantId: 'tenant_http_001',
      identity: {
        sub: 'operator_maker',
        roles: ['operations_maker'],
        permissions: ['finance.write'],
        institution_id: 'institution_001',
        branch_id: 'branch_001',
      },
      headers: { 'x-correlation-id': 'corr_http_001' },
    }, {
      target_type: 'JOURNAL_ENTRY',
      target_id: 'je_http_001',
      adjustment_type: 'CORRECTION',
      reason: 'Correct the journal amount',
      correction: {
        journal: {
          ledger_lines: [
            { account_code: '10010', debit_amount: '75.00' },
            { account_code: '20010', credit_amount: '75.00' },
          ],
          account_postings: [{
            account_id: 'account_http_001',
            direction: 'CREDIT',
            amount: '75.00',
            currency: 'MZN',
          }],
        },
      },
    });

    expect(service.submit).toHaveBeenCalledWith(
      'tenant_http_001',
      expect.objectContaining({
        targetType: 'JOURNAL_ENTRY',
        targetId: 'je_http_001',
        adjustmentType: 'CORRECTION',
        correction: {
          lending: undefined,
          journal: {
            ledgerLines: [
              { account_code: '10010', debit_amount: 75, credit_amount: undefined },
              { account_code: '20010', debit_amount: undefined, credit_amount: 75 },
            ],
            accountPostings: [{
              accountId: 'account_http_001',
              direction: 'CREDIT',
              amount: '75.00',
              currency: 'MZN',
              reference: undefined,
            }],
          },
        },
      }),
      expect.objectContaining({
        subject: 'operator_maker',
        permissions: ['finance.write'],
        correlationId: 'corr_http_001',
      }),
    );
    expect(result).toMatchObject({
      id: 'far_http_001',
      target_type: 'JOURNAL_ENTRY',
      created_at: '2026-07-15T12:00:00.000Z',
    });
  });

  it('declares separate write, read, and approval permissions', () => {
    expect(Reflect.getMetadata(PATH_METADATA, FinancialAdjustmentsController)).toBe('financial-adjustment-requests');
    expect(Reflect.getMetadata(PERMISSIONS_KEY, FinancialAdjustmentsController.prototype.submit)).toEqual(['finance.write']);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, FinancialAdjustmentsController.prototype.list)).toEqual(['finance.read']);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, FinancialAdjustmentsController.prototype.approve)).toEqual(['finance.approve']);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, FinancialAdjustmentsController.prototype.reject)).toEqual(['finance.approve']);
  });
});
