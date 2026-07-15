/*
 * mavula.io - Controlled Account Lifecycle
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { randomUUID } from 'node:crypto';
import {
  AccountEntryRecord,
  AccountLifecycleListQuery,
  AccountLifecycleRequestRecord,
  AccountLifecycleRequestStatus,
  AccountLifecycleTransition,
  AccountPostingInput,
  AccountRecord,
  AccountStatementQuery,
  AccountStatus,
  OperatorContext,
  TenantTransaction,
} from '../accounts/account.types';
import { ProductType } from '../products/product-config.service';
import { AuditTrailService } from './audit-trail.service';
import { FengineStoreService } from './fengine-store.service';
import { PrismaService } from './prisma.service';

interface CreateAccountInput {
  customer_id: string;
  product_id: string;
  name: string;
  currency: string;
}

interface LifecycleDecisionResult {
  request: AccountLifecycleRequestRecord;
  conflict?: string;
}

@Injectable()
export class AccountsService {
  private readonly memoryAccounts = new Map<string, Map<string, AccountRecord>>();
  private readonly memoryEntries = new Map<string, Map<string, AccountEntryRecord[]>>();
  private readonly memoryLifecycle = new Map<string, Map<string, AccountLifecycleRequestRecord>>();
  private readonly memoryLifecycleLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: FengineStoreService,
    private readonly auditTrail: AuditTrailService,
  ) {}

  async listAccounts(tenantId: string): Promise<AccountRecord[]> {
    if (!this.prisma.isConfigured) {
      return [...(this.memoryAccounts.get(tenantId)?.values() || [])]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }

    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<any[]>`
      SELECT * FROM "accounts"
      WHERE "tenantId" = ${tenantId}
      ORDER BY "createdAt" ASC, id ASC
    `);
    return rows.map((row) => this.accountFromRow(row));
  }

  async getAccount(tenantId: string, accountId: string): Promise<AccountRecord> {
    if (!this.prisma.isConfigured) {
      const account = this.memoryAccounts.get(tenantId)?.get(accountId);
      if (!account) throw new NotFoundException(`Account not found: ${accountId}`);
      return account;
    }

    const account = await this.prisma.withTenant(tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<any[]>`
        SELECT * FROM "accounts"
        WHERE "tenantId" = ${tenantId} AND id = ${accountId}
        LIMIT 1
      `;
      return row ? this.accountFromRow(row) : undefined;
    });
    if (!account) throw new NotFoundException(`Account not found: ${accountId}`);
    return account;
  }

  async getBalance(tenantId: string, accountId: string) {
    const account = await this.getAccount(tenantId, accountId);
    return {
      account_id: account.id,
      currency: account.currency,
      balance: account.balance,
      as_of: new Date().toISOString(),
    };
  }

  async createAccount(
    tenantId: string,
    input: CreateAccountInput,
    actor: OperatorContext,
  ): Promise<AccountRecord> {
    const currency = input.currency.toUpperCase();
    if (!this.prisma.isConfigured) {
      await this.assertMemoryProduct(tenantId, input.product_id, currency);
      const now = new Date();
      const account: AccountRecord = {
        id: `acct_${randomUUID()}`,
        tenantId,
        customerId: input.customer_id,
        productId: input.product_id,
        name: input.name,
        currency,
        status: 'ACTIVE',
        balance: '0.00',
        version: 1,
        createdBy: actor.subject,
        createdAt: now,
        updatedAt: now,
      };
      const accounts = this.memoryAccounts.get(tenantId) || new Map<string, AccountRecord>();
      accounts.set(account.id, account);
      this.memoryAccounts.set(tenantId, accounts);
      this.auditTrail.record(this.auditEvent(
        account.tenantId, 'account.created', 'account', account.id, actor, 'CONFIGURED', 'SUCCEEDED', {
        customer_id: account.customerId,
        product_id: account.productId,
      }));
      return account;
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertConfiguredProduct(tx, tenantId, input.product_id, currency);
      const id = `acct_${randomUUID()}`;
      const [row] = await tx.$queryRaw<any[]>`
        INSERT INTO "accounts" (
          id, "tenantId", "customerId", "productId", name, currency,
          status, balance, version, "createdBy", "updatedAt"
        )
        VALUES (
          ${id}, ${tenantId}, ${input.customer_id}, ${input.product_id}, ${input.name},
          ${currency}, 'ACTIVE', 0, 1, ${actor.subject}, now()
        )
        RETURNING *
      `;
      await this.auditTrail.recordInTransaction(
        tx,
        this.auditEvent(tenantId, 'account.created', 'account', id, actor, 'CONFIGURED', 'SUCCEEDED', {
          customer_id: input.customer_id,
          product_id: input.product_id,
        }),
      );
      return this.accountFromRow(row);
    });
  }

  async statement(tenantId: string, accountId: string, query: AccountStatementQuery) {
    if (query.from && query.to && query.from > query.to) {
      throw new BadRequestException('Statement from must be before to');
    }
    const account = await this.getAccount(tenantId, accountId);
    if (!this.prisma.isConfigured) {
      const cursor = this.decodeCursor(query.cursor);
      const entries = [...(this.memoryEntries.get(tenantId)?.get(accountId) || [])]
        .filter((entry) => !query.from || entry.postedAt >= query.from)
        .filter((entry) => !query.to || entry.postedAt <= query.to)
        .filter((entry) => !cursor || this.beforeCursor(entry.postedAt, entry.id, cursor))
        .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime() || b.id.localeCompare(a.id))
        .slice(0, query.limit + 1);
      return this.statementResponse(account, entries, query.limit);
    }

    const cursor = this.decodeCursor(query.cursor);
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<any[]>(Prisma.sql`
      SELECT * FROM "account_entries"
      WHERE "tenantId" = ${tenantId}
        AND "accountId" = ${accountId}
        ${query.from ? Prisma.sql`AND "postedAt" >= ${query.from}` : Prisma.empty}
        ${query.to ? Prisma.sql`AND "postedAt" <= ${query.to}` : Prisma.empty}
        ${cursor ? Prisma.sql`AND ("postedAt", id) < (${cursor.at}, ${cursor.id})` : Prisma.empty}
      ORDER BY "postedAt" DESC, id DESC
      LIMIT ${query.limit + 1}
    `));
    return this.statementResponse(account, rows.map((row) => this.entryFromRow(row)), query.limit);
  }

  async listEntriesByJournal(tenantId: string, journalEntryId: string): Promise<AccountEntryRecord[]> {
    if (!this.prisma.isConfigured) {
      return [...(this.memoryEntries.get(tenantId)?.values() || [])]
        .flat()
        .filter((entry) => entry.journalEntryId === journalEntryId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    }
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<any[]>`
      SELECT * FROM "account_entries"
      WHERE "tenantId" = ${tenantId} AND "journalEntryId" = ${journalEntryId}
      ORDER BY "createdAt" ASC, id ASC
    `);
    return rows.map((row) => this.entryFromRow(row));
  }

  async submitLifecycleRequest(
    tenantId: string,
    accountId: string,
    transition: AccountLifecycleTransition,
    reason: string,
    actor: OperatorContext,
  ): Promise<AccountLifecycleRequestRecord> {
    if (!this.prisma.isConfigured) {
      const account = await this.getAccount(tenantId, accountId);
      this.assertTransition(account.status, transition);
      const requests = this.memoryLifecycle.get(tenantId) || new Map<string, AccountLifecycleRequestRecord>();
      if ([...requests.values()].some((request) => request.accountId === accountId && request.status === 'PENDING_APPROVAL')) {
        throw new ConflictException('Account already has a pending lifecycle request');
      }
      const now = new Date();
      const request: AccountLifecycleRequestRecord = {
        id: `alr_${randomUUID()}`,
        tenantId,
        accountId,
        transition,
        fromStatus: account.status,
        targetStatus: this.targetStatus(transition),
        expectedAccountVersion: account.version,
        status: 'PENDING_APPROVAL',
        reason,
        requestedBy: actor.subject,
        requestedRoles: [...actor.roles],
        institutionId: actor.institutionId,
        branchId: actor.branchId,
        correlationId: actor.correlationId,
        createdAt: now,
        updatedAt: now,
      };
      requests.set(request.id, request);
      this.memoryLifecycle.set(tenantId, requests);
      this.auditTrail.record(this.lifecycleAudit(request, actor, 'account.lifecycle.requested', 'PENDING_APPROVAL'));
      return request;
    }

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const [accountRow] = await tx.$queryRaw<any[]>`
          SELECT * FROM "accounts"
          WHERE "tenantId" = ${tenantId} AND id = ${accountId}
          FOR UPDATE
        `;
        if (!accountRow) throw new NotFoundException(`Account not found: ${accountId}`);
        const account = this.accountFromRow(accountRow);
        this.assertTransition(account.status, transition);
        const id = `alr_${randomUUID()}`;
        const targetStatus = this.targetStatus(transition);
        const [row] = await tx.$queryRaw<any[]>`
          INSERT INTO "account_lifecycle_requests" (
            id, "tenantId", "accountId", transition, "fromStatus", "targetStatus",
            "expectedAccountVersion", status, reason, "requestedBy", "requestedRoles",
            "institutionId", "branchId", "correlationId", "updatedAt"
          )
          VALUES (
            ${id}, ${tenantId}, ${accountId}, ${transition}, ${account.status}, ${targetStatus},
            ${account.version}, 'PENDING_APPROVAL', ${reason}, ${actor.subject},
            CAST(${JSON.stringify(actor.roles)} AS jsonb), ${actor.institutionId},
            ${actor.branchId || null}, ${actor.correlationId}, now()
          )
          RETURNING *
        `;
        const request = this.lifecycleFromRow(row);
        await this.auditTrail.recordInTransaction(
          tx,
          this.lifecycleAudit(request, actor, 'account.lifecycle.requested', 'PENDING_APPROVAL'),
        );
        return request;
      });
    } catch (error) {
      if (
        (error as any)?.code === 'P2002' ||
        (error as any)?.code === '23505' ||
        (error as any)?.meta?.code === '23505'
      ) {
        throw new ConflictException('Account already has a pending lifecycle request');
      }
      throw error;
    }
  }

  async listLifecycleRequests(tenantId: string, query: AccountLifecycleListQuery) {
    if (!this.prisma.isConfigured) {
      const cursor = this.decodeCursor(query.cursor);
      const rows = [...(this.memoryLifecycle.get(tenantId)?.values() || [])]
        .filter((request) => !query.accountId || request.accountId === query.accountId)
        .filter((request) => !query.status || request.status === query.status)
        .filter((request) => !cursor || this.beforeCursor(request.createdAt, request.id, cursor))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .slice(0, query.limit + 1);
      return this.page(rows, query.limit);
    }

    const cursor = this.decodeCursor(query.cursor);
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<any[]>(Prisma.sql`
      SELECT * FROM "account_lifecycle_requests"
      WHERE "tenantId" = ${tenantId}
        ${query.accountId ? Prisma.sql`AND "accountId" = ${query.accountId}` : Prisma.empty}
        ${query.status ? Prisma.sql`AND status = ${query.status}` : Prisma.empty}
        ${cursor ? Prisma.sql`AND ("createdAt", id) < (${cursor.at}, ${cursor.id})` : Prisma.empty}
      ORDER BY "createdAt" DESC, id DESC
      LIMIT ${query.limit + 1}
    `));
    return this.page(rows.map((row) => this.lifecycleFromRow(row)), query.limit);
  }

  async getLifecycleRequest(tenantId: string, requestId: string): Promise<AccountLifecycleRequestRecord> {
    if (!this.prisma.isConfigured) {
      const request = this.memoryLifecycle.get(tenantId)?.get(requestId);
      if (!request) throw new NotFoundException(`Account lifecycle request not found: ${requestId}`);
      return request;
    }
    const request = await this.prisma.withTenant(tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<any[]>`
        SELECT * FROM "account_lifecycle_requests"
        WHERE "tenantId" = ${tenantId} AND id = ${requestId}
        LIMIT 1
      `;
      return row ? this.lifecycleFromRow(row) : undefined;
    });
    if (!request) throw new NotFoundException(`Account lifecycle request not found: ${requestId}`);
    return request;
  }

  approveLifecycleRequest(
    tenantId: string,
    requestId: string,
    decisionReason: string | undefined,
    actor: OperatorContext,
  ): Promise<AccountLifecycleRequestRecord> {
    return this.decideLifecycleRequest(tenantId, requestId, 'APPROVE', decisionReason, actor);
  }

  rejectLifecycleRequest(
    tenantId: string,
    requestId: string,
    decisionReason: string,
    actor: OperatorContext,
  ): Promise<AccountLifecycleRequestRecord> {
    return this.decideLifecycleRequest(tenantId, requestId, 'REJECT', decisionReason, actor);
  }

  async assertMemoryPostingsAllowed(
    tenantId: string,
    postings: AccountPostingInput[],
    journalEntryId?: string,
  ): Promise<void> {
    for (const [index, posting] of postings.entries()) {
      const account = await this.getAccount(tenantId, posting.accountId);
      this.validatePosting(account, posting);
      const postingKey = posting.postingKey || `${journalEntryId}:${index}:${posting.accountId}`;
      const existing = [...(this.memoryEntries.get(tenantId)?.values() || [])]
        .flat()
        .find((entry) => entry.postingKey === postingKey);
      if (existing) this.assertEntryReplay(existing, posting, journalEntryId);
    }
  }

  async appendMemoryPostings(
    tenantId: string,
    journalEntryId: string,
    transactionId: string,
    postedBy: string,
    postedAt: Date,
    postings: AccountPostingInput[],
  ): Promise<AccountEntryRecord[]> {
    await this.assertMemoryPostingsAllowed(tenantId, postings, journalEntryId);
    const created: AccountEntryRecord[] = [];
    for (const [index, posting] of postings.entries()) {
      const postingKey = posting.postingKey || `${journalEntryId}:${index}:${posting.accountId}`;
      const tenantEntries = this.memoryEntries.get(tenantId) || new Map<string, AccountEntryRecord[]>();
      const accountEntries = tenantEntries.get(posting.accountId) || [];
      const replay = accountEntries.find((entry) => entry.postingKey === postingKey);
      if (replay) {
        this.assertEntryReplay(replay, posting, journalEntryId);
        created.push(replay);
        continue;
      }
      const account = await this.getAccount(tenantId, posting.accountId);
      const amount = this.amount(posting.amount);
      const balance = new Decimal(account.balance)
        .plus(posting.direction === 'CREDIT' ? amount : amount.negated())
        .toFixed(2);
      const now = new Date();
      const entry: AccountEntryRecord = {
        id: `ae_${randomUUID()}`,
        tenantId,
        accountId: posting.accountId,
        journalEntryId,
        transactionId: posting.transactionId || transactionId,
        postingKey,
        entryType: posting.entryType || 'POSTING',
        direction: posting.direction,
        amount: amount.toFixed(2),
        currency: posting.currency,
        balanceAfter: balance,
        reference: posting.reference,
        createdBy: postedBy,
        postedAt,
        createdAt: now,
      };
      account.balance = balance;
      account.version += 1;
      account.updatedAt = now;
      accountEntries.push(entry);
      tenantEntries.set(posting.accountId, accountEntries);
      this.memoryEntries.set(tenantId, tenantEntries);
      created.push(entry);
    }
    return created;
  }

  async appendPostingsInTransaction(
    tx: TenantTransaction,
    tenantId: string,
    journalEntryId: string,
    transactionId: string,
    postedBy: string,
    postedAt: Date,
    postings: AccountPostingInput[],
  ): Promise<AccountEntryRecord[]> {
    const created: AccountEntryRecord[] = [];
    for (const [index, posting] of postings.entries()) {
      const postingKey = posting.postingKey || `${journalEntryId}:${index}:${posting.accountId}`;
      const [existing] = await tx.$queryRaw<any[]>`
        SELECT * FROM "account_entries"
        WHERE "tenantId" = ${tenantId} AND "postingKey" = ${postingKey}
        LIMIT 1
      `;
      if (existing) {
        const replay = this.entryFromRow(existing);
        this.assertEntryReplay(replay, posting, journalEntryId);
        created.push(replay);
        continue;
      }
      const [accountRow] = await tx.$queryRaw<any[]>`
        SELECT * FROM "accounts"
        WHERE "tenantId" = ${tenantId} AND id = ${posting.accountId}
        FOR UPDATE
      `;
      if (!accountRow) throw new NotFoundException(`Account not found: ${posting.accountId}`);
      const account = this.accountFromRow(accountRow);
      this.validatePosting(account, posting);
      const amount = this.amount(posting.amount);
      const balance = new Decimal(account.balance)
        .plus(posting.direction === 'CREDIT' ? amount : amount.negated())
        .toFixed(2);
      const id = `ae_${randomUUID()}`;
      const [row] = await tx.$queryRaw<any[]>`
        INSERT INTO "account_entries" (
          id, "tenantId", "accountId", "journalEntryId", "transactionId", "postingKey",
          "entryType", direction, amount, currency, "balanceAfter", reference,
          "createdBy", "postedAt"
        )
        VALUES (
          ${id}, ${tenantId}, ${posting.accountId}, ${journalEntryId},
          ${posting.transactionId || transactionId}, ${postingKey}, ${posting.entryType || 'POSTING'},
          ${posting.direction}, CAST(${amount.toFixed(2)} AS numeric), ${posting.currency},
          CAST(${balance} AS numeric),
          ${posting.reference || null}, ${postedBy}, ${postedAt}
        )
        RETURNING *
      `;
      await tx.$executeRaw`
        UPDATE "accounts"
        SET balance = CAST(${balance} AS numeric), version = version + 1, "updatedAt" = now()
        WHERE "tenantId" = ${tenantId} AND id = ${posting.accountId}
      `;
      created.push(this.entryFromRow(row));
    }
    return created;
  }

  private async decideLifecycleRequest(
    tenantId: string,
    requestId: string,
    decision: 'APPROVE' | 'REJECT',
    decisionReason: string | undefined,
    actor: OperatorContext,
  ): Promise<AccountLifecycleRequestRecord> {
    if (!this.prisma.isConfigured) {
      return this.withMemoryLifecycleLock(
        `${tenantId}:${requestId}`,
        () => this.decideMemoryLifecycle(tenantId, requestId, decision, decisionReason, actor),
      );
    }

    const result = await this.prisma.withTenant(tenantId, async (tx): Promise<LifecycleDecisionResult> => {
      const [requestRow] = await tx.$queryRaw<any[]>`
        SELECT * FROM "account_lifecycle_requests"
        WHERE "tenantId" = ${tenantId} AND id = ${requestId}
        FOR UPDATE
      `;
      if (!requestRow) throw new NotFoundException(`Account lifecycle request not found: ${requestId}`);
      const request = this.lifecycleFromRow(requestRow);
      this.assertChecker(request, actor);
      const replay = this.terminalReplay(request, decision);
      if (replay) return { request: replay };

      if (decision === 'REJECT') {
        const [row] = await tx.$queryRaw<any[]>`
          UPDATE "account_lifecycle_requests"
          SET status = 'REJECTED', "decidedBy" = ${actor.subject},
              "decisionReason" = ${decisionReason || null}, "decidedAt" = now(), "updatedAt" = now()
          WHERE "tenantId" = ${tenantId} AND id = ${requestId}
          RETURNING *
        `;
        const rejected = this.lifecycleFromRow(row);
        await this.auditTrail.recordInTransaction(
          tx,
          this.lifecycleAudit(rejected, actor, 'account.lifecycle.rejected', 'REJECTED'),
        );
        return { request: rejected };
      }

      const [accountRow] = await tx.$queryRaw<any[]>`
        SELECT * FROM "accounts"
        WHERE "tenantId" = ${tenantId} AND id = ${request.accountId}
        FOR UPDATE
      `;
      if (!accountRow) {
        return this.failLifecycleInTransaction(tx, request, actor, 'Account no longer exists');
      }
      const account = this.accountFromRow(accountRow);
      if (account.status !== request.fromStatus || account.version !== request.expectedAccountVersion) {
        return this.failLifecycleInTransaction(tx, request, actor, 'Account state changed after the request');
      }
      if (request.transition === 'CLOSE' && !new Decimal(account.balance).isZero()) {
        return this.failLifecycleInTransaction(tx, request, actor, 'Account balance must be zero before close');
      }

      await this.applyAccountTransition(tx, tenantId, account.id, request, actor);
      const [row] = await tx.$queryRaw<any[]>`
        UPDATE "account_lifecycle_requests"
        SET status = 'APPLIED', "decidedBy" = ${actor.subject},
            "decisionReason" = ${decisionReason || null}, "decidedAt" = now(),
            "appliedAt" = now(), "updatedAt" = now()
        WHERE "tenantId" = ${tenantId} AND id = ${requestId}
        RETURNING *
      `;
      const applied = this.lifecycleFromRow(row);
      await this.auditTrail.recordInTransaction(
        tx,
        this.lifecycleAudit(applied, actor, 'account.lifecycle.applied', 'APPLIED'),
      );
      return { request: applied };
    });

    if (result.conflict) throw new ConflictException(result.conflict);
    return result.request;
  }

  private async decideMemoryLifecycle(
    tenantId: string,
    requestId: string,
    decision: 'APPROVE' | 'REJECT',
    decisionReason: string | undefined,
    actor: OperatorContext,
  ): Promise<AccountLifecycleRequestRecord> {
    const request = await this.getLifecycleRequest(tenantId, requestId);
    this.assertChecker(request, actor);
    const replay = this.terminalReplay(request, decision);
    if (replay) return replay;
    const now = new Date();
    request.decidedBy = actor.subject;
    request.decisionReason = decisionReason;
    request.decidedAt = now;
    request.updatedAt = now;
    if (decision === 'REJECT') {
      request.status = 'REJECTED';
      this.auditTrail.record(this.lifecycleAudit(request, actor, 'account.lifecycle.rejected', 'REJECTED'));
      return request;
    }
    const account = await this.getAccount(tenantId, request.accountId);
    if (account.status !== request.fromStatus || account.version !== request.expectedAccountVersion) {
      request.status = 'FAILED';
      request.failureReason = 'Account state changed after the request';
      this.auditTrail.record(this.lifecycleAudit(request, actor, 'account.lifecycle.failed', 'FAILED'));
      throw new ConflictException(request.failureReason);
    }
    if (request.transition === 'CLOSE' && !new Decimal(account.balance).isZero()) {
      request.status = 'FAILED';
      request.failureReason = 'Account balance must be zero before close';
      this.auditTrail.record(this.lifecycleAudit(request, actor, 'account.lifecycle.failed', 'FAILED'));
      throw new ConflictException(request.failureReason);
    }
    this.applyMemoryTransition(account, request, actor, now);
    request.status = 'APPLIED';
    request.appliedAt = now;
    this.auditTrail.record(this.lifecycleAudit(request, actor, 'account.lifecycle.applied', 'APPLIED'));
    return request;
  }

  private async withMemoryLifecycleLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.memoryLifecycleLocks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.memoryLifecycleLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.memoryLifecycleLocks.get(key) === queued) {
        this.memoryLifecycleLocks.delete(key);
      }
    }
  }

  private async failLifecycleInTransaction(
    tx: TenantTransaction,
    request: AccountLifecycleRequestRecord,
    actor: OperatorContext,
    failureReason: string,
  ): Promise<LifecycleDecisionResult> {
    const [row] = await tx.$queryRaw<any[]>`
      UPDATE "account_lifecycle_requests"
      SET status = 'FAILED', "decidedBy" = ${actor.subject}, "decidedAt" = now(),
          "failureReason" = ${failureReason}, "updatedAt" = now()
      WHERE "tenantId" = ${request.tenantId} AND id = ${request.id}
      RETURNING *
    `;
    const failed = this.lifecycleFromRow(row);
    await this.auditTrail.recordInTransaction(
      tx,
      this.lifecycleAudit(failed, actor, 'account.lifecycle.failed', 'FAILED'),
    );
    return { request: failed, conflict: failureReason };
  }

  private async applyAccountTransition(
    tx: TenantTransaction,
    tenantId: string,
    accountId: string,
    request: AccountLifecycleRequestRecord,
    actor: OperatorContext,
  ): Promise<void> {
    if (request.transition === 'FREEZE') {
      await tx.$executeRaw`
        UPDATE "accounts"
        SET status = 'FROZEN', version = version + 1, "frozenAt" = now(),
            "frozenBy" = ${actor.subject}, "freezeReason" = ${request.reason}, "updatedAt" = now()
        WHERE "tenantId" = ${tenantId} AND id = ${accountId}
      `;
      return;
    }
    if (request.transition === 'UNFREEZE') {
      await tx.$executeRaw`
        UPDATE "accounts"
        SET status = 'ACTIVE', version = version + 1, "frozenAt" = NULL,
            "frozenBy" = NULL, "freezeReason" = NULL, "updatedAt" = now()
        WHERE "tenantId" = ${tenantId} AND id = ${accountId}
      `;
      return;
    }
    await tx.$executeRaw`
      UPDATE "accounts"
      SET status = 'CLOSED', version = version + 1, "closedAt" = now(),
          "closedBy" = ${actor.subject}, "closeReason" = ${request.reason}, "updatedAt" = now()
      WHERE "tenantId" = ${tenantId} AND id = ${accountId}
    `;
  }

  private applyMemoryTransition(
    account: AccountRecord,
    request: AccountLifecycleRequestRecord,
    actor: OperatorContext,
    now: Date,
  ): void {
    account.status = request.targetStatus;
    account.version += 1;
    account.updatedAt = now;
    if (request.transition === 'FREEZE') {
      account.frozenAt = now;
      account.frozenBy = actor.subject;
      account.freezeReason = request.reason;
    } else if (request.transition === 'UNFREEZE') {
      account.frozenAt = undefined;
      account.frozenBy = undefined;
      account.freezeReason = undefined;
    } else {
      account.closedAt = now;
      account.closedBy = actor.subject;
      account.closeReason = request.reason;
    }
  }

  private assertChecker(request: AccountLifecycleRequestRecord, actor: OperatorContext): void {
    if (!actor.permissions.includes('finance.approve')) {
      throw new ForbiddenException('finance.approve permission is required');
    }
    if (request.requestedBy === actor.subject) {
      throw new ForbiddenException('Self-approval is not permitted');
    }
  }

  private terminalReplay(
    request: AccountLifecycleRequestRecord,
    decision: 'APPROVE' | 'REJECT',
  ): AccountLifecycleRequestRecord | undefined {
    if (request.status === 'PENDING_APPROVAL') return undefined;
    if (decision === 'APPROVE' && request.status === 'APPLIED') return request;
    if (decision === 'REJECT' && request.status === 'REJECTED') return request;
    throw new ConflictException(`Lifecycle request is already ${request.status}`);
  }

  private assertTransition(status: AccountStatus, transition: AccountLifecycleTransition): void {
    const valid =
      (status === 'ACTIVE' && (transition === 'FREEZE' || transition === 'CLOSE')) ||
      (status === 'FROZEN' && transition === 'UNFREEZE');
    if (!valid) throw new ConflictException(`Cannot ${transition} an account in ${status} status`);
  }

  private targetStatus(transition: AccountLifecycleTransition): AccountStatus {
    if (transition === 'FREEZE') return 'FROZEN';
    if (transition === 'UNFREEZE') return 'ACTIVE';
    return 'CLOSED';
  }

  private validatePosting(account: AccountRecord, posting: AccountPostingInput): void {
    if (account.currency !== posting.currency) {
      throw new BadRequestException(`Posting currency does not match account ${account.id}`);
    }
    this.amount(posting.amount);
    if (account.status === 'CLOSED') {
      throw new ConflictException(`Account ${account.id} is closed`);
    }
    if (posting.entryType === 'REVERSAL' || posting.entryType === 'CORRECTION') {
      return;
    }
    if (account.status === 'FROZEN' && posting.direction === 'DEBIT') {
      throw new ConflictException(`Account ${account.id} is frozen for debits`);
    }
  }

  private assertEntryReplay(
    existing: AccountEntryRecord,
    posting: AccountPostingInput,
    journalEntryId?: string,
  ): void {
    if (
      existing.journalEntryId !== journalEntryId ||
      existing.accountId !== posting.accountId ||
      existing.direction !== posting.direction ||
      existing.amount !== this.amount(posting.amount).toFixed(2) ||
      existing.currency !== posting.currency
      || existing.entryType !== (posting.entryType || 'POSTING')
    ) {
      throw new ConflictException(`Posting key ${existing.postingKey} is already used by another account entry`);
    }
  }

  private amount(value: string): Decimal {
    const amount = new Decimal(value);
    if (!amount.isFinite() || !amount.isPositive() || amount.decimalPlaces() > 2) {
      throw new BadRequestException('Account entry amount must be a positive decimal with at most two places');
    }
    return amount;
  }

  private async assertMemoryProduct(tenantId: string, productId: string, currency: string): Promise<void> {
    const product = await this.store.getProduct(tenantId, productId);
    this.validateProduct(product, productId, currency);
  }

  private async assertConfiguredProduct(
    tx: TenantTransaction,
    tenantId: string,
    productId: string,
    currency: string,
  ): Promise<void> {
    const [row] = await tx.$queryRaw<any[]>`
      SELECT type, enabled, config FROM "products"
      WHERE "tenantId" = ${tenantId} AND id = ${productId}
      LIMIT 1
    `;
    this.validateProduct(row ? { ...this.parseJson(row.config), type: row.type, enabled: row.enabled } : undefined, productId, currency);
  }

  private validateProduct(product: any, productId: string, currency: string): void {
    if (!product) throw new BadRequestException(`Account product not found: ${productId}`);
    if (!product.enabled) throw new BadRequestException(`Account product is disabled: ${productId}`);
    if (![ProductType.CHECKING, ProductType.SAVINGS, ProductType.CREDIT_LINE].includes(product.type)) {
      throw new BadRequestException(`Product ${productId} cannot open an account`);
    }
    if (product.currency && product.currency !== currency) {
      throw new BadRequestException(`Account currency does not match product ${productId}`);
    }
  }

  private statementResponse(account: AccountRecord, entries: AccountEntryRecord[], limit: number) {
    const hasMore = entries.length > limit;
    const items = entries.slice(0, limit);
    const last = hasMore ? items[items.length - 1] : undefined;
    return {
      account_id: account.id,
      currency: account.currency,
      entries: items.map((entry) => this.publicEntry(entry)),
      next_cursor: last ? this.encodeCursor(last.postedAt, last.id) : null,
    };
  }

  private page<T extends { id: string; createdAt: Date }>(rows: T[], limit: number) {
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = hasMore ? items[items.length - 1] : undefined;
    return {
      items,
      next_cursor: last ? this.encodeCursor(last.createdAt, last.id) : null,
    };
  }

  private publicEntry(entry: AccountEntryRecord) {
    return {
      id: entry.id,
      journal_entry_id: entry.journalEntryId,
      transaction_id: entry.transactionId,
      entry_type: entry.entryType,
      direction: entry.direction,
      amount: entry.amount,
      currency: entry.currency,
      balance_after: entry.balanceAfter,
      reference: entry.reference,
      posted_at: entry.postedAt.toISOString(),
    };
  }

  private encodeCursor(at: Date, id: string): string {
    return Buffer.from(JSON.stringify({ at: at.toISOString(), id }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor?: string): { at: Date; id: string } | undefined {
    if (!cursor) return undefined;
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      const at = new Date(value.at);
      if (!value.id || Number.isNaN(at.getTime())) throw new Error('invalid cursor');
      return { at, id: value.id };
    } catch {
      throw new BadRequestException('Invalid pagination cursor');
    }
  }

  private beforeCursor(at: Date, id: string, cursor: { at: Date; id: string }): boolean {
    return at < cursor.at || (at.getTime() === cursor.at.getTime() && id < cursor.id);
  }

  private auditEvent(
    tenantId: string,
    action: string,
    entityType: string,
    entityId: string,
    actor: OperatorContext,
    stage: 'REQUESTED' | 'AUTHORIZED' | 'CONFIGURED',
    result: 'PENDING' | 'SUCCEEDED' | 'REJECTED' | 'FAILED',
    metadata: Record<string, any>,
  ) {
    return {
      tenant_id: tenantId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      actor_id: actor.subject,
      actor_roles: actor.roles,
      institution_id: actor.institutionId,
      branch_id: actor.branchId,
      correlation_id: actor.correlationId,
      stage,
      result,
      source: 'API' as const,
      metadata: {
        ...metadata,
        component: 'ledger-core.accounts',
      },
    };
  }

  private lifecycleAudit(
    request: AccountLifecycleRequestRecord,
    actor: OperatorContext,
    action: string,
    result: AccountLifecycleRequestStatus,
  ) {
    const auditResult = result === 'PENDING_APPROVAL'
      ? 'PENDING'
      : result === 'APPLIED'
        ? 'SUCCEEDED'
        : result;
    const reason = result === 'REJECTED' ? request.decisionReason : request.reason;
    return {
      ...this.auditEvent(
        request.tenantId,
        action,
        'account',
        request.accountId,
        actor,
        result === 'PENDING_APPROVAL' ? 'REQUESTED' : 'AUTHORIZED',
        auditResult,
        {
      transition: request.transition,
      from_status: request.fromStatus,
      target_status: request.targetStatus,
      maker_subject: request.requestedBy,
      checker_subject: request.decidedBy,
        },
      ),
      reason,
      approval_reference: request.id,
    };
  }

  private accountFromRow(row: any): AccountRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      customerId: row.customerId || undefined,
      productId: row.productId || undefined,
      name: row.name,
      currency: row.currency,
      status: row.status as AccountStatus,
      balance: new Decimal(row.balance).toFixed(2),
      version: Number(row.version),
      createdBy: row.createdBy || undefined,
      frozenAt: row.frozenAt || undefined,
      frozenBy: row.frozenBy || undefined,
      freezeReason: row.freezeReason || undefined,
      closedAt: row.closedAt || undefined,
      closedBy: row.closedBy || undefined,
      closeReason: row.closeReason || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private entryFromRow(row: any): AccountEntryRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      accountId: row.accountId,
      journalEntryId: row.journalEntryId || undefined,
      transactionId: row.transactionId || undefined,
      postingKey: row.postingKey,
      entryType: row.entryType,
      direction: row.direction,
      amount: new Decimal(row.amount).toFixed(2),
      currency: row.currency,
      balanceAfter: new Decimal(row.balanceAfter).toFixed(2),
      reference: row.reference || undefined,
      createdBy: row.createdBy,
      postedAt: row.postedAt,
      createdAt: row.createdAt,
    };
  }

  private lifecycleFromRow(row: any): AccountLifecycleRequestRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      accountId: row.accountId,
      transition: row.transition,
      fromStatus: row.fromStatus,
      targetStatus: row.targetStatus,
      expectedAccountVersion: Number(row.expectedAccountVersion),
      status: row.status,
      reason: row.reason,
      requestedBy: row.requestedBy,
      requestedRoles: this.parseJson(row.requestedRoles),
      institutionId: row.institutionId,
      branchId: row.branchId || undefined,
      correlationId: row.correlationId,
      decidedBy: row.decidedBy || undefined,
      decisionReason: row.decisionReason || undefined,
      decidedAt: row.decidedAt || undefined,
      appliedAt: row.appliedAt || undefined,
      failureReason: row.failureReason || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private parseJson<T>(value: any): T {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }
}
