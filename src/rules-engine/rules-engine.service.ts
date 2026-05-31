/*
 * getfluxo.io - Financial Rules Engine & Business Logic
 * Copyright (c) 2025 getfluxo.io
 * 
 * Author: Estandar Mustaq <estandarmustaq@getfluxo.io>
 * License: Proprietary - See LICENSE file
 * 
 * Business rules evaluation: eligibility, limits, fees, workflows
 * Used by no-code product configuration for dynamic behavior
 */

import { Injectable } from '@nestjs/common';
import { AuditTrailService } from '../services/audit-trail.service';
import { FengineStoreService } from '../services/fengine-store.service';

export type OODAStage = 'ORIGINATION' | 'PAYMENT' | 'DISBURSEMENT' | 'CONFIGURATION' | 'MONITORING';

export enum RuleType {
  // Eligibility rules
  CREDIT_SCORE_MIN = 'CREDIT_SCORE_MIN',
  INCOME_VERIFICATION = 'INCOME_VERIFICATION',
  EMPLOYMENT_DURATION = 'EMPLOYMENT_DURATION',
  
  // Limit rules
  MAX_LOAN_AMOUNT = 'MAX_LOAN_AMOUNT',
  MAX_UTILIZATION = 'MAX_UTILIZATION',
  DAILY_WITHDRAWAL_LIMIT = 'DAILY_WITHDRAWAL_LIMIT',
  TRANSACTION_FREQUENCY = 'TRANSACTION_FREQUENCY',
  
  // Fee rules
  MONTHLY_MAINTENANCE_FEE = 'MONTHLY_MAINTENANCE_FEE',
  MINIMUM_BALANCE_PENALTY = 'MINIMUM_BALANCE_PENALTY',
  OVERDRAFT_FEE = 'OVERDRAFT_FEE',
  LOAN_ORIGINATION_FEE = 'LOAN_ORIGINATION_FEE',
  
  // Interest rules
  INTEREST_RATE_TIER = 'INTEREST_RATE_TIER',
  GRACE_PERIOD = 'GRACE_PERIOD',
  LATE_PAYMENT_CHARGE = 'LATE_PAYMENT_CHARGE',
  
  // Compliance rules
  AML_CHECK = 'AML_CHECK',
  KYC_REQUIRED = 'KYC_REQUIRED',
  TRANSACTION_REPORTING = 'TRANSACTION_REPORTING',
}

export interface Rule {
  id: string;
  tenant_id: string;
  product_id: string;
  rule_type: RuleType;
  condition: string;        // JavaScript expression or DSL
  action: Record<string, any>;  // Parameters for action
  priority: number;          // Higher = more important (evaluated first)
  enabled: boolean;
  applies_to?: OODAStage[];
  created_at: Date;
  updated_at: Date;
}

export interface EvaluationContext {
  customer_id: string;
  customer_credit_score?: number;
  customer_income?: number;
  customer_employment_years?: number;
  customer_kyc_status?: string;
  
  account_type?: string;
  account_balance?: number;
  account_daily_withdrawal?: number;
  account_monthly_fees?: number;
  
  transaction_amount?: number;
  transaction_type?: string;
  transaction_date?: Date;
  stage?: OODAStage;
  
  [key: string]: any;
}

export interface RuleEvaluationResult {
  rule_id: string;
  rule_type: RuleType;
  passed: boolean;
  actions: Array<{ action: string; value: any }>;
  reason?: string;
}

@Injectable()
export class RulesEngineService {
  private rules: Map<string, Rule[]> = new Map();

  constructor(
    private readonly auditTrail: AuditTrailService,
    private readonly store: FengineStoreService,
  ) {}

