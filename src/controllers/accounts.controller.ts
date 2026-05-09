import { Controller, Get, Post, Body, Req } from '@nestjs/common';
import { AccountsService } from '../services/accounts.service';

@Controller('accounts')
export class AccountsController {
  constructor(private svc: AccountsService) {}

  @Get()
  async list(@Req() req: any) {
    const tenant = req.tenantId || 'public';
    return this.svc.listAccounts(tenant);
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const tenant = req.tenantId || 'public';
    return this.svc.createAccount(tenant, body);
  }
}
