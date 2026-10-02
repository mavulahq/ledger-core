/*
 * mavula.io - Core Finance Engine
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { AccountsController } from './controllers/accounts.controller';
import { AccountLifecycleController } from './controllers/account-lifecycle.controller';
import { FinancialAdjustmentsController } from './controllers/financial-adjustments.controller';
import { FinancialAdjustmentsService } from './adjustments/financial-adjustments.service';
import { ProductsController } from './controllers/products.controller';
import { ProjectionsController } from './controllers/projections.controller';
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
import { ReadProjectionService } from './read-models/read-projection.service';
import { RulesEngineService } from './rules-engine/rules-engine.service';
import { SchemaManagerService } from './schema-manager/schema-manager.service';
import { TransactionService } from './transactions/transaction.service';
import { EngineEventService } from './worker/engine-event.service';
import { AccessTokenGuard } from './auth/access-token.guard';
import { TenantBoundaryGuard } from './auth/tenant-boundary.guard';
import { PermissionsGuard } from './auth/permissions.guard';
import { WorkerQueueService } from './worker/worker-queue.service';
import { IdempotencyService } from './idempotency/idempotency.service';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { HttpMetricsInterceptor } from './metrics/http-metrics.interceptor';
import { RegulatoryExportSourceService } from './regulatory/regulatory-export-source.service';
import { MetricsTokenGuard } from './auth/metrics-token.guard';

@Module({
  imports: [AuthModule],
  controllers: [
    AppController,
    AccountsController,
    AccountLifecycleController,
    FinancialAdjustmentsController,
    ProductsController,
    ProjectionsController,
    RulesController,
    SchemasController,
    WorkflowsController,
    MetricsController,
    InternalWorkerController,
  ],
  providers: [
    AppService,
    AccountsService,
    FinancialAdjustmentsService,
    PrismaService,
    MetricsService,
    FengineStoreService,
    AuditTrailService,
    ProductConfigService,
    ReadProjectionService,
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
    RegulatoryExportSourceService,
    IdempotencyService,
    MetricsTokenGuard,
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: APP_GUARD, useClass: TenantBoundaryGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
