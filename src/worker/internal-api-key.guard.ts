import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_API_KEY;
    const provided = context.switchToHttp().getRequest().headers['x-internal-api-key'];
    if (!expected || typeof provided !== 'string') {
      throw new UnauthorizedException('Internal API key is required');
    }

    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
      throw new UnauthorizedException('Invalid internal API key');
    }
    return true;
  }
}
