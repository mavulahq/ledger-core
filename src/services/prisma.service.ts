/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2026 getfluxo.io
 * License: PROPRIETARY
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
