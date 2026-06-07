import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import type { ProductSchema, TenantConfigSchema } from '../products/product-config.service';
import type { Loan } from '../loans/loan.service';
import type { Transaction } from '../transactions/transaction.service';
import type { ChartOfAccounts, JournalEntry } from '../ledger/ledger.service';
import type { CustomEntitySchema, WorkflowDefinition } from '../schema-manager/schema-manager.service';
import type { Rule } from '../rules-engine/rules-engine.service';

@Injectable()
export class FengineStoreService {
  private readonly tenantConfigs = new Map<string, TenantConfigSchema>();
  private readonly products = new Map<string, Map<string, ProductSchema>>();
  private readonly loans = new Map<string, Map<string, Loan>>();
  private readonly transactions = new Map<string, Map<string, Transaction>>();
  private readonly chartOfAccounts = new Map<string, Map<string, ChartOfAccounts>>();
  private readonly journalEntries = new Map<string, Map<string, JournalEntry>>();
  private readonly schemas = new Map<string, Map<string, CustomEntitySchema>>();
  private readonly workflows = new Map<string, Map<string, WorkflowDefinition>>();
  private readonly rules = new Map<string, Map<string, Rule>>();

  constructor(private readonly prisma: PrismaService) {}

  async saveTenantConfig(config: TenantConfigSchema): Promise<TenantConfigSchema> {
    if (!this.prisma.isConfigured) {
      this.tenantConfigs.set(config.tenant_id, config);
      return config;
    }

    await this.enterTenant(config.tenant_id);
    await this.prisma.db.$executeRaw`
      INSERT INTO "tenant_configs" ("id", "tenantId", "config")
      VALUES (${this.id('tcfg')}, ${config.tenant_id}, CAST(${this.json(config)} AS jsonb))
    `;
    return config;
  }

  async getTenantConfig(tenantId: string): Promise<TenantConfigSchema | undefined> {
    if (!this.prisma.isConfigured) {
      return this.tenantConfigs.get(tenantId);
    }

    await this.enterTenant(tenantId);
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      SELECT "config" FROM "tenant_configs"
      WHERE "tenantId" = ${tenantId}
      ORDER BY "createdAt" DESC
      LIMIT 1
    `;
    return row ? this.fromJson<TenantConfigSchema>(row.config) : undefined;
  }

  async saveProduct(tenantId: string, product: ProductSchema): Promise<ProductSchema> {
    if (!this.prisma.isConfigured) {
      const tenantProducts = this.products.get(tenantId) || new Map<string, ProductSchema>();
      tenantProducts.set(product.product_id, product);
      this.products.set(tenantId, tenantProducts);
      return product;
    }

    await this.enterTenant(tenantId);
    await this.prisma.db.$executeRaw`
      INSERT INTO "products" ("id", "tenantId", "type", "name", "enabled", "config", "updatedAt")
      VALUES (${product.product_id}, ${tenantId}, ${product.type}, ${product.name}, ${product.enabled}, CAST(${this.json(product)} AS jsonb), now())
      ON CONFLICT ("tenantId", "id") DO UPDATE SET
        "type" = EXCLUDED."type",
        "name" = EXCLUDED."name",
        "enabled" = EXCLUDED."enabled",
        "config" = EXCLUDED."config",
        "updatedAt" = now()
    `;
    return product;
  }

  async listProducts(tenantId: string): Promise<ProductSchema[]> {
    if (!this.prisma.isConfigured) {
      return [...(this.products.get(tenantId)?.values() || [])];
    }

    await this.enterTenant(tenantId);
    const rows = await this.prisma.db.$queryRaw<any[]>`
      SELECT "config" FROM "products" WHERE "tenantId" = ${tenantId} ORDER BY "createdAt" ASC
    `;
    return rows.map((row) => this.fromJson<ProductSchema>(row.config));
  }

  async getProduct(tenantId: string, productId: string): Promise<ProductSchema | undefined> {
    if (!this.prisma.isConfigured) {
      return this.products.get(tenantId)?.get(productId);
    }

    await this.enterTenant(tenantId);
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      SELECT "config" FROM "products" WHERE "tenantId" = ${tenantId} AND "id" = ${productId} LIMIT 1
    `;
    return row ? this.fromJson<ProductSchema>(row.config) : undefined;
  }

