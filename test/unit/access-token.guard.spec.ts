import { createServer, type Server } from 'node:http';
import { Reflector } from '@nestjs/core';
import { AccessTokenGuard } from '../../src/auth/access-token.guard';

describe('AccessTokenGuard', () => {
  let server: Server;
  let privateKey: CryptoKey;
  let jose: typeof import('jose');
  let jwksUri: string;

  beforeAll(async () => {
    jose = await (new Function('return import("jose")') as () => Promise<typeof import('jose')>)();
    const pair = await jose.generateKeyPair('PS256', { modulusLength: 2048, extractable: true });
    privateKey = pair.privateKey;
    const publicKey = await jose.exportJWK(pair.publicKey);
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [{ ...publicKey, kid: 'guard-test', alg: 'PS256', use: 'sig' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    jwksUri = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/jwks`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('validates issuer, audience, signature and trusted tenant claims', async () => {
    process.env.OIDC_ISSUER = 'https://identity.mavula.io';
    process.env.OIDC_AUDIENCE = 'urn:mavula:ledger-core';
    process.env.OIDC_JWKS_URI = jwksUri;
    const token = await accessToken();
    const request: any = { headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'tenant-1' } };
    const guard = new AccessTokenGuard(new Reflector(), { recordSecurityFailure: jest.fn() } as any);
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-1');
    expect(request.identity.permissions).toContain('finance.read');
  });

  it('rejects a tenant selector that differs from the signed claim', async () => {
    process.env.OIDC_ISSUER = 'https://identity.mavula.io';
    process.env.OIDC_AUDIENCE = 'urn:mavula:ledger-core';
    process.env.OIDC_JWKS_URI = jwksUri;
    const request = {
      headers: { authorization: `Bearer ${await accessToken()}`, 'x-tenant-id': 'tenant-2' },
    };
    const guard = new AccessTokenGuard(new Reflector(), { recordSecurityFailure: jest.fn() } as any);
    await expect(guard.canActivate(context(request))).rejects.toThrow('does not match');
  });

  async function accessToken() {
    return new jose.SignJWT({
      tenant_id: 'tenant-1',
      institution_id: 'institution-1',
      roles: ['auditor'],
      permissions: ['finance.read', 'audit.read'],
    })
      .setProtectedHeader({ alg: 'PS256', kid: 'guard-test', typ: 'at+jwt' })
      .setSubject('operator-1')
      .setIssuer('https://identity.mavula.io')
      .setAudience('urn:mavula:ledger-core')
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('token-1')
      .sign(privateKey);
  }
});

function context(request: any) {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
}
