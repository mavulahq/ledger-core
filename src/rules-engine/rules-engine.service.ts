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

  /**
   * Initialize rules for tenant (SADC banking standards)
   */
  initializeDefaultRules(tenantId: string, productId: string): Rule[] {
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
      created_at: new Date(),
      updated_at: new Date(),
    });

    this.rules.set(productId, rules);
    console.log(`✓ Initialized ${rules.length} rules for product ${productId}`);

    return rules;
  }

  /**
   * Evaluate all rules for transaction
   */
  evaluateRules(productId: string, context: EvaluationContext): RuleEvaluationResult[] {
    const results: RuleEvaluationResult[] = [];
    const productRules = this.rules.get(productId) || [];

    // Sort by priority (higher first)
    const sortedRules = [...productRules].sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      if (!rule.enabled) continue;

      try {
        const passed = this.evaluateCondition(rule.condition, context);
        const actions = passed ? this.extractActions(rule) : [];

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

  /**
   * Add custom rule for specific product
   */
  addRule(tenantId: string, rule: Rule): void {
    if (!this.rules.has(rule.product_id)) {
      this.rules.set(rule.product_id, []);
    }
    this.rules.get(rule.product_id)!.push(rule);
  }

  /**
   * Update rule
   */
  updateRule(productId: string, ruleId: string, updates: Partial<Rule>): void {
    const rules = this.rules.get(productId) || [];
    const idx = rules.findIndex(r => r.id === ruleId);
    if (idx >= 0) {
      rules[idx] = { ...rules[idx], ...updates, updated_at: new Date() };
    }
  }

  /**
   * Delete rule
   */
  deleteRule(productId: string, ruleId: string): void {
    const rules = this.rules.get(productId) || [];
    this.rules.set(
      productId,
      rules.filter(r => r.id !== ruleId)
    );
  }

  /**
   * Get all rules for product
   */
  getRules(productId: string): Rule[] {
    return this.rules.get(productId) || [];
  }
}
