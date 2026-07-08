/*
 * mavula.io - Core Finance Engine
 * Copyright (c) 2026 mavula.io
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Controller, Post, Body, Res, HttpCode } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: any, @Res({ passthrough: true }) res: any) {
    // NOTE: In production validate credentials against user store
    const user = { id: body.username || 'user1', roles: body.roles || ['USER'] };
    const tokens = await this.authService.login(user);

    if (process.env.USE_HTTP_ONLY_COOKIE === 'true') {
      // Hardened cookie options for production
      const cookieOptions: any = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.COOKIE_SAMESITE || 'lax',
        maxAge: parseInt(process.env.COOKIE_MAX_AGE || '3600000', 10), // 1h default
        domain: process.env.COOKIE_DOMAIN || undefined,
      };
      res.cookie('access_token', tokens.access_token, cookieOptions);
      return { status: 'ok' }; // SPA should call /api/csrf-token if needed
    }

    return tokens;
  }
}