  async saveLoan(tenantId: string, loan: Loan): Promise<Loan> {
    if (!this.prisma.isConfigured) {
      const tenantLoans = this.loans.get(tenantId) || new Map<string, Loan>();
      tenantLoans.set(loan.id, loan);
      this.loans.set(tenantId, tenantLoans);
      return loan;
    }

    await this.enterTenant(tenantId);
    await this.prisma.db.$executeRaw`
      INSERT INTO "loans" ("id", "tenantId", "customerId", "productId", "status", "data", "updatedAt")
      VALUES (${loan.id}, ${tenantId}, ${loan.customer_id}, ${loan.product_id}, ${loan.status}, CAST(${this.json(loan)} AS jsonb), now())
      ON CONFLICT ("tenantId", "id") DO UPDATE SET
        "customerId" = EXCLUDED."customerId",
        "productId" = EXCLUDED."productId",
        "status" = EXCLUDED."status",
        "data" = EXCLUDED."data",
        "updatedAt" = now()
    `;
    return loan;
  }

  async listLoans(tenantId: string): Promise<Loan[]> {
    if (!this.prisma.isConfigured) {
      return [...(this.loans.get(tenantId)?.values() || [])];
    }

    await this.enterTenant(tenantId);
    const rows = await this.prisma.db.$queryRaw<any[]>`
      SELECT "data" FROM "loans" WHERE "tenantId" = ${tenantId} ORDER BY "createdAt" ASC
    `;
    return rows.map((row) => this.fromJson<Loan>(row.data));
  }

  async getLoan(tenantId: string, loanId: string): Promise<Loan | undefined> {
    if (!this.prisma.isConfigured) {
      return this.loans.get(tenantId)?.get(loanId);
    }

    await this.enterTenant(tenantId);
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      SELECT "data" FROM "loans" WHERE "tenantId" = ${tenantId} AND "id" = ${loanId} LIMIT 1
    `;
    return row ? this.fromJson<Loan>(row.data) : undefined;
  }

  async saveTransaction(tenantId: string, transaction: Transaction): Promise<Transaction> {
    if (!this.prisma.isConfigured) {
      const tenantTransactions = this.transactions.get(tenantId) || new Map<string, Transaction>();
      tenantTransactions.set(transaction.id, transaction);
      this.transactions.set(tenantId, tenantTransactions);
      return transaction;
    }

    await this.enterTenant(tenantId);
    await this.prisma.db.$executeRaw`
      INSERT INTO "financial_transactions" ("id", "tenantId", "type", "status", "amount", "currency", "loanId", "idempotencyKey", "data", "postedAt")
      VALUES (${transaction.id}, ${tenantId}, ${transaction.transaction_type}, ${transaction.status}, ${transaction.amount}, ${transaction.currency}, ${transaction.loan_id || null}, ${transaction.idempotency_key || null}, CAST(${this.json(transaction)} AS jsonb), ${transaction.posted_at || null})
      ON CONFLICT ("tenantId", "id") DO UPDATE SET
        "status" = EXCLUDED."status",
        "amount" = EXCLUDED."amount",
        "currency" = EXCLUDED."currency",
        "loanId" = EXCLUDED."loanId",
        "idempotencyKey" = EXCLUDED."idempotencyKey",
        "data" = EXCLUDED."data",
        "postedAt" = EXCLUDED."postedAt"
    `;
    return transaction;
  }

  async getTransactionByIdempotencyKey(tenantId: string, key: string): Promise<Transaction | undefined> {
    if (!this.prisma.isConfigured) {
      return [...(this.transactions.get(tenantId)?.values() || [])].find(
        (transaction) => transaction.idempotency_key === key,
      );
    }

    await this.enterTenant(tenantId);
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      SELECT "data" FROM "financial_transactions"
      WHERE "tenantId" = ${tenantId} AND "idempotencyKey" = ${key}
      LIMIT 1
    `;
    return row ? this.fromJson<Transaction>(row.data) : undefined;
  }

