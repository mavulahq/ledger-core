import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

@Injectable()
export class MetricsTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.LEDGER_CORE_METRICS_TOKEN?.trim();
    if (!expected) throw new UnauthorizedException('Metrics scrape token is not configured');
    const authorization = context.switchToHttp().getRequest().headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException('Metrics scrape token is required');
    }
    const expectedDigest = createHash('sha256').update(expected).digest();
    const suppliedDigest = createHash('sha256').update(authorization.slice(7)).digest();
    if (!timingSafeEqual(expectedDigest, suppliedDigest)) throw new UnauthorizedException('Invalid metrics scrape token');
    return true;
  }
}
