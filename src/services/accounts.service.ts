/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2026 getfluxo.io
 * License: PROPRIETARY
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Injectable()
export class AccountsService {
  constructor(private prisma: PrismaService) {}

  async listAccounts(tenantId: string) {
    // Prisma schema uses tenantId column - in production consider schema-per-tenant
    return this.prisma.account.findMany({ where: { tenantId } });
  }

  async createAccount(tenantId: string, data: any) {
    return this.prisma.account.create({
      data: { tenantId, name: data.name || 'Unnamed', balance: data.balance || 0 },
    });
  }
}
