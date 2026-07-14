/*
 * mavula.io - Core Finance Engine
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export interface AuthenticatedTenantReference {
  tenantId: string;
  institutionId: string;
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly client?: PrismaClient;

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
    if (!this.client) {
      throw new Error('Prisma client not configured');
    }

    return this.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return operation(tx);
    });
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

    await this.client.$disconnect();
  }
}
