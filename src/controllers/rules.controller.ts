import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import {
  Rule,
  RuleEvaluationStage,
  RuleType,
  RulesEngineService,
} from '../rules-engine/rules-engine.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CreateRuleV1Dto, UpdateRuleV1Dto } from '../dto/public.dto';
import { IdempotentOperation } from '../idempotency/idempotent-operation.decorator';

@Controller('products/:productId/rules')
@RequirePermissions('finance.read')
export class RulesController {
  constructor(private readonly rules: RulesEngineService) {}

  @Get()
  async list(@Req() req: any, @Param('productId') productId: string) {
    return this.rules.getRules(productId, this.tenant(req));
  }

  @Post('defaults')
  @RequirePermissions('configuration.write')
  @IdempotentOperation('rules.defaults.seed')
  async seedDefaults(@Req() req: any, @Param('productId') productId: string) {
    return this.rules.initializeDefaultRules(this.tenant(req), productId);
  }

  @Post()
  @RequirePermissions('configuration.write')
  @IdempotentOperation('rules.create')
  async create(@Req() req: any, @Param('productId') productId: string, @Body() body: CreateRuleV1Dto) {
    const tenantId = this.tenant(req);
    const now = new Date();
    const rule: Rule = {
      id: body.id || `rule_${productId}_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: body.rule_type as RuleType,
      condition: body.condition || 'true',
      action: body.action || {},
      priority: Number(body.priority || 0),
      enabled: body.enabled ?? true,
      applies_to: body.applies_to as RuleEvaluationStage[] | undefined,
      created_at: now,
      updated_at: now,
    };
    await this.rules.addRule(tenantId, rule);
    return rule;
  }

  @Put(':ruleId')
  @RequirePermissions('configuration.write')
  @IdempotentOperation('rules.update')
  async update(@Req() req: any, @Param('productId') productId: string, @Param('ruleId') ruleId: string, @Body() body: UpdateRuleV1Dto) {
    await this.rules.updateRule(this.tenant(req), productId, ruleId, body as Partial<Rule>);
    return { status: 'ok', rule_id: ruleId };
  }

  @Delete(':ruleId')
  @RequirePermissions('configuration.write')
  @IdempotentOperation('rules.delete')
  async delete(@Req() req: any, @Param('productId') productId: string, @Param('ruleId') ruleId: string) {
    await this.rules.deleteRule(this.tenant(req), productId, ruleId);
    return { status: 'ok', rule_id: ruleId };
  }

  private tenant(req: any): string {
    return req.tenantId;
  }
}
