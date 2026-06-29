/*
 * getfluxo.io - Product Configuration & Auto-Creation Engine
 * Copyright (c) 2025 getfluxo.io
 *
 * Author: EstandarMustaq <estandarmustaq@getfluxo.io>
 * License: Proprietary - See LICENSE file
 *
 * Auto-configurable financial products (CHECKING, SAVINGS, LOAN, CREDIT_LINE)
 * with schema-driven no-code customization
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../services/prisma.service';
import { FengineStoreService } from '../services/fengine-store.service';
import { AuditTrailService } from '../services/audit-trail.service';
import { DomainEventFactory } from '../domain-events/domain-event-factory.service';
import { DomainOutboxService } from '../domain-events/domain-outbox.service';

// Product types supported by getfluxo
export enum ProductType {
  CHECKING = 'CHECKING', // Conta corrente (transferências, débitos)
  SAVINGS = 'SAVINGS', // Conta poupança (juros, limites levantamento)
  LOAN = 'LOAN', // Crédito com parcelas fixas
  CREDIT_LINE = 'CREDIT_LINE', // Linha de crédito rotatória
}

// Auto-generated product configuration schema
export interface ProductSchema {
  product_id: string;
  version: number;
  tenant_id: string;
  name: string;
  type: ProductType;

  // Account-level settings (CHECKING/SAVINGS)
  minimum_balance?: number; // Saldo mínimo exigido
  maximum_balance?: number; // Limite de saldo
  overdraft_allowed?: boolean; // Permite saldo negativo (cheque especial)
  overdraft_limit?: number; // Limite de overdraft
  monthly_fee?: number; // Taxa mensal
  interest_rate?: number; // Taxa de juros (% ao mês)

  // Loan-level settings (LOAN)
  min_principal?: number; // Montante mínimo
  max_principal?: number; // Montante máximo
  min_term_months?: number; // Mínimo de parcelas
  max_term_months?: number; // Máximo de parcelas
  default_interest_rate?: number; // Taxa padrão (% ao mês)
  origination_fee?: number; // Taxa de originação (%)
  late_payment_fee?: number; // Taxa de atraso

  // Credit Line settings (CREDIT_LINE)
  credit_limit?: number; // Limite de crédito
  utilization_fee?: number; // Taxa de utilização
  min_payment_percent?: number; // Percentual mínimo de pagamento

  // General settings
  enabled: boolean; // Produto ativo
  created_at: Date;
  updated_at: Date;
}

// Dynamic schema for tenant-specific configuration
export interface TenantConfigSchema {
  tenant_id: string;
  products: ProductSchema[];
  fees_schedule: FeeSchedule[];
  interest_calculations: InterestCalculation[];
  payment_workflows: PaymentWorkflow[];
  compliance_rules: ComplianceRule[];
  created_at: Date;
}

export interface FeeSchedule {
  id: string;
  product_id: string;
  fee_type: string; // 'MONTHLY', 'TRANSACTION', 'ACCOUNT_MAINTENANCE'
  amount: number; // Valor fixo ou percentagem
  applies_to: string; // Condição (e.g., 'balance < 500')
  currency: string; // MZN, USD, ZAR
}

export interface InterestCalculation {
  id: string;
  product_id: string;
  method: string; // 'SIMPLE', 'COMPOUND', 'DAILY_ACCRUAL'
  frequency: string; // 'DAILY', 'MONTHLY', 'QUARTERLY'
  rate_type: string; // 'FIXED', 'VARIABLE', 'TIERED'
  tiers?: TierRule[]; // Para rate_type = TIERED
}

export interface TierRule {
  from_amount: number;
  to_amount: number;
  rate_percent: number;
}

export interface PaymentWorkflow {
  id: string;
  product_id: string;
  name: string;
  steps: WorkflowStep[];
}

export interface WorkflowStep {
  order: number;
  action: string; // 'VALIDATE', 'CHARGE_FEE', 'UPDATE_BALANCE', 'RECORD_LEDGER'
  conditions?: string[];
}

export interface ComplianceRule {
  id: string;
  tenant_id: string;
  rule_type: string; // 'MAX_WITHDRAWAL', 'TRANSACTION_LIMIT', 'KYC_REQUIRED'
  parameters: Record<string, any>;
}

@Injectable()
export class ProductConfigService {
  private readonly productLocks = new Map<string, Promise<void>>();

  constructor(
    private prisma: PrismaService,
    private store: FengineStoreService,
    private auditTrail: AuditTrailService,
    private domainEvents: DomainEventFactory,
    private outbox: DomainOutboxService,
  ) {}

  /**
   * Create or update a tenant product configuration.
   */
  async createOrUpdateProduct(
    tenantId: string,
    productType: ProductType,
    config: Partial<ProductSchema>,
  ): Promise<ProductSchema> {
    const productId = config.product_id || `prod_${productType.toLowerCase()}_${Date.now()}`;

    return this.withProductLock(tenantId, productId, async () => {
      const product = this.prisma.isConfigured
        ? await this.createOrUpdateConfiguredProduct(tenantId, productId, productType, config)
        : await this.createOrUpdateMemoryProduct(tenantId, productId, productType, config);

      this.recordProductUpsertAudit(tenantId, productId, productType, product);
      return product;
    });
  }

  private async createOrUpdateMemoryProduct(
    tenantId: string,
    productId: string,
    productType: ProductType,
    config: Partial<ProductSchema>,
  ): Promise<ProductSchema> {
    const existing = await this.store.getProduct(tenantId, productId);
    const product = this.buildProduct(tenantId, productId, productType, config, existing);
    await this.store.saveProduct(tenantId, product);
    await this.outbox.append(
      this.domainEvents.productsConfigurationPublished({ tenantId, product }),
    );
    return product;
  }

  private async createOrUpdateConfiguredProduct(
    tenantId: string,
    productId: string,
    productType: ProductType,
    config: Partial<ProductSchema>,
  ): Promise<ProductSchema> {
    await this.prisma.ensureTenant(tenantId);

    return this.prisma.db.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${productId}))`;

      const [existingRow] = (await tx.$queryRaw`
        SELECT "config" FROM "products"
        WHERE "tenantId" = ${tenantId} AND "id" = ${productId}
        FOR UPDATE
      `) as any[];
      const existing = existingRow ? this.decodeProductConfig(existingRow.config) : undefined;
      const product = this.buildProduct(tenantId, productId, productType, config, existing);
      const event = this.domainEvents.productsConfigurationPublished({ tenantId, product });
      const maxAttempts = Number(process.env.FENGINE_OUTBOX_MAX_ATTEMPTS || 3);

      await tx.$executeRaw`
        INSERT INTO "products" ("id", "tenantId", "type", "name", "enabled", "config", "updatedAt")
        VALUES (${product.product_id}, ${tenantId}, ${product.type}, ${product.name}, ${product.enabled}, CAST(${JSON.stringify(product)} AS jsonb), now())
        ON CONFLICT ("tenantId", "id") DO UPDATE SET
          "type" = EXCLUDED."type",
          "name" = EXCLUDED."name",
          "enabled" = EXCLUDED."enabled",
          "config" = EXCLUDED."config",
          "updatedAt" = now()
      `;

      await tx.$executeRaw`
        INSERT INTO "domain_outbox_events" (
          "eventId", "tenantId", "eventType", "eventVersion", "occurredAt",
          "aggregateType", "aggregateId", "aggregateVersion",
          "correlationId", "causationId", "idempotencyKey",
          "payload", "metadata", "status", "attempts", "maxAttempts", "availableAt", "updatedAt"
        )
        VALUES (
          ${event.event_id}, ${event.tenant_id}, ${event.event_type}, ${event.event_version}, ${new Date(event.occurred_at)},
          ${event.aggregate.type}, ${event.aggregate.id}, ${event.aggregate.version},
          ${event.correlation_id}, ${event.causation_id}, ${event.idempotency_key || null},
          CAST(${JSON.stringify(event.payload)} AS jsonb), CAST(${JSON.stringify(event.metadata)} AS jsonb),
          'PENDING', 0, ${maxAttempts}, now(), now()
        )
        ON CONFLICT ("tenantId", "idempotencyKey") DO UPDATE SET
          "updatedAt" = "domain_outbox_events"."updatedAt"
      `;

      return product;
    });
  }

  private buildProduct(
    tenantId: string,
    productId: string,
    productType: ProductType,
    config: Partial<ProductSchema>,
    existing?: ProductSchema,
  ): ProductSchema {
    const now = new Date();
    const defaults = this.getDefaultProductConfig(productType);

    return {
      ...defaults,
      ...config,
      tenant_id: tenantId,
      product_id: productId,
      version: existing ? Math.max(1, Number(existing.version || 1)) + 1 : 1,
      created_at: existing?.created_at || config.created_at || now,
      updated_at: now,
    } as ProductSchema;
  }

  private decodeProductConfig(value: any): ProductSchema {
    if (typeof value === 'string') {
      return JSON.parse(value) as ProductSchema;
    }
    return value as ProductSchema;
  }

  private recordProductUpsertAudit(
    tenantId: string,
    productId: string,
    productType: ProductType,
    product: ProductSchema,
  ): void {
    this.auditTrail.record({
      tenant_id: tenantId,
      action: 'product.upserted',
      entity_type: 'product',
      entity_id: productId,
      phase: 'ACT',
      metadata: { productType, enabled: product.enabled },
    });
  }

  private async withProductLock<T>(
    tenantId: string,
    productId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${tenantId}:${productId}`;
    const previous = this.productLocks.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => gate);
    this.productLocks.set(key, chained);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.productLocks.get(key) === chained) {
        this.productLocks.delete(key);
      }
    }
  }

  /**
   * Auto-generate schema for tenant based on regulatory jurisdiction
   */
  async generateTenantConfigSchema(
    tenantId: string,
    jurisdiction: string,
  ): Promise<TenantConfigSchema> {
    // Default config varies by jurisdiction (SADC, EU, etc.)
    const products: ProductSchema[] = [];

    // Auto-create standard products for institution
    const productTypes = [ProductType.CHECKING, ProductType.SAVINGS, ProductType.LOAN];

    for (const type of productTypes) {
      const product = await this.createOrUpdateProduct(tenantId, type, {
        enabled: true,
        name: `${type} Account`,
      });
      products.push(product);
    }

    const tenantConfig = {
      tenant_id: tenantId,
      products,
      fees_schedule: this.generateDefaultFeeSchedule(tenantId, products),
      interest_calculations: this.generateDefaultInterestCalculations(products),
      payment_workflows: this.generateDefaultWorkflows(products),
      compliance_rules: this.generateComplianceRules(jurisdiction),
      created_at: new Date(),
    };

    await this.store.saveTenantConfig(tenantConfig);
    this.auditTrail.record({
      tenant_id: tenantId,
      action: 'tenant.config.generated',
      entity_type: 'tenant_config',
      entity_id: tenantId,
      phase: 'ACT',
      metadata: { jurisdiction, product_count: products.length },
    });

    return tenantConfig;
  }

  listProducts(tenantId: string): Promise<ProductSchema[]> {
    return this.store.listProducts(tenantId);
  }

  getProduct(tenantId: string, productId: string): Promise<ProductSchema | undefined> {
    return this.store.getProduct(tenantId, productId);
  }

  getTenantConfig(tenantId: string): Promise<TenantConfigSchema | undefined> {
    return this.store.getTenantConfig(tenantId);
  }

  /**
   * Get preset defaults by product type
   */
  private getDefaultProductConfig(type: ProductType): Partial<ProductSchema> {
    switch (type) {
      case ProductType.CHECKING:
        return {
          type: ProductType.CHECKING,
          name: 'Checking Account',
          minimum_balance: 0,
          overdraft_allowed: true,
          overdraft_limit: 5000,
          monthly_fee: 50,
          enabled: true,
        };
      case ProductType.SAVINGS:
        return {
          type: ProductType.SAVINGS,
          name: 'Savings Account',
          minimum_balance: 0,
          interest_rate: 0.5, // 0.5% monthly
          monthly_fee: 0,
          enabled: true,
        };
      case ProductType.LOAN:
        return {
          type: ProductType.LOAN,
          name: 'Personal Loan',
          min_principal: 1000,
          max_principal: 50000,
          min_term_months: 3,
          max_term_months: 60,
          default_interest_rate: 2.5, // 2.5% monthly
          origination_fee: 2, // 2% upfront
          late_payment_fee: 50,
          enabled: true,
        };
      case ProductType.CREDIT_LINE:
        return {
          type: ProductType.CREDIT_LINE,
          name: 'Credit Line',
          credit_limit: 10000,
          utilization_fee: 1.5, // 1.5% monthly
          min_payment_percent: 5, // Pay at least 5% of balance
          enabled: true,
        };
      default:
        return { enabled: false };
    }
  }

  private generateDefaultFeeSchedule(tenantId: string, products: ProductSchema[]): FeeSchedule[] {
    return products
      .filter((p) => p.type === ProductType.CHECKING)
      .map((p) => ({
        id: `fee_${p.product_id}`,
        product_id: p.product_id!,
        fee_type: 'MONTHLY',
        amount: p.monthly_fee || 0,
        applies_to: 'always',
        currency: 'MZN',
      }));
  }

  private generateDefaultInterestCalculations(products: ProductSchema[]): InterestCalculation[] {
    return products
      .filter((p) => [ProductType.SAVINGS, ProductType.LOAN].includes(p.type))
      .map((p) => ({
        id: `interest_${p.product_id}`,
        product_id: p.product_id!,
        method: p.type === ProductType.SAVINGS ? 'DAILY_ACCRUAL' : 'SIMPLE',
        frequency: 'MONTHLY',
        rate_type: 'FIXED',
      }));
  }

  private generateDefaultWorkflows(products: ProductSchema[]): PaymentWorkflow[] {
    return products.map((p) => ({
      id: `workflow_${p.product_id}`,
      product_id: p.product_id!,
      name: `Standard payment workflow for ${p.name}`,
      steps: [
        { order: 1, action: 'VALIDATE' },
        { order: 2, action: 'CHARGE_FEE' },
        { order: 3, action: 'UPDATE_BALANCE' },
        { order: 4, action: 'RECORD_LEDGER' },
      ],
    }));
  }

  private generateComplianceRules(jurisdiction: string): ComplianceRule[] {
    // Compliance rules vary by jurisdiction
    if (jurisdiction === 'SADC') {
      return [
        {
          id: 'compliance_max_withdrawal',
          tenant_id: '',
          rule_type: 'MAX_WITHDRAWAL',
          parameters: { daily_limit: 5000000 }, // 5M MZN daily
        },
        {
          id: 'compliance_kyc',
          tenant_id: '',
          rule_type: 'KYC_REQUIRED',
          parameters: { min_amount: 50000 }, // KYC for amounts > 50K
        },
      ];
    }
    return [];
  }
}
