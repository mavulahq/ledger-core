/*
 * mavula.io - Core Finance Engine
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuthenticatedTenantReference {
  tenantId: string;
  institutionId: string;
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly client?: PrismaClient;
  private readonly pendingTransactions = new Set<Promise<unknown>>();
  private readonly transactionContext = new AsyncLocalStorage<{
    tenantId: string;
    tx: Prisma.TransactionClient;
    pending: Set<Promise<unknown>>;
  }>();

  constructor() {
    if (process.env.DATABASE_URL) {
      this.client = new PrismaClient();
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.client);
  }

  async bindTenantReference(reference: AuthenticatedTenantReference): Promise<void> {
    if (!this.client) {
      return;
    }

    const bound = await this.withTenant(reference.tenantId, async (tx) => {
      return tx.$queryRaw<Array<{ institutionId: string }>>`
        INSERT INTO "tenants" ("id", "institutionId", "updatedAt")
        VALUES (${reference.tenantId}, ${reference.institutionId}, now())
        ON CONFLICT ("id") DO UPDATE SET
          "institutionId" = COALESCE("tenants"."institutionId", EXCLUDED."institutionId"),
          "updatedAt" = now()
        WHERE "tenants"."institutionId" IS NULL
           OR "tenants"."institutionId" = EXCLUDED."institutionId"
        RETURNING "institutionId"
      `;
    });

    if (bound[0]?.institutionId !== reference.institutionId) {
      throw new Error('Authenticated tenant and institution do not match the financial tenant reference');
    }
  }

  async withTenant<T>(
    tenantId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const active = this.transactionContext.getStore();
    if (active) {
      if (active.tenantId !== tenantId) {
        throw new Error('A tenant transaction cannot be reused across tenant boundaries');
      }
      return operation(active.tx);
    }

    if (!this.client) {
      throw new Error('Prisma client not configured');
    }

    const transaction = this.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return this.transactionContext.run({ tenantId, tx, pending: new Set() }, async () => {
        const result = await operation(tx);
        const context = this.transactionContext.getStore();
        if (context && context.pending.size > 0) {
          await Promise.all(context.pending);
        }
        return result;
      });
    });
    this.pendingTransactions.add(transaction);
    try {
      return await transaction;
    } finally {
      this.pendingTransactions.delete(transaction);
    }
  }

  trackTenantOperation(operation: Promise<unknown>): boolean {
    const active = this.transactionContext.getStore();
    if (!active) return false;
    active.pending.add(operation);
    return true;
  }

  async pendingOutboxTenantIds(limit: number): Promise<string[]> {
    if (!this.client) {
      return [];
    }
    const rows = await this.client.$queryRaw<Array<{ tenantId: string }>>`
      SELECT "tenantId" FROM public.pending_domain_outbox_tenants(${limit})
    `;
    return rows.map((row) => row.tenantId);
  }

  async globalOutboxStatus(): Promise<Array<{ status: string; count: bigint }>> {
    if (!this.client) {
      return [];
    }
    return this.client.$queryRaw<Array<{ status: string; count: bigint }>>`
      SELECT "status", "count" FROM public.domain_outbox_status_totals()
    `;
  }

  async cleanupExpiredIdempotencyReceipts(limit: number): Promise<number> {
    if (!this.client) {
      return 0;
    }
    const [result] = await this.client.$queryRaw<Array<{ deleted: number }>>`
      SELECT public.cleanup_expired_idempotency_receipts(${limit}) AS deleted
    `;
    return Number(result?.deleted || 0);
  }

  async globalIdempotencyReceiptStatus(): Promise<{ active: number; expired: number }> {
    if (!this.client) {
      return { active: 0, expired: 0 };
    }
    const [result] = await this.client.$queryRaw<Array<{ active: bigint; expired: bigint }>>`
      SELECT active, expired FROM public.idempotency_receipt_status_totals()
    `;
    return {
      active: Number(result?.active || 0),
      expired: Number(result?.expired || 0),
    };
  }

  async onModuleInit() {
    if (!this.client) {
      return;
    }

    await this.client.$connect();
  }

  async onModuleDestroy() {
    if (!this.client) {
      return;
    }

    while (this.pendingTransactions.size > 0) {
      await Promise.allSettled([...this.pendingTransactions]);
    }

    await this.client.$disconnect();
  }
}
