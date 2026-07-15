import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../services/prisma.service';
import { PUBLIC_ROUTE } from './public.decorator';
import type { AccessTokenClaims } from './access-token.types';
import { MetricsService } from '../metrics/metrics.service';

@Injectable()
export class TenantBoundaryGuard implements CanActivate {
  private readonly logger = new Logger(TenantBoundaryGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const identity = request.identity as AccessTokenClaims | undefined;
    if (!identity) {
      this.metrics.recordSecurityFailure('tenant', 'missing_identity');
      throw new ForbiddenException('Authenticated tenant context is required');
    }

    try {
      await this.prisma.bindTenantReference({
        tenantId: identity.tenant_id,
        institutionId: identity.institution_id,
      });
      return true;
    } catch {
      this.metrics.recordSecurityFailure('tenant', 'binding_mismatch');
      this.logger.warn(JSON.stringify({
        event: 'tenant_boundary_denied',
        tenant_id: identity.tenant_id,
        institution_id: identity.institution_id,
        subject: identity.sub,
        correlation_id: this.correlationId(request.headers['x-correlation-id']),
        result: 'DENIED',
      }));
      throw new ForbiddenException('Authenticated tenant context is not valid');
    }
  }

  private correlationId(value: unknown): string | undefined {
    return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value) ? value : undefined;
  }
}
