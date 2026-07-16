import { PrismaService } from '../../src/services/prisma.service';

describe('PrismaService', () => {
  it('drains tenant transactions before disconnecting', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const service = new PrismaService();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    let releaseOperation: () => void = () => undefined;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const client = {
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) =>
        callback({ $executeRaw: jest.fn().mockResolvedValue(1) }),
      ),
      $disconnect: disconnect,
    };
    Object.defineProperty(service, 'client', { value: client });

    const operation = service.withTenant('tenant-a', async () => {
      await operationGate;
      return 'completed';
    });
    await Promise.resolve();

    const shutdown = service.onModuleDestroy();
    await Promise.resolve();
    expect(disconnect).not.toHaveBeenCalled();

    releaseOperation();
    await expect(operation).resolves.toBe('completed');
    await shutdown;
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
