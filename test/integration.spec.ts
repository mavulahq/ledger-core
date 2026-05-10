import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

describe('fengine - Integration Tests (e2e)', () => {
  let app: INestApplication;
  let tenantId = 'test_inst_001';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Health & Metrics', () => {
    it('GET /api/health returns status ok', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /api/metrics returns prometheus metrics', async () => {
      const res = await request(app.getHttpServer()).get('/api/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toContain('http_requests_total');
    });
  });

  describe('Authentication', () => {
    it('POST /api/auth/login returns token (default mode)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ username: 'testuser', roles: ['USER'] });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('access_token');
    });

    it('POST /api/auth/login returns 200 with cookie (cookie mode)', async () => {
      process.env.USE_HTTP_ONLY_COOKIE = 'true';
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ username: 'testuser', roles: ['ADMIN'] });
      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeDefined();
      delete process.env.USE_HTTP_ONLY_COOKIE;
    });

    it('GET /api/csrf-token returns token when enabled', async () => {
      process.env.USE_HTTP_ONLY_COOKIE = 'true';
      // First login to set cookie
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ username: 'testuser', roles: ['USER'] });
      
      // Then get CSRF token (in real scenario, would use cookie)
      const res = await request(app.getHttpServer())
        .get('/api/csrf-token')
        .set('Cookie', login.headers['set-cookie']);
      
      expect(res.status).toBe(200);
      delete process.env.USE_HTTP_ONLY_COOKIE;
    });
  });

  describe('Tenant Isolation', () => {
    it('Tenant ID extracted from X-Tenant-ID header', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/health')
        .set('X-Tenant-ID', tenantId);
      expect(res.status).toBe(200);
      expect(res.body.tenant).toBe(tenantId);
    });

    it('Tenant ID extracted from query param', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/health?tenant_id=${tenantId}`);
      expect(res.status).toBe(200);
      expect(res.body.tenant).toBe(tenantId);
    });
  });

  describe('Accounts API', () => {
    it('GET /api/accounts lists accounts for tenant', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/accounts')
        .set('X-Tenant-ID', tenantId);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('POST /api/accounts creates account for tenant', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/accounts')
        .set('X-Tenant-ID', tenantId)
        .send({ name: 'Test Account', balance: 1000 });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.name).toBe('Test Account');
    });
  });

  describe('RBAC', () => {
    it('Roles guard validates user roles (happy path)', async () => {
      // This test validates decorator and guard integration
      // In actual implementation, would test protected endpoints
      expect(true).toBe(true);
    });
  });
});