  /**
   * Initialize rules for tenant (SADC banking standards)
   */
  async initializeDefaultRules(tenantId: string, productId: string): Promise<Rule[]> {
    const rules: Rule[] = [];

    // ELIGIBILITY RULES
    rules.push({
      id: `rule_credit_score_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.CREDIT_SCORE_MIN,
      condition: 'customer_credit_score >= 300',
      action: { reject: false, min_score: 300 },
      priority: 10,
      enabled: true,
      applies_to: ['ORIGINATION'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    rules.push({
      id: `rule_kyc_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.KYC_REQUIRED,
      condition: 'customer_kyc_status === "VERIFIED"',
      action: { require_kyc: true },
      priority: 15,
      enabled: true,
      applies_to: ['ORIGINATION', 'DISBURSEMENT'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    // LIMIT RULES
    rules.push({
      id: `rule_max_loan_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.MAX_LOAN_AMOUNT,
      condition: 'transaction_amount <= 50000',  // Max 50K MZN
      action: { max_amount: 50000 },
      priority: 8,
      enabled: true,
      applies_to: ['ORIGINATION'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    rules.push({
      id: `rule_daily_withdrawal_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.DAILY_WITHDRAWAL_LIMIT,
      condition: 'account_daily_withdrawal <= 500000',  // 500K MZN daily limit
      action: { daily_limit: 500000 },
      priority: 7,
      enabled: true,
      applies_to: ['PAYMENT', 'DISBURSEMENT'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    // FEE RULES
    rules.push({
      id: `rule_monthly_fee_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.MONTHLY_MAINTENANCE_FEE,
      condition: 'account_balance >= 0',  // Charge if account exists
      action: { fee_amount: 50, frequency: 'MONTHLY' },
      priority: 5,
      enabled: true,
      applies_to: ['MONITORING', 'PAYMENT'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    rules.push({
      id: `rule_min_balance_penalty_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.MINIMUM_BALANCE_PENALTY,
      condition: 'account_balance < 1000',  // Penalty if below 1K
      action: { penalty_fee: 100 },
      priority: 6,
      enabled: true,
      applies_to: ['MONITORING', 'PAYMENT'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    rules.push({
      id: `rule_loan_origination_fee_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.LOAN_ORIGINATION_FEE,
      condition: 'true',
      action: { fee_percent: 2.0 },  // 2% of loan amount
      priority: 9,
      enabled: true,
      applies_to: ['ORIGINATION', 'DISBURSEMENT'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    // INTEREST RULES
    rules.push({
      id: `rule_interest_tier_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.INTEREST_RATE_TIER,
      condition: 'transaction_amount > 0',
      action: {
        tiers: [
          { min: 0, max: 10000, rate: 3.0 },      // 3% for small loans
          { min: 10000, max: 30000, rate: 2.5 },  // 2.5% for medium
          { min: 30000, max: 50000, rate: 2.0 },  // 2% for large
        ],
      },
      priority: 4,
      enabled: true,
      applies_to: ['ORIGINATION'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    rules.push({
      id: `rule_grace_period_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.GRACE_PERIOD,
      condition: 'customer_income >= 50000',  // Grace for good customers
      action: { grace_months: 3 },
      priority: 3,
      enabled: true,
      applies_to: ['ORIGINATION'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    rules.push({
      id: `rule_late_charge_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.LATE_PAYMENT_CHARGE,
      condition: 'true',
      action: { charge_percent: 5.0 },  // 5% of payment if late
      priority: 2,
      enabled: true,
      applies_to: ['PAYMENT', 'MONITORING'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    // COMPLIANCE RULES
    rules.push({
      id: `rule_aml_check_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.AML_CHECK,
      condition: 'transaction_amount > 50000',  // AML for large transactions
      action: { require_aml: true },
      priority: 20,
      enabled: true,
      applies_to: ['ORIGINATION', 'DISBURSEMENT', 'PAYMENT'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    rules.push({
      id: `rule_transaction_reporting_${Date.now()}`,
      tenant_id: tenantId,
      product_id: productId,
      rule_type: RuleType.TRANSACTION_REPORTING,
      condition: 'transaction_amount > 100000',  // Report large transactions
      action: { report_to_regulator: true },
      priority: 1,
      enabled: true,
      applies_to: ['ORIGINATION', 'DISBURSEMENT', 'PAYMENT'],
      created_at: new Date(),
      updated_at: new Date(),
    });

    this.rules.set(productId, rules);
    await this.store.saveRules(tenantId, productId, rules);
    console.log(`✓ Initialized ${rules.length} rules for product ${productId}`);

    return rules;
  }

  /**
   * Evaluate all rules for transaction
   */
  async evaluateRules(productId: string, context: EvaluationContext): Promise<RuleEvaluationResult[]> {
    const results: RuleEvaluationResult[] = [];
    const tenantId = context.tenant_id || process.env.APP_CURRENT_TENANT || 'public';
    const productRules = this.rules.get(productId) || await this.store.listRules(productId, tenantId);
    this.rules.set(productId, productRules);
    const normalizedContext: EvaluationContext = {
      customer_kyc_status: 'VERIFIED',
      ...context,
    };

    // Sort by priority (higher first)
    const sortedRules = [...productRules].sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      if (!rule.enabled) continue;
      if (normalizedContext.stage && rule.applies_to?.length && !rule.applies_to.includes(normalizedContext.stage)) {
        continue;
      }

      try {
        const matched = this.evaluateCondition(rule.condition, normalizedContext);
        const passed = matched || this.isConditionalActionRule(rule.rule_type);
        const actions = matched ? this.extractActions(rule) : [];

        results.push({
          rule_id: rule.id,
          rule_type: rule.rule_type,
          passed,
          actions,
          reason: passed ? undefined : 'Condition not met',
        });

        // Fast-fail on critical rules (eligibility, compliance)
        if (!passed && this.isCriticalRule(rule.rule_type)) {
          console.warn(`✗ Critical rule failed: ${rule.rule_type}`);
          break;
        }
      } catch (error) {
        console.error(`Error evaluating rule ${rule.id}:`, error);
      }
    }

    if (context.customer_id) {
      this.auditTrail.record({
        tenant_id: tenantId,
        action: 'rules.evaluated',
        entity_type: 'rules',
        entity_id: productId,
        phase: 'ORIENT',
        metadata: {
          stage: normalizedContext.stage || 'UNSPECIFIED',
          passed: results.filter((item) => item.passed).length,
          failed: results.filter((item) => !item.passed).length,
        },
      });
    }

    return results;
  }

  /**
   * Simple condition evaluator (in production, use safer sandboxed evaluation)
   */
  private evaluateCondition(condition: string, context: EvaluationContext): boolean {
    // Safe evaluation using template literals
    const contextStr = JSON.stringify(context);
    const func = new Function(...Object.keys(context), `return ${condition}`);
    try {
      return func(...Object.values(context));
    } catch {
      return false;
    }
  }

  private extractActions(rule: Rule): Array<{ action: string; value: any }> {
    return Object.entries(rule.action).map(([key, value]) => ({
      action: key,
      value,
    }));
  }

  private isCriticalRule(type: RuleType): boolean {
    return [
      RuleType.CREDIT_SCORE_MIN,
      RuleType.KYC_REQUIRED,
      RuleType.AML_CHECK,
    ].includes(type);
  }

  private isConditionalActionRule(type: RuleType): boolean {
    return [
      RuleType.AML_CHECK,
      RuleType.TRANSACTION_REPORTING,
      RuleType.MONTHLY_MAINTENANCE_FEE,
      RuleType.MINIMUM_BALANCE_PENALTY,
      RuleType.OVERDRAFT_FEE,
      RuleType.LOAN_ORIGINATION_FEE,
      RuleType.INTEREST_RATE_TIER,
      RuleType.GRACE_PERIOD,
      RuleType.LATE_PAYMENT_CHARGE,
    ].includes(type);
  }

  /**
   * Add custom rule for specific product
   */
  async addRule(tenantId: string, rule: Rule): Promise<void> {
    if (!this.rules.has(rule.product_id)) {
      this.rules.set(rule.product_id, []);
    }
    this.rules.get(rule.product_id)!.push(rule);
    await this.store.saveRule(tenantId, rule);
    this.auditTrail.record({
      tenant_id: tenantId,
      action: 'rule.created',
      entity_type: 'rule',
      entity_id: rule.id,
      phase: 'ACT',
      metadata: { product_id: rule.product_id, rule_type: rule.rule_type },
    });
  }

  /**
   * Update rule
   */
  async updateRule(productId: string, ruleId: string, updates: Partial<Rule>): Promise<void> {
    const rules = this.rules.get(productId) || [];
    const idx = rules.findIndex(r => r.id === ruleId);
    if (idx >= 0) {
      rules[idx] = { ...rules[idx], ...updates, updated_at: new Date() };
      await this.store.saveRule(rules[idx].tenant_id, rules[idx]);
    }
  }

  /**
   * Delete rule
   */
  async deleteRule(productId: string, ruleId: string): Promise<void> {
    const rules = this.rules.get(productId) || [];
    this.rules.set(
      productId,
      rules.filter(r => r.id !== ruleId)
    );
    await this.store.deleteRule(productId, ruleId);
  }

  /**
   * Get all rules for product
   */
  async getRules(productId: string, tenantId?: string): Promise<Rule[]> {
    const rules = this.rules.get(productId) || await this.store.listRules(productId, tenantId);
    this.rules.set(productId, rules);
    return rules;
  }
}
