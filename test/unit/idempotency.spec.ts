import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { IdempotencyService } from '../../src/idempotency/idempotency.service';

describe('durable idempotency boundary', () => {
  const metrics = {
    recordIdempotency: jest.fn(),
    recordIdempotencyCleanup: jest.fn(),
    setIdempotencyReceiptStatus: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('rejects an invalid key before invoking a write', async () => {
    const service = new IdempotencyService({ isConfigured: false } as any, metrics as any);
    const write = jest.fn();
    await expect(service.execute({
      tenantId: 'tenant_001', operation: 'accounts.create', key: 'short', actorId: 'operator_001',
      method: 'POST', params: {}, query: {}, body: {},
    }, () => 201, write)).rejects.toBeInstanceOf(BadRequestException);
    expect(write).not.toHaveBeenCalled();
  });

  it('fails closed when durable storage is unavailable', async () => {
    const service = new IdempotencyService({ isConfigured: false } as any, metrics as any);
    const write = jest.fn();
    await expect(service.execute({
      tenantId: 'tenant_001', operation: 'accounts.create', key: 'idem_account_0001', actorId: 'operator_001',
      method: 'POST', params: {}, query: {}, body: {},
    }, () => 201, write)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(metrics.recordIdempotency).toHaveBeenCalledWith('accounts.create', 'unavailable');
    expect(write).not.toHaveBeenCalled();
  });
});
