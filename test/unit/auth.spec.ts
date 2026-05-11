import { AuthService } from '../../src/auth/auth.service';

describe('AuthService', () => {
  it('signs token', async () => {
    const svc = new AuthService({ sign: () => 'test-token' } as any);
    const out = await svc.login({ id: 'u', roles: ['USER'] } as any);
    expect(out).toHaveProperty('access_token');
    expect(out.access_token).toBe('test-token');
  });
});
