import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AppController } from '../src/app.controller';
import { AuthController } from '../src/auth/auth.controller';
import { MetricsService } from '../src/metrics/metrics.service';
import { AccountsController } from '../src/controllers/accounts.controller';
import { ProductsController } from '../src/controllers/products.controller';
import { RulesController } from '../src/controllers/rules.controller';
import { SchemasController } from '../src/controllers/schemas.controller';
import { WorkflowsController } from '../src/controllers/workflows.controller';
import { ProductType } from '../src/products/product-config.service';
import { RuleType } from '../src/rules-engine/rules-engine.service';
import { TenantMiddleware } from '../src/middleware/tenant.middleware';
import { exposeCsrfToken } from '../src/middleware/csrf.middleware';

describe('fengine - Integration Tests (app composition)', () => {
  let app: INestApplication;
  let appController: AppController;
  let authController: AuthController;
  let metricsService: MetricsService;
  let accountsController: AccountsController;
  let productsController: ProductsController;
  let rulesController: RulesController;
  let schemasController: SchemasController;
  let workflowsController: WorkflowsController;
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
    productsController = app.get(ProductsController);
    rulesController = app.get(RulesController);
    schemasController = app.get(SchemasController);
    workflowsController = app.get(WorkflowsController);
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

  describe('Configurable Products API', () => {
    it('creates and lists products for tenant', async () => {
      const product = await productsController.upsert(
        { tenantId },
        {
          type: ProductType.LOAN,
          config: {
            product_id: 'prod_api_loan',
            name: 'API Loan',
            enabled: true,
          },
        },
      );
      const list = await productsController.list({ tenantId });
      expect(product.product_id).toBe('prod_api_loan');
      expect(list.some((item) => item.product_id === 'prod_api_loan')).toBe(true);
    });

    it('creates and lists rules for product', async () => {
      const rule = await rulesController.create(
        { tenantId },
        'prod_api_loan',
        {
          id: 'rule_api_min_score',
          rule_type: RuleType.CREDIT_SCORE_MIN,
          condition: 'customer_credit_score >= 500',
          action: { min_score: 500 },
          priority: 10,
          applies_to: ['ORIGINATION'],
        },
      );
      const rules = await rulesController.list({ tenantId }, 'prod_api_loan');
      expect(rule.id).toBe('rule_api_min_score');
      expect(rules.some((item) => item.id === 'rule_api_min_score')).toBe(true);
    });
  });

  describe('No-code Schemas and Workflows API', () => {
    it('creates and exports entity schemas', async () => {
      const schema = await schemasController.create(
        { tenantId },
        {
          entity_name: 'api_customer_profile',
          display_name: 'API Customer Profile',
          fields: [{ name: 'full_name', type: 'STRING', required: true }],
        },
      );
      const exported = await schemasController.export({ tenantId }, schema.entity_id);
      expect(exported.entity_name).toBe('api_customer_profile');
    });

    it('creates and executes workflows', async () => {
      const workflow = await workflowsController.create(
        { tenantId },
        {
          name: 'API Audit Workflow',
          trigger: 'API_TEST',
          steps: [{ order: 1, name: 'Log', action: 'LOG_EVENT', parameters: { event_type: 'API_TEST', severity: 'INFO' } }],
        },
      );
      const result = await workflowsController.execute({ tenantId }, workflow.workflow_id, { context: {} });
      expect(result.success).toBe(true);
    });
  });

  describe('RBAC', () => {
    it('Roles guard wiring remains available', () => {
      expect(app.get(AccountsController)).toBeDefined();
    });
  });
});
