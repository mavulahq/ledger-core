/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2026 getfluxo.io
 * License: PROPRIETARY
 */

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AccountsController } from './controllers/accounts.controller';
import { ProductsController } from './controllers/products.controller';
import { RulesController } from './controllers/rules.controller';
import { SchemasController } from './controllers/schemas.controller';
import { WorkflowsController } from './controllers/workflows.controller';
import { InternalWorkerController } from './controllers/internal-worker.controller';
import { DomainEventFactory } from './domain-events/domain-event-factory.service';
import { DomainInboxService } from './domain-events/domain-inbox.service';
import { DomainOutboxPublisherService } from './domain-events/domain-outbox-publisher.service';
import { DomainOutboxService } from './domain-events/domain-outbox.service';
import { AccountsService } from './services/accounts.service';
import { PrismaService } from './services/prisma.service';
import { MetricsService } from './metrics/metrics.service';
import { MetricsController } from './metrics/metrics.controller';
import { AuditTrailService } from './services/audit-trail.service';
import { FengineStoreService } from './services/fengine-store.service';
import { LedgerService } from './ledger/ledger.service';
import { LoanService } from './loans/loan.service';
import { ProductConfigService } from './products/product-config.service';
import { RulesEngineService } from './rules-engine/rules-engine.service';
import { SchemaManagerService } from './schema-manager/schema-manager.service';
import { TransactionService } from './transactions/transaction.service';
import { EngineEventService } from './worker/engine-event.service';
import { InternalApiKeyGuard } from './worker/internal-api-key.guard';
import { WorkerQueueService } from './worker/worker-queue.service';

@Module({
  imports: [AuthModule],
  controllers: [
    AppController,
    AccountsController,
    ProductsController,
    RulesController,
    SchemasController,
    WorkflowsController,
    MetricsController,
    InternalWorkerController,
  ],
  providers: [
    AppService,
    AccountsService,
    PrismaService,
    MetricsService,
    FengineStoreService,
    AuditTrailService,
    ProductConfigService,
    RulesEngineService,
    LedgerService,
    TransactionService,
    LoanService,
    SchemaManagerService,
    WorkerQueueService,
    EngineEventService,
    DomainEventFactory,
    DomainOutboxService,
    DomainInboxService,
    DomainOutboxPublisherService,
    InternalApiKeyGuard,
  ],
})
export class AppModule {}
