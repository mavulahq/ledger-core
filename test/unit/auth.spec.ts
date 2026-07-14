import { GoneException } from '@nestjs/common';
import { AuthController } from '../../src/auth/auth.controller';

describe('AuthController', () => {
  it('does not issue local tokens', () => {
    process.env.OIDC_ISSUER = 'https://identity.mavula.io';
    process.env.OIDC_AUTHORIZATION_ENDPOINT = 'https://identity.mavula.io/auth';
    const controller = new AuthController();
    expect(() => controller.login()).toThrow(GoneException);
  });
});
