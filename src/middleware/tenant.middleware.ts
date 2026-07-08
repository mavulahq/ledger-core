/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2026 getfluxo.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Request, Response } from 'express';

export class TenantMiddleware {
  use(req: Request & { tenantId?: string }, res: Response, next: Function) {
    const header = (req.headers['x-tenant-id'] || req.headers['x-institution-id'] || '') as string;
    const tenant = header || (req.query && (req.query.tenant_id as string)) || null;
    req.tenantId = tenant;
    if (tenant) {
      process.env.APP_CURRENT_TENANT = tenant;
    }
    next();
  }
}
