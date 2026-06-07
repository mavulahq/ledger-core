import { Body, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { SchemaManagerService } from '../schema-manager/schema-manager.service';

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly schemas: SchemaManagerService) {}

  @Get()
  async list(@Req() req: any) {
    return this.schemas.listWorkflows(this.tenant(req));
  }

  @Get('trigger/:trigger')
  async listByTrigger(@Req() req: any, @Param('trigger') trigger: string) {
    return this.schemas.getWorkflowsByTrigger(this.tenant(req), trigger);
  }

  @Get(':workflowId')
  async get(@Req() req: any, @Param('workflowId') workflowId: string) {
    const workflow = await this.schemas.getWorkflow(this.tenant(req), workflowId);
    if (!workflow) {
      throw new NotFoundException(`Workflow not found: ${workflowId}`);
    }
    return workflow;
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    return this.schemas.createWorkflow(this.tenant(req), body);
  }

  @Post('presets/loan-approval-notification')
  async createLoanApprovalNotification(@Req() req: any) {
    return this.schemas.createLoanApprovalNotificationWorkflow(this.tenant(req));
  }

  @Post('presets/monthly-fee-charge')
  async createMonthlyFeeCharge(@Req() req: any) {
    return this.schemas.createMonthlyFeeChargeWorkflow(this.tenant(req));
  }

  @Post(':workflowId/execute')
  async execute(@Req() req: any, @Param('workflowId') workflowId: string, @Body() body: any) {
    return this.schemas.executeWorkflow(this.tenant(req), workflowId, body.context || body);
  }

  private tenant(req: any): string {
    return req.tenantId || 'public';
  }
}
