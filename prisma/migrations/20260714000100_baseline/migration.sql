-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "balance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "jurisdiction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_transactions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL,
    "loanId" TEXT,
    "idempotencyKey" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" TIMESTAMP(3),

    CONSTRAINT "financial_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountClass" TEXT NOT NULL,
    "accountSubclass" TEXT NOT NULL,
    "balanceDebit" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "balanceCredit" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "postedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "postingDate" TIMESTAMP(3) NOT NULL,
    "lines" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_entity_schemas" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_entity_schemas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "action" JSONB NOT NULL,
    "priority" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "appliesTo" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_trail_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "phase" TEXT,
    "actorId" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_trail_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_outbox_events" (
    "eventId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventVersion" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "aggregateVersion" INTEGER NOT NULL,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "payload" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_outbox_events_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "domain_inbox_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "consumerName" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_inbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "read_projections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectionName" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "lastEventId" TEXT NOT NULL,
    "lastEventType" TEXT NOT NULL,
    "lastEventVersion" INTEGER NOT NULL,
    "lastOccurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "read_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projection_checkpoints" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectionName" TEXT NOT NULL,
    "lastEventId" TEXT,
    "lastEventType" TEXT,
    "lastEventVersion" INTEGER,
    "lastOccurredAt" TIMESTAMP(3),
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "lagMs" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projection_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounts_tenantId_idx" ON "accounts"("tenantId");

-- CreateIndex
CREATE INDEX "products_tenantId_idx" ON "products"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenantId_id_key" ON "products"("tenantId", "id");

-- CreateIndex
CREATE INDEX "tenant_configs_tenantId_idx" ON "tenant_configs"("tenantId");

-- CreateIndex
CREATE INDEX "loans_tenantId_idx" ON "loans"("tenantId");

-- CreateIndex
CREATE INDEX "loans_tenantId_customerId_idx" ON "loans"("tenantId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "loans_tenantId_id_key" ON "loans"("tenantId", "id");

-- CreateIndex
CREATE INDEX "financial_transactions_tenantId_idx" ON "financial_transactions"("tenantId");

-- CreateIndex
CREATE INDEX "financial_transactions_tenantId_loanId_idx" ON "financial_transactions"("tenantId", "loanId");

-- CreateIndex
CREATE UNIQUE INDEX "financial_transactions_tenantId_id_key" ON "financial_transactions"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_transactions_tenantId_idempotencyKey_key" ON "financial_transactions"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ledger_accounts_tenantId_idx" ON "ledger_accounts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_tenantId_accountCode_key" ON "ledger_accounts"("tenantId", "accountCode");

-- CreateIndex
CREATE INDEX "journal_entries_tenantId_idx" ON "journal_entries"("tenantId");

-- CreateIndex
CREATE INDEX "journal_entries_tenantId_transactionId_idx" ON "journal_entries"("tenantId", "transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_tenantId_id_key" ON "journal_entries"("tenantId", "id");

-- CreateIndex
CREATE INDEX "custom_entity_schemas_tenantId_idx" ON "custom_entity_schemas"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_entity_schemas_tenantId_id_key" ON "custom_entity_schemas"("tenantId", "id");

-- CreateIndex
CREATE INDEX "workflow_definitions_tenantId_idx" ON "workflow_definitions"("tenantId");

-- CreateIndex
CREATE INDEX "workflow_definitions_tenantId_trigger_idx" ON "workflow_definitions"("tenantId", "trigger");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_tenantId_id_key" ON "workflow_definitions"("tenantId", "id");

-- CreateIndex
CREATE INDEX "rules_tenantId_idx" ON "rules"("tenantId");

-- CreateIndex
CREATE INDEX "rules_tenantId_productId_idx" ON "rules"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "rules_tenantId_id_key" ON "rules"("tenantId", "id");

-- CreateIndex
CREATE INDEX "audit_trail_events_tenantId_idx" ON "audit_trail_events"("tenantId");

-- CreateIndex
CREATE INDEX "audit_trail_events_tenantId_entityType_entityId_idx" ON "audit_trail_events"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "domain_outbox_events_tenantId_status_availableAt_idx" ON "domain_outbox_events"("tenantId", "status", "availableAt");

-- CreateIndex
CREATE INDEX "domain_outbox_events_tenantId_aggregateType_aggregateId_idx" ON "domain_outbox_events"("tenantId", "aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "domain_outbox_events_eventType_eventVersion_idx" ON "domain_outbox_events"("eventType", "eventVersion");

-- CreateIndex
CREATE UNIQUE INDEX "domain_outbox_events_tenantId_idempotencyKey_key" ON "domain_outbox_events"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "domain_inbox_events_tenantId_status_idx" ON "domain_inbox_events"("tenantId", "status");

-- CreateIndex
CREATE INDEX "domain_inbox_events_tenantId_eventId_idx" ON "domain_inbox_events"("tenantId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "domain_inbox_events_eventId_consumerName_key" ON "domain_inbox_events"("eventId", "consumerName");

-- CreateIndex
CREATE INDEX "read_projections_tenantId_projectionName_idx" ON "read_projections"("tenantId", "projectionName");

-- CreateIndex
CREATE INDEX "read_projections_tenantId_entityType_entityId_idx" ON "read_projections"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "read_projections_lastEventType_lastEventVersion_idx" ON "read_projections"("lastEventType", "lastEventVersion");

-- CreateIndex
CREATE UNIQUE INDEX "read_projections_tenantId_projectionName_entityId_key" ON "read_projections"("tenantId", "projectionName", "entityId");

-- CreateIndex
CREATE INDEX "projection_checkpoints_tenantId_idx" ON "projection_checkpoints"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "projection_checkpoints_tenantId_projectionName_key" ON "projection_checkpoints"("tenantId", "projectionName");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_configs" ADD CONSTRAINT "tenant_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_entity_schemas" ADD CONSTRAINT "custom_entity_schemas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rules" ADD CONSTRAINT "rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_trail_events" ADD CONSTRAINT "audit_trail_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_outbox_events" ADD CONSTRAINT "domain_outbox_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_inbox_events" ADD CONSTRAINT "domain_inbox_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "read_projections" ADD CONSTRAINT "read_projections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projection_checkpoints" ADD CONSTRAINT "projection_checkpoints_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
