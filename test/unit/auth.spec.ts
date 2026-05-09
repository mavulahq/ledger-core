import { AuthService } from '../../src/auth/auth.service';

describe('AuthService', () => {
  it('signs token', async () => {
    const svc = new AuthService({} as any);
    const out = await svc.login({ id: 'u', roles: ['USER'] } as any);
    expect(out).toHaveProperty('access_token');
  });
});
