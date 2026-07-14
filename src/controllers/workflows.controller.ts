import { Body, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { SchemaManagerService } from '../schema-manager/schema-manager.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CreateWorkflowV1Dto, ExecuteWorkflowV1Dto } from '../dto/public.dto';

@Controller('workflows')
@RequirePermissions('finance.read')
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
  @RequirePermissions('configuration.write')
  async create(@Req() req: any, @Body() body: CreateWorkflowV1Dto) {
    return this.schemas.createWorkflow(this.tenant(req), body);
  }

  @Post('presets/loan-approval-notification')
  @RequirePermissions('configuration.write')
  async createLoanApprovalNotification(@Req() req: any) {
    return this.schemas.createLoanApprovalNotificationWorkflow(this.tenant(req));
  }

  @Post('presets/monthly-fee-charge')
  @RequirePermissions('configuration.write')
  async createMonthlyFeeCharge(@Req() req: any) {
    return this.schemas.createMonthlyFeeChargeWorkflow(this.tenant(req));
  }

  @Post(':workflowId/execute')
  @RequirePermissions('finance.write')
  async execute(@Req() req: any, @Param('workflowId') workflowId: string, @Body() body: ExecuteWorkflowV1Dto) {
    return this.schemas.executeWorkflow(this.tenant(req), workflowId, body.context);
  }

  private tenant(req: any): string {
    return req.tenantId;
  }
}
