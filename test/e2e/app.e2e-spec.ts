import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { AppController } from '../../src/app.controller';
import { AuthController } from '../../src/auth/auth.controller';
import { InternalWorkerController } from '../../src/controllers/internal-worker.controller';

describe('ledger-core (e2e)', () => {
  let app: INestApplication;
  let appController: AppController;
  let authController: AuthController;
  let internalWorkerController: InternalWorkerController;

  beforeAll(async () => {
    process.env.FENGINE_QUEUE_BACKEND = 'memory';
    process.env.OIDC_ISSUER = 'https://identity.mavula.io';
    process.env.OIDC_AUDIENCE = 'urn:mavula:ledger-core';
    process.env.OIDC_JWKS_URI = 'https://identity.mavula.io/jwks';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    appController = app.get(AppController);
    authController = app.get(AuthController);
    internalWorkerController = app.get(InternalWorkerController);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.FENGINE_QUEUE_BACKEND;
  });

  it('protects and publishes internal worker jobs', async () => {
    const payload = {
      tenant_id: 'tenant_e2e',
      event_type: 'LOAN_APPROVED',
      idempotency_key: 'e2e-loan-approved',
      payload: { loan_id: 'loan_e2e' },
    };
    const created = await internalWorkerController.enqueue(payload);
    expect(created).toMatchObject({
      id: 'ledger-core-e2e-loan-approved',
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

  it('legacy login is retired', () => {
    expect(() => authController.login()).toThrow('Local login has been retired');
  });
});
