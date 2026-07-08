/*
 * mavula.io - Core Finance Engine
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

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

  get account() {
    if (!this.client) {
      throw new Error('Prisma client not configured');
    }

    return this.client.account;
  }

  get db(): any {
    if (!this.client) {
      throw new Error('Prisma client not configured');
    }

    return this.client;
  }

  async ensureTenant(tenantId: string, data?: { name?: string; jurisdiction?: string }) {
    if (!this.client) {
      return;
    }

    await this.client.$executeRaw`
      INSERT INTO "tenants" ("id", "name", "jurisdiction", "updatedAt")
      VALUES (${tenantId}, ${data?.name || null}, ${data?.jurisdiction || null}, now())
      ON CONFLICT ("id") DO UPDATE SET
        "name" = COALESCE(EXCLUDED."name", "tenants"."name"),
        "jurisdiction" = COALESCE(EXCLUDED."jurisdiction", "tenants"."jurisdiction"),
        "updatedAt" = now()
    `;
  }

  async setTenantContext(tenantId: string): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.client.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, false)`;
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
