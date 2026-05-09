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
      res.cookie('access_token', tokens.access_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
      });
      return { status: 'ok' };
    }

    return tokens;
  }
}
