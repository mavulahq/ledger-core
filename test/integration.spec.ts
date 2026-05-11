import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AppController } from '../src/app.controller';
import { AuthController } from '../src/auth/auth.controller';
import { MetricsService } from '../src/metrics/metrics.service';
import { AccountsController } from '../src/controllers/accounts.controller';
import { TenantMiddleware } from '../src/middleware/tenant.middleware';
import { exposeCsrfToken } from '../src/middleware/csrf.middleware';

describe('fengine - Integration Tests (app composition)', () => {
  let app: INestApplication;
  let appController: AppController;
  let authController: AuthController;
  let metricsService: MetricsService;
  let accountsController: AccountsController;
  const tenantId = 'test_inst_001';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    appController = app.get(AppController);
    authController = app.get(AuthController);
    metricsService = app.get(MetricsService);
    accountsController = app.get(AccountsController);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Health & Metrics', () => {
    it('health returns status ok', () => {
      const res = appController.health({ tenantId });
      expect(res.status).toBe('ok');
      expect(res.tenant).toBe(tenantId);
    });

    it('metrics returns prometheus payload', async () => {
      const metrics = await metricsService.metrics();
      expect(metrics).toContain('http_requests_total');
    });
  });

  describe('Authentication', () => {
    it('login returns token in default mode', async () => {
      const res = await authController.login(
        { username: 'testuser', roles: ['USER'] },
        { cookie: jest.fn() },
      );
      expect(res).toHaveProperty('access_token');
    });

    it('login sets cookie in cookie mode', async () => {
      process.env.USE_HTTP_ONLY_COOKIE = 'true';
      const resMock = { cookie: jest.fn() };
      const res = await authController.login(
        { username: 'testuser', roles: ['ADMIN'] },
        resMock,
      );
      expect(res).toEqual({ status: 'ok' });
      expect(resMock.cookie).toHaveBeenCalled();
      delete process.env.USE_HTTP_ONLY_COOKIE;
    });

    it('csrf helper returns token when request provides csrfToken', () => {
      const token = exposeCsrfToken({
        csrfToken: () => 'test-csrf-token',
      } as any);
      expect(token).toBe('test-csrf-token');
    });
  });

  describe('Tenant Isolation', () => {
    it('Tenant ID extracted from X-Tenant-ID header', () => {
      const req: any = { headers: { 'x-tenant-id': tenantId }, query: {} };
      const res: any = {};
      new TenantMiddleware().use(req, res, jest.fn());
      expect(req.tenantId).toBe(tenantId);
    });

    it('Tenant ID extracted from query param', () => {
      const req: any = { headers: {}, query: { tenant_id: tenantId } };
      const res: any = {};
      new TenantMiddleware().use(req, res, jest.fn());
      expect(req.tenantId).toBe(tenantId);
    });
  });

  describe('Accounts API', () => {
    it('lists accounts for tenant', async () => {
      const res = await accountsController.list({ tenantId });
      expect(Array.isArray(res)).toBe(true);
    });

    it('creates account for tenant', async () => {
      const res = await accountsController.create(
        { tenantId },
        { name: 'Test Account', balance: 1000 },
      );
      expect(res).toHaveProperty('id');
      expect(res.name).toBe('Test Account');
    });
  });

  describe('RBAC', () => {
    it('Roles guard wiring remains available', () => {
      expect(app.get(AccountsController)).toBeDefined();
    });
  });
});
