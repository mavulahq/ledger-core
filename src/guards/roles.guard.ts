/*
 * getfluxo.io - Core Finance Engine
 * Copyright (c) 2026 getfluxo.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../common/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;
    const req = context.switchToHttp().getRequest();
    const user = req.user || {};
    const roles = user.roles || [];
    return requiredRoles.some((r) => roles.includes(r));
  }
}