  async listTransactions(tenantId: string): Promise<Transaction[]> {
    if (!this.prisma.isConfigured) {
      return [...(this.transactions.get(tenantId)?.values() || [])];
    }

    await this.enterTenant(tenantId);
    const rows = await this.prisma.db.$queryRaw<any[]>`
      SELECT "data" FROM "financial_transactions" WHERE "tenantId" = ${tenantId} ORDER BY "createdAt" ASC
    `;
    return rows.map((row) => this.fromJson<Transaction>(row.data));
  }

  async saveChartOfAccounts(tenantId: string, accounts: ChartOfAccounts[]): Promise<ChartOfAccounts[]> {
    if (!this.prisma.isConfigured) {
      const accountMap = new Map(accounts.map((account) => [account.account_code, account]));
      this.chartOfAccounts.set(tenantId, accountMap);
      return accounts;
    }

    await this.enterTenant(tenantId);
    for (const account of accounts) {
      await this.saveAccount(tenantId, account);
    }
    return accounts;
  }

  async listChartOfAccounts(tenantId: string): Promise<ChartOfAccounts[]> {
    if (!this.prisma.isConfigured) {
      return [...(this.chartOfAccounts.get(tenantId)?.values() || [])];
    }

    await this.enterTenant(tenantId);
    const rows = await this.prisma.db.$queryRaw<any[]>`
      SELECT * FROM "ledger_accounts" WHERE "tenantId" = ${tenantId} ORDER BY "accountCode" ASC
    `;
    return rows.map((row) => ({
      account_code: row.accountCode,
      account_name: row.accountName,
      account_class: row.accountClass as ChartOfAccounts['account_class'],
      account_subclass: row.accountSubclass,
      balance_debit: Number(row.balanceDebit),
      balance_credit: Number(row.balanceCredit),
      currency: row.currency,
      is_active: row.isActive,
      created_at: row.createdAt,
    }));
  }

