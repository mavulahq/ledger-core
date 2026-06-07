import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

describe('Fengine (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
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
