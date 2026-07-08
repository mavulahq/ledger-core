/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2026 getfluxo.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Injectable()
export class AccountsService {
  private readonly memoryAccounts = new Map<string, Array<{ id: string; tenantId: string; name: string; balance: number }>>();

  constructor(private prisma: PrismaService) {}

  async listAccounts(tenantId: string) {
    if (!this.prisma.isConfigured) {
      return this.memoryAccounts.get(tenantId) || [];
    }

    await this.prisma.ensureTenant(tenantId);
    await this.prisma.setTenantContext(tenantId);
    return this.prisma.db.$queryRaw`
      SELECT "id", "tenantId", "name", "balance", "createdAt"
      FROM "accounts"
      WHERE "tenantId" = ${tenantId}
      ORDER BY "createdAt" ASC
    `;
  }

  async createAccount(tenantId: string, data: any) {
    if (!this.prisma.isConfigured) {
      const account = {
        id: `acct_${Date.now()}`,
        tenantId,
        name: data.name || 'Unnamed',
        balance: data.balance || 0,
      };
      const existing = this.memoryAccounts.get(tenantId) || [];
      existing.push(account);
      this.memoryAccounts.set(tenantId, existing);
      return account;
    }

    await this.prisma.ensureTenant(tenantId);
    await this.prisma.setTenantContext(tenantId);
    const id = `acct_${Date.now()}`;
    const [account] = await this.prisma.db.$queryRaw<any[]>`
      INSERT INTO "accounts" ("id", "tenantId", "name", "balance")
      VALUES (${id}, ${tenantId}, ${data.name || 'Unnamed'}, ${data.balance || 0})
      RETURNING "id", "tenantId", "name", "balance", "createdAt"
    `;
    return account;
  }
}