  async getAccount(tenantId: string, accountCode: string): Promise<ChartOfAccounts | undefined> {
    if (!this.prisma.isConfigured) {
      return this.chartOfAccounts.get(tenantId)?.get(accountCode);
    }

    await this.enterTenant(tenantId);
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      SELECT * FROM "ledger_accounts"
      WHERE "tenantId" = ${tenantId} AND "accountCode" = ${accountCode}
      LIMIT 1
    `;
    return row
      ? {
          account_code: row.accountCode,
          account_name: row.accountName,
          account_class: row.accountClass as ChartOfAccounts['account_class'],
          account_subclass: row.accountSubclass,
          balance_debit: Number(row.balanceDebit),
          balance_credit: Number(row.balanceCredit),
          currency: row.currency,
          is_active: row.isActive,
          created_at: row.createdAt,
        }
      : undefined;
  }

  async saveAccount(tenantId: string, account: ChartOfAccounts): Promise<ChartOfAccounts> {
    if (!this.prisma.isConfigured) {
      const accounts = this.chartOfAccounts.get(tenantId) || new Map<string, ChartOfAccounts>();
      accounts.set(account.account_code, account);
      this.chartOfAccounts.set(tenantId, accounts);
      return account;
    }

    await this.enterTenant(tenantId);
    await this.prisma.db.$executeRaw`
      INSERT INTO "ledger_accounts" ("id", "tenantId", "accountCode", "accountName", "accountClass", "accountSubclass", "balanceDebit", "balanceCredit", "currency", "isActive", "createdAt")
      VALUES (${this.id('la')}, ${tenantId}, ${account.account_code}, ${account.account_name}, ${account.account_class}, ${account.account_subclass}, ${account.balance_debit}, ${account.balance_credit}, ${account.currency}, ${account.is_active}, ${account.created_at})
      ON CONFLICT ("tenantId", "accountCode") DO UPDATE SET
        "accountName" = EXCLUDED."accountName",
        "accountClass" = EXCLUDED."accountClass",
        "accountSubclass" = EXCLUDED."accountSubclass",
        "balanceDebit" = EXCLUDED."balanceDebit",
        "balanceCredit" = EXCLUDED."balanceCredit",
        "currency" = EXCLUDED."currency",
        "isActive" = EXCLUDED."isActive"
    `;
    return account;
  }

  async saveJournalEntry(tenantId: string, entry: JournalEntry): Promise<JournalEntry> {
    if (!this.prisma.isConfigured) {
      const tenantEntries = this.journalEntries.get(tenantId) || new Map<string, JournalEntry>();
      tenantEntries.set(entry.entry_id, entry);
      this.journalEntries.set(tenantId, tenantEntries);
      return entry;
    }

    await this.enterTenant(tenantId);
    await this.prisma.db.$executeRaw`
      INSERT INTO "journal_entries" ("id", "tenantId", "transactionId", "description", "postedBy", "status", "entryDate", "postingDate", "lines", "metadata")
      VALUES (${entry.entry_id}, ${tenantId}, ${entry.transaction_id}, ${entry.description}, ${entry.posted_by}, ${entry.status}, ${entry.entry_date}, ${entry.posting_date}, CAST(${this.json(entry.entries)} AS jsonb), CAST(${this.json(entry.metadata)} AS jsonb))
      ON CONFLICT ("tenantId", "id") DO UPDATE SET
        "transactionId" = EXCLUDED."transactionId",
        "description" = EXCLUDED."description",
        "postedBy" = EXCLUDED."postedBy",
        "status" = EXCLUDED."status",
        "entryDate" = EXCLUDED."entryDate",
        "postingDate" = EXCLUDED."postingDate",
        "lines" = EXCLUDED."lines",
        "metadata" = EXCLUDED."metadata"
    `;
    return entry;
  }

  async listJournalEntries(tenantId: string): Promise<JournalEntry[]> {
    if (!this.prisma.isConfigured) {
      return [...(this.journalEntries.get(tenantId)?.values() || [])];
    }

    await this.enterTenant(tenantId);
    const rows = await this.prisma.db.$queryRaw<any[]>`
      SELECT * FROM "journal_entries" WHERE "tenantId" = ${tenantId} ORDER BY "entryDate" ASC
    `;
    return rows.map((row) => ({
      entry_id: row.id,
      entry_date: row.entryDate,
      transaction_id: row.transactionId,
      description: row.description,
      posted_by: row.postedBy,
      posting_date: row.postingDate,
      entries: this.fromJson(row.lines),
      status: row.status as JournalEntry['status'],
      metadata: this.fromJson(row.metadata),
    }));
  }

  async saveSchema(tenantId: string, schema: CustomEntitySchema): Promise<CustomEntitySchema> {
    if (!this.prisma.isConfigured) {
      const tenantSchemas = this.schemas.get(tenantId) || new Map<string, CustomEntitySchema>();
      tenantSchemas.set(schema.entity_id, schema);
      this.schemas.set(tenantId, tenantSchemas);
      return schema;
    }

    await this.enterTenant(tenantId);
    await this.prisma.db.$executeRaw`
      INSERT INTO "custom_entity_schemas" ("id", "tenantId", "entityName", "displayName", "fields", "createdAt", "updatedAt")
      VALUES (${schema.entity_id}, ${tenantId}, ${schema.entity_name}, ${schema.display_name}, CAST(${this.json(schema.fields)} AS jsonb), ${schema.created_at}, now())
      ON CONFLICT ("tenantId", "id") DO UPDATE SET
        "entityName" = EXCLUDED."entityName",
        "displayName" = EXCLUDED."displayName",
        "fields" = EXCLUDED."fields",
        "updatedAt" = now()
    `;
    return schema;
  }

  async listSchemas(tenantId: string): Promise<CustomEntitySchema[]> {
    if (!this.prisma.isConfigured) {
      return [...(this.schemas.get(tenantId)?.values() || [])];
    }

    await this.enterTenant(tenantId);
    const rows = await this.prisma.db.$queryRaw<any[]>`
      SELECT * FROM "custom_entity_schemas" WHERE "tenantId" = ${tenantId} ORDER BY "createdAt" ASC
    `;
    return rows.map((row) => ({
      entity_id: row.id,
      tenant_id: row.tenantId,
      entity_name: row.entityName,
      display_name: row.displayName,
      fields: this.fromJson(row.fields),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    }));
  }

  async getSchema(tenantId: string, schemaId: string): Promise<CustomEntitySchema | undefined> {
    if (!this.prisma.isConfigured) {
      return this.schemas.get(tenantId)?.get(schemaId);
    }

    await this.enterTenant(tenantId);
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      SELECT * FROM "custom_entity_schemas"
      WHERE "tenantId" = ${tenantId} AND "id" = ${schemaId}
      LIMIT 1
    `;
    return row
      ? {
          entity_id: row.id,
          tenant_id: row.tenantId,
          entity_name: row.entityName,
          display_name: row.displayName,
          fields: this.fromJson(row.fields),
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        }
      : undefined;
  }

