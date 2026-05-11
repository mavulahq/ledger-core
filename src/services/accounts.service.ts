/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2026 getfluxo.io
 * License: PROPRIETARY
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

    return this.prisma.account.findMany({ where: { tenantId } });
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

    return this.prisma.account.create({
      data: { tenantId, name: data.name || 'Unnamed', balance: data.balance || 0 },
    });
  }
}
