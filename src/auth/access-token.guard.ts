import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PUBLIC_ROUTE } from './public.decorator';
import type { AccessTokenClaims } from './access-token.types';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwksUri: URL;
  private jwks?: ReturnType<typeof import('jose')['createRemoteJWKSet']>;

  constructor(private readonly reflector: Reflector) {
    this.issuer = this.required('OIDC_ISSUER').replace(/\/$/, '');
    this.audience = this.required('OIDC_AUDIENCE');
    this.jwksUri = new URL(this.required('OIDC_JWKS_URI'));
    if (process.env.NODE_ENV === 'production') {
      if (new URL(this.issuer).protocol !== 'https:' || this.jwksUri.protocol !== 'https:') {
        throw new Error('OIDC issuer and JWKS URI must use HTTPS in production');
      }
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer access token is required');
    }
    try {
      const { jwtVerify } = await loadJose();
      const jwks = await this.verifier();
      const { payload } = await jwtVerify(authorization.slice(7), jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['PS256'],
        typ: 'at+jwt',
      });
      this.assertClaims(payload);
      const selectedTenant = request.headers['x-tenant-id'];
      if (selectedTenant !== undefined && selectedTenant !== payload.tenant_id) {
        throw new ForbiddenException('X-Tenant-ID does not match the authenticated tenant');
      }
      request.identity = payload as AccessTokenClaims;
      request.user = payload;
      request.tenantId = payload.tenant_id;
      request.institutionId = payload.institution_id;
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new UnauthorizedException('Invalid access token');
    }
  }

  private async verifier() {
    if (!this.jwks) {
      const { createRemoteJWKSet } = await loadJose();
      this.jwks = createRemoteJWKSet(this.jwksUri, {
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
        timeoutDuration: 5_000,
      });
    }
    return this.jwks;
  }

  private assertClaims(payload: Record<string, unknown>) {
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.tenant_id !== 'string' ||
      typeof payload.institution_id !== 'string' ||
      !Array.isArray(payload.roles) ||
      !Array.isArray(payload.permissions) ||
      payload.roles.some((role) => typeof role !== 'string') ||
      payload.permissions.some((permission) => typeof permission !== 'string')
    ) {
      throw new Error('Required access-token claims are missing');
    }
  }

  private required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  }
}

let joseModule: Promise<typeof import('jose')> | undefined;
function loadJose() {
  joseModule ||= (new Function('return import("jose")') as () => Promise<typeof import('jose')>)();
  return joseModule;
}
