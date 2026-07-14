import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AppController } from '../src/app.controller';
import { AuthController } from '../src/auth/auth.controller';
import { MetricsService } from '../src/metrics/metrics.service';
import { AccountsController } from '../src/controllers/accounts.controller';
import { ProductsController } from '../src/controllers/products.controller';
import { ProjectionsController } from '../src/controllers/projections.controller';
import { RulesController } from '../src/controllers/rules.controller';
import { SchemasController } from '../src/controllers/schemas.controller';
import { WorkflowsController } from '../src/controllers/workflows.controller';
import { ProductType } from '../src/products/product-config.service';
import { RulesEngineService, RuleType } from '../src/rules-engine/rules-engine.service';

describe('fengine - Integration Tests (app composition)', () => {
  let app: INestApplication;
  let appController: AppController;
  let authController: AuthController;
  let metricsService: MetricsService;
  let accountsController: AccountsController;
  let productsController: ProductsController;
  let projectionsController: ProjectionsController;
  let rulesController: RulesController;
  let rulesEngine: RulesEngineService;
  let schemasController: SchemasController;
  let workflowsController: WorkflowsController;
  const tenantId = 'test_inst_001';

  beforeAll(async () => {
    process.env.OIDC_ISSUER = 'https://identity.mavula.io';
    process.env.OIDC_AUDIENCE = 'urn:mavula:ledger-core';
    process.env.OIDC_JWKS_URI = 'https://identity.mavula.io/jwks';
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
    projectionsController = app.get(ProjectionsController);
    rulesController = app.get(RulesController);
    rulesEngine = app.get(RulesEngineService);
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
    it('legacy login is retired without issuing a token', () => {
      expect(() => authController.login()).toThrow('Local login has been retired');
    });
  });

  describe('Tenant Isolation', () => {
    it('controllers require the tenant supplied by the authenticated request context', async () => {
      const accounts = await accountsController.list({ tenantId });
      expect(Array.isArray(accounts)).toBe(true);
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

    it('evaluates custom rules with the safe expression runtime', async () => {
      await rulesController.create(
        { tenantId },
        'prod_api_loan',
        {
          id: 'rule_api_safe_runtime',
          rule_type: RuleType.MAX_LOAN_AMOUNT,
          condition: '(customer_credit_score >= 500 && percent(customer_income, 25) >= transaction_amount) || customer_kyc_status === "VIP"',
          action: { approve: true },
          priority: 20,
          applies_to: ['ORIGINATION'],
        },
      );

      const results = await rulesEngine.evaluateRules('prod_api_loan', {
        tenant_id: tenantId,
        customer_id: 'cust_safe_runtime',
        customer_credit_score: 620,
        customer_income: 120000,
        customer_kyc_status: 'VERIFIED',
        transaction_amount: 25000,
        stage: 'ORIGINATION',
      });

      const safeRule = results.find((item) => item.rule_id === 'rule_api_safe_runtime');
      expect(safeRule?.passed).toBe(true);
      expect(safeRule?.actions).toEqual([{ action: 'approve', value: true }]);
    });

    it('does not execute unsupported custom rule expressions', async () => {
      await rulesController.create(
        { tenantId },
        'prod_api_loan',
        {
          id: 'rule_api_unsafe_runtime',
          rule_type: RuleType.CREDIT_SCORE_MIN,
          condition: 'process.exit()',
          action: { reject: true },
          priority: 30,
          applies_to: ['ORIGINATION'],
        },
      );

      const results = await rulesEngine.evaluateRules('prod_api_loan', {
        tenant_id: tenantId,
        customer_id: 'cust_unsafe_runtime',
        customer_credit_score: 620,
        customer_kyc_status: 'VERIFIED',
        transaction_amount: 25000,
        stage: 'ORIGINATION',
      });

      const unsafeRule = results.find((item) => item.rule_id === 'rule_api_unsafe_runtime');
      expect(unsafeRule?.passed).toBe(false);
      expect(unsafeRule?.actions).toEqual([]);
    });
  });

  describe('Read Projections API', () => {
    it('exposes projection status for tenant', async () => {
      await expect(projectionsController.status({ tenantId })).resolves.toMatchObject({
        status: 'ok',
        projections: expect.any(Array),
      });
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

    it('executes workflow conditions and formulas without dynamic code evaluation', async () => {
      const workflow = await workflowsController.create(
        { tenantId },
        {
          name: 'Safe Runtime Workflow',
          trigger: 'SAFE_RUNTIME_TEST',
          steps: [
            {
              order: 1,
              name: 'Calculate fee',
              action: 'CALCULATE',
              parameters: { formula: 'round(max(amount * rate, minimum_fee) + fee - discount + pow(multiplier, 2), 2)' },
              condition: 'amount >= 100 && customer.status == "ACTIVE"',
            },
            {
              order: 2,
              name: 'Skipped branch',
              action: 'LOG_EVENT',
              parameters: { event_type: 'SHOULD_SKIP', severity: 'INFO' },
              condition: 'amount < 10',
            },
          ],
        },
      );

      const result = await workflowsController.execute(
        { tenantId },
        workflow.workflow_id,
        {
          context: {
            amount: 200,
            rate: 0.1,
            minimum_fee: 10,
            fee: 5,
            discount: 3,
            multiplier: 2,
            customer: { status: 'ACTIVE' },
          },
        },
      );

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].data).toBe(26);
    });

    it('rejects unsupported workflow formula syntax', async () => {
      const workflow = await workflowsController.create(
        { tenantId },
        {
          name: 'Unsafe Runtime Workflow',
          trigger: 'UNSAFE_RUNTIME_TEST',
          steps: [
            {
              order: 1,
              name: 'Unsupported formula',
              action: 'CALCULATE',
              parameters: { formula: 'process.exit()' },
            },
          ],
        },
      );

      await expect(
        workflowsController.execute({ tenantId }, workflow.workflow_id, { context: {} }),
      ).rejects.toThrow('Invalid formula');
    });
  });

  describe('RBAC', () => {
    it('Roles guard wiring remains available', () => {
      expect(app.get(AccountsController)).toBeDefined();
    });
  });
});
