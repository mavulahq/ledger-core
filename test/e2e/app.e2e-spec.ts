import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { AppController } from '../../src/app.controller';
import { AuthController } from '../../src/auth/auth.controller';
import { InternalWorkerController } from '../../src/controllers/internal-worker.controller';
import { InternalApiKeyGuard } from '../../src/worker/internal-api-key.guard';

describe('Fengine (e2e)', () => {
  let app: INestApplication;
  let appController: AppController;
  let authController: AuthController;
  let internalWorkerController: InternalWorkerController;
  let internalApiKeyGuard: InternalApiKeyGuard;

  beforeAll(async () => {
    process.env.FENGINE_QUEUE_BACKEND = 'memory';
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    appController = app.get(AppController);
    authController = app.get(AuthController);
    internalWorkerController = app.get(InternalWorkerController);
    internalApiKeyGuard = app.get(InternalApiKeyGuard);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.FENGINE_QUEUE_BACKEND;
    delete process.env.INTERNAL_API_KEY;
  });

  it('protects and publishes internal worker jobs', async () => {
    const payload = {
      tenant_id: 'tenant_e2e',
      event_type: 'LOAN_APPROVED',
      idempotency_key: 'e2e-loan-approved',
      payload: { loan_id: 'loan_e2e' },
    };
    expect(() => internalApiKeyGuard.canActivate(context())).toThrow('Internal API key is required');
    expect(internalApiKeyGuard.canActivate(context('test-internal-key'))).toBe(true);

    const created = await internalWorkerController.enqueue(payload);
    expect(created).toMatchObject({
      id: 'fengine-e2e-loan-approved',
      status: 'QUEUED',
    });

    await expect(internalWorkerController.get(created.id)).resolves.toMatchObject({ id: created.id });
  });

  it('/api/health (GET)', async () => {
    expect(appController.health({ tenantId: undefined })).toMatchObject({
      status: 'ok',
      tenant: null,
    });
  });

  it('login sets cookie when USE_HTTP_ONLY_COOKIE=true', async () => {
    process.env.USE_HTTP_ONLY_COOKIE = 'true';
    const res = { cookie: jest.fn() };
    await expect(authController.login({ username: 'u', roles: ['ADMIN'] }, res)).resolves.toEqual({ status: 'ok' });
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      expect.any(String),
      expect.objectContaining({ httpOnly: true }),
    );
  });
});

function context(key?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: key ? { 'x-internal-api-key': key } : {} }),
    }),
  } as any;
}