  async saveWorkflow(tenantId: string, workflow: WorkflowDefinition): Promise<WorkflowDefinition> {
    if (!this.prisma.isConfigured) {
      const tenantWorkflows = this.workflows.get(tenantId) || new Map<string, WorkflowDefinition>();
      tenantWorkflows.set(workflow.workflow_id, workflow);
      this.workflows.set(tenantId, tenantWorkflows);
      return workflow;
    }

    await this.enterTenant(tenantId);
    await this.prisma.db.$executeRaw`
      INSERT INTO "workflow_definitions" ("id", "tenantId", "name", "trigger", "steps", "enabled", "updatedAt")
      VALUES (${workflow.workflow_id}, ${tenantId}, ${workflow.name}, ${workflow.trigger}, CAST(${this.json(workflow.steps)} AS jsonb), ${workflow.enabled}, now())
      ON CONFLICT ("tenantId", "id") DO UPDATE SET
        "name" = EXCLUDED."name",
        "trigger" = EXCLUDED."trigger",
        "steps" = EXCLUDED."steps",
        "enabled" = EXCLUDED."enabled",
        "updatedAt" = now()
    `;
    return workflow;
  }

  async listWorkflows(tenantId: string): Promise<WorkflowDefinition[]> {
    if (!this.prisma.isConfigured) {
      return [...(this.workflows.get(tenantId)?.values() || [])];
    }

    await this.enterTenant(tenantId);
    const rows = await this.prisma.db.$queryRaw<any[]>`
      SELECT * FROM "workflow_definitions" WHERE "tenantId" = ${tenantId} ORDER BY "createdAt" ASC
    `;
    return rows.map((row) => ({
      workflow_id: row.id,
      name: row.name,
      trigger: row.trigger,
      steps: this.fromJson(row.steps),
      enabled: row.enabled,
    }));
  }

  async listWorkflowsByTrigger(tenantId: string, trigger: string): Promise<WorkflowDefinition[]> {
    if (!this.prisma.isConfigured) {
      return [...(this.workflows.get(tenantId)?.values() || [])].filter(
        (workflow) => workflow.trigger === trigger && workflow.enabled,
      );
    }

    await this.enterTenant(tenantId);
    const rows = await this.prisma.db.$queryRaw<any[]>`
      SELECT * FROM "workflow_definitions"
      WHERE "tenantId" = ${tenantId} AND "trigger" = ${trigger} AND "enabled" = true
      ORDER BY "createdAt" ASC
    `;
    return rows.map((row) => ({
      workflow_id: row.id,
      name: row.name,
      trigger: row.trigger,
      steps: this.fromJson(row.steps),
      enabled: row.enabled,
    }));
  }

