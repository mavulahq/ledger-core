import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import {
  Rule,
  RuleEvaluationStage,
  RuleType,
  RulesEngineService,
} from '../rules-engine/rules-engine.service';

@Controller('products/:productId/rules')
export class RulesController {
  constructor(private readonly rules: RulesEngineService) {}

  @Get()
  async list(@Req() req: any, @Param('productId') productId: string) {
    return this.rules.getRules(productId, this.tenant(req));
  }

  @Post('defaults')
  async seedDefaults(@Req() req: any, @Param('productId') productId: string) {
    return this.rules.initializeDefaultRules(this.tenant(req), productId);
  }

  @Post()
  async create(@Req() req: any, @Param('productId') productId: string, @Body() body: any) {
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
  async update(@Param('productId') productId: string, @Param('ruleId') ruleId: string, @Body() body: Partial<Rule>) {
    await this.rules.updateRule(productId, ruleId, body);
    return { status: 'ok', rule_id: ruleId };
  }

  @Delete(':ruleId')
  async delete(@Param('productId') productId: string, @Param('ruleId') ruleId: string) {
    await this.rules.deleteRule(productId, ruleId);
    return { status: 'ok', rule_id: ruleId };
  }

  private tenant(req: any): string {
    return req.tenantId || 'public';
  }
}
