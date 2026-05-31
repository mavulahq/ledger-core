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

@Module({
  imports: [AuthModule],
  controllers: [AppController, AccountsController, MetricsController],
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
  ],
})
export class AppModule {}
