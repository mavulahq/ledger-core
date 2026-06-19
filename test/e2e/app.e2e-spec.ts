import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

describe('Fengine (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.FENGINE_QUEUE_BACKEND = 'memory';
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
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
    await request((app as any).getHttpServer()).post('/api/internal/worker/jobs').send(payload).expect(401);
    const created = await request((app as any).getHttpServer())
      .post('/api/internal/worker/jobs')
      .set('x-internal-api-key', 'test-internal-key')
      .send(payload)
      .expect(201);
    expect(created.body).toMatchObject({ id: 'fengine-e2e-loan-approved', status: 'QUEUED' });

    await request((app as any).getHttpServer())
      .get(`/api/internal/worker/jobs/${created.body.id}`)
      .set('x-internal-api-key', 'test-internal-key')
      .expect(200);
  });

  it('/api/health (GET)', async () => {
    await request((app as any).getHttpServer()).get('/api/health').expect(200).then(res => {
      expect(res.body.status).toBe('ok');
    });
  });

  it('login sets cookie when USE_HTTP_ONLY_COOKIE=true', async () => {
    process.env.USE_HTTP_ONLY_COOKIE = 'true';
    const res = await request((app as any).getHttpServer()).post('/api/auth/login').send({ username: 'u', roles: ['ADMIN'] }).expect(200);
    expect(res.headers['set-cookie']).toBeDefined();
  });

});
