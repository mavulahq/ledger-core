import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly allowedRoles: string[] = []) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user || {};
    if (!this.allowedRoles || this.allowedRoles.length === 0) return true;
    const roles = user.roles || [];
    return this.allowedRoles.some(r => roles.includes(r));
  }
}
