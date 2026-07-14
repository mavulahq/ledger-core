import type { JWTPayload } from 'jose';

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  tenant_id: string;
  institution_id: string;
  branch_id?: string;
  roles: string[];
  permissions: string[];
  client_id?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    identity?: AccessTokenClaims;
    tenantId?: string;
    institutionId?: string;
  }
}
