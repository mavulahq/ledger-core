/*
 * mavula.io - Core Finance Engine
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Controller, GoneException, Post } from '@nestjs/common';
import { Public } from './public.decorator';

@Controller('auth')
export class AuthController {
  @Post('login')
  @Public()
  login() {
    throw new GoneException({
      statusCode: 410,
      error: 'Gone',
      message: 'Local login has been retired',
      issuer: process.env.OIDC_ISSUER,
      authorization_endpoint: process.env.OIDC_AUTHORIZATION_ENDPOINT,
    });
  }
}