  async getWorkflow(tenantId: string, workflowId: string): Promise<WorkflowDefinition | undefined> {
    if (!this.prisma.isConfigured) {
      return this.workflows.get(tenantId)?.get(workflowId);
    }

    await this.enterTenant(tenantId);
    const [row] = await this.prisma.db.$queryRaw<any[]>`
      SELECT * FROM "workflow_definitions"
      WHERE "tenantId" = ${tenantId} AND "id" = ${workflowId}
      LIMIT 1
    `;
    return row
      ? {
          workflow_id: row.id,
          name: row.name,
          trigger: row.trigger,
          steps: this.fromJson(row.steps),
          enabled: row.enabled,
        }
      : undefined;
  }

  async saveRules(tenantId: string, productId: string, rules: Rule[]): Promise<Rule[]> {
    for (const rule of rules) {
      await this.saveRule(tenantId, rule);
    }
    if (!this.prisma.isConfigured) {
      this.rules.set(productId, new Map(rules.map((rule) => [rule.id, rule])));
    }
    return rules;
  }

  async saveRule(tenantId: string, rule: Rule): Promise<Rule> {
    if (!this.prisma.isConfigured) {
      const productRules = this.rules.get(rule.product_id) || new Map<string, Rule>();
      productRules.set(rule.id, rule);
      this.rules.set(rule.product_id, productRules);
      return rule;
    }

    await this.enterTenant(tenantId);
    await this.prisma.db.$executeRaw`
      INSERT INTO "rules" ("id", "tenantId", "productId", "ruleType", "condition", "action", "priority", "enabled", "appliesTo", "createdAt", "updatedAt")
      VALUES (${rule.id}, ${tenantId}, ${rule.product_id}, ${rule.rule_type}, ${rule.condition}, CAST(${this.json(rule.action)} AS jsonb), ${rule.priority}, ${rule.enabled}, CAST(${this.json(rule.applies_to || [])} AS jsonb), ${rule.created_at}, now())
      ON CONFLICT ("tenantId", "id") DO UPDATE SET
        "productId" = EXCLUDED."productId",
        "ruleType" = EXCLUDED."ruleType",
        "condition" = EXCLUDED."condition",
        "action" = EXCLUDED."action",
        "priority" = EXCLUDED."priority",
        "enabled" = EXCLUDED."enabled",
        "appliesTo" = EXCLUDED."appliesTo",
        "updatedAt" = now()
    `;
    return rule;
  }

  async listRules(productId: string, tenantId?: string): Promise<Rule[]> {
    if (!this.prisma.isConfigured) {
      return [...(this.rules.get(productId)?.values() || [])];
    }

    if (tenantId) {
      await this.enterTenant(tenantId);
    }
    const rows = tenantId
      ? await this.prisma.db.$queryRaw<any[]>`
          SELECT * FROM "rules"
          WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}
          ORDER BY "priority" DESC, "createdAt" ASC
        `
      : await this.prisma.db.$queryRaw<any[]>`
          SELECT * FROM "rules"
          WHERE "productId" = ${productId}
          ORDER BY "priority" DESC, "createdAt" ASC
        `;
    return rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenantId,
      product_id: row.productId,
      rule_type: row.ruleType as Rule['rule_type'],
      condition: row.condition,
      action: this.fromJson(row.action),
      priority: row.priority,
      enabled: row.enabled,
      applies_to: this.fromJson(row.appliesTo || []),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    }));
  }

  async deleteRule(productId: string, ruleId: string): Promise<void> {
    if (!this.prisma.isConfigured) {
      const rules = this.rules.get(productId);
      rules?.delete(ruleId);
      return;
    }

    await this.prisma.db.$executeRaw`
      DELETE FROM "rules" WHERE "productId" = ${productId} AND "id" = ${ruleId}
    `;
  }

  private toJson<T>(value: T): any {
    return JSON.parse(JSON.stringify(value));
  }

  private json<T>(value: T): string {
    return JSON.stringify(this.toJson(value));
  }

  private id(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private fromJson<T>(value: unknown): T {
    return value as T;
  }

  private async enterTenant(tenantId: string): Promise<void> {
    await this.prisma.ensureTenant(tenantId);
    await this.prisma.setTenantContext(tenantId);
  }
}
