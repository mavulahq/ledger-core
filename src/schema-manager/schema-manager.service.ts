/*
 * getfluxo.io - Dynamic Schema Manager (No-Code Configuration)
 * Copyright (c) 2025 getfluxo.io
 * 
 * Author: Estandar Mustaq <estandarmustaq@getfluxo.io>
 * License: Proprietary - See LICENSE file
 * 
 * Tenant institutions can define custom fields, workflows, and validations
 * without touching code. Schema changes trigger automatic migrations.
 */

import { Injectable } from '@nestjs/common';
import { FengineStoreService } from '../services/fengine-store.service';
import { AuditTrailService } from '../services/audit-trail.service';

export interface FieldDefinition {
  name: string;
  type: 'STRING' | 'NUMBER' | 'DATE' | 'BOOLEAN' | 'ENUM' | 'REFERENCE';
  required: boolean;
  maxLength?: number;
  pattern?: string;              // Regex validation
  enum_values?: string[];        // For ENUM type
  reference_table?: string;      // For REFERENCE type
  default?: any;
  description?: string;
}

export interface CustomEntitySchema {
  entity_id: string;
  tenant_id: string;
  entity_name: string;           // e.g., "customer_profile"
  display_name: string;          // e.g., "Customer Profile"
  fields: FieldDefinition[];
  created_at: Date;
  updated_at: Date;
}

export interface FormLayout {
  entity_id: string;
  sections: FormSection[];        // Organize fields into sections
  validation_rules: ValidationRule[];
}

export interface FormSection {
  title: string;
  description?: string;
  fields: string[];               // Field names to display
  collapsible?: boolean;
}

export interface ValidationRule {
  field1: string;
  condition: string;              // e.g., "length > 10"
  then_field: string;
  then_required: boolean;
}

export interface WorkflowDefinition {
  workflow_id: string;
  name: string;
  trigger: string;                // "LOAN_APPLY", "PAYMENT_RECEIVED", etc.
  steps: WorkflowStep[];
  enabled: boolean;
}

export interface WorkflowStep {
  order: number;
  name: string;
  action: string;                 // "SEND_SMS", "UPDATE_FIELD", "CALL_API", "APPROVE"
  parameters: Record<string, any>;
  condition?: string;             // When to execute (e.g., "amount > 50000")
}

@Injectable()
export class SchemaManagerService {
  private schemas: Map<string, CustomEntitySchema> = new Map();
  private workflows: Map<string, WorkflowDefinition> = new Map();

  constructor(
    private readonly store: FengineStoreService,
    private readonly auditTrail: AuditTrailService,
  ) {}

  /**
   * Create custom entity schema (no-code form builder result)
   * Institution defines: customer_profile, business_registration, collateral_valuation, etc.
   */
  async createEntitySchema(
    tenantId: string,
    entity: {
      entity_name: string;
      display_name: string;
      fields: FieldDefinition[];
    }
  ): Promise<CustomEntitySchema> {
    const schema: CustomEntitySchema = {
      entity_id: `ent_${entity.entity_name}_${Date.now()}`,
      tenant_id: tenantId,
      entity_name: entity.entity_name,
      display_name: entity.display_name,
      fields: entity.fields,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.schemas.set(schema.entity_id, schema);
    await this.store.saveSchema(tenantId, schema);
    this.auditTrail.record({
      tenant_id: tenantId,
      action: 'schema.created',
      entity_type: 'schema',
      entity_id: schema.entity_id,
      phase: 'ACT',
      metadata: { entity_name: schema.entity_name, field_count: schema.fields.length },
    });

    // In production, would:
    // 1. Create table in PostgreSQL
    // 2. Add columns based on field definitions
    // 3. Create indexes on frequently-queried fields
    // 4. Create RLS policies for tenant isolation

    console.log(`✓ Schema created: ${schema.entity_id} (${schema.display_name})`);
    return schema;
  }

  /**
   * Example: Create "Business Registration" form for loan applications
   */
  createBusinessRegistrationSchema(tenantId: string): Promise<CustomEntitySchema> {
    return this.createEntitySchema(tenantId, {
      entity_name: 'business_registration',
      display_name: 'Business Registration Information',
      fields: [
        {
          name: 'business_name',
          type: 'STRING',
          required: true,
          maxLength: 255,
          description: 'Official business name',
        },
        {
          name: 'business_reg_number',
          type: 'STRING',
          required: true,
          pattern: '^[0-9]{8}$',  // 8-digit registration number
          description: 'NUIT (Mozambique business tax number)',
        },
        {
          name: 'industry_sector',
          type: 'ENUM',
          required: true,
          enum_values: ['RETAIL', 'MANUFACTURING', 'AGRICULTURE', 'SERVICES', 'TECHNOLOGY'],
          description: 'Primary industry sector',
        },
        {
          name: 'annual_revenue',
          type: 'NUMBER',
          required: true,
          description: 'Annual revenue in MZN',
        },
        {
          name: 'employee_count',
          type: 'NUMBER',
          required: false,
          description: 'Number of employees',
        },
        {
          name: 'years_in_operation',
          type: 'NUMBER',
          required: true,
          description: 'Years business has been operating',
        },
        {
          name: 'business_license_expiry',
          type: 'DATE',
          required: true,
          description: 'Business license expiration date',
        },
        {
          name: 'is_registered_vat',
          type: 'BOOLEAN',
          required: true,
          description: 'Is business registered for VAT?',
        },
      ],
    });
  }

  /**
   * Define form layout for entity (UI hints)
   */
  defineFormLayout(entityId: string, layout: FormLayout): void {
    // Store layout for UI to render
    console.log(`Form layout defined for ${entityId}:`);
    for (const section of layout.sections) {
      console.log(`  Section: ${section.title} (${section.fields.join(', ')})`);
    }
  }

  /**
   * Define custom workflow triggered by events
   * Example: When loan is approved, send SMS notification
   */
  async createWorkflow(
    tenantId: string,
    workflow: {
      name: string;
      trigger: string;
      steps: WorkflowStep[];
    }
  ): Promise<WorkflowDefinition> {
    const wf: WorkflowDefinition = {
      workflow_id: `wf_${workflow.trigger}_${Date.now()}`,
      name: workflow.name,
      trigger: workflow.trigger,
      steps: workflow.steps,
      enabled: true,
    };

    this.workflows.set(wf.workflow_id, wf);
    await this.store.saveWorkflow(tenantId, wf);
    this.auditTrail.record({
      tenant_id: tenantId,
      action: 'workflow.created',
      entity_type: 'workflow',
      entity_id: wf.workflow_id,
      phase: 'ACT',
      metadata: { trigger: wf.trigger, steps: wf.steps.length },
    });

    console.log(`✓ Workflow created: ${wf.workflow_id} (${wf.name})`);
    return wf;
  }

  listEntitySchemas(tenantId: string): Promise<CustomEntitySchema[]> {
    return this.store.listSchemas(tenantId);
  }

  getEntitySchema(tenantId: string, entityId: string): Promise<CustomEntitySchema | undefined> {
    return this.store.getSchema(tenantId, entityId);
  }

  listWorkflows(tenantId: string): Promise<WorkflowDefinition[]> {
    return this.store.listWorkflows(tenantId);
  }

  getWorkflow(tenantId: string, workflowId: string): Promise<WorkflowDefinition | undefined> {
    return this.store.getWorkflow(tenantId, workflowId);
  }

  /**
   * Example workflow: On loan approval, notify customer
   */
  createLoanApprovalNotificationWorkflow(tenantId: string): Promise<WorkflowDefinition> {
    return this.createWorkflow(tenantId, {
      name: 'Loan Approval Notification',
      trigger: 'LOAN_APPROVED',
      steps: [
        {
          order: 1,
          name: 'Validate',
          action: 'VALIDATE',
          parameters: {
            required_fields: ['customer_phone', 'customer_email'],
          },
        },
        {
          order: 2,
          name: 'Send SMS',
          action: 'SEND_SMS',
          parameters: {
            template_id: 'sms_loan_approved',
            to: '${customer_phone}',
            message: 'Your loan application has been approved! Check your account for details.',
          },
          condition: 'customer_phone != null',
        },
        {
          order: 3,
          name: 'Send Email',
          action: 'SEND_EMAIL',
          parameters: {
            template_id: 'email_loan_approved_detailed',
            to: '${customer_email}',
            subject: 'Your Loan Application Approved',
            include_attachment: 'amortization_schedule.pdf',
          },
          condition: 'customer_email != null',
        },
        {
          order: 4,
          name: 'Update Dashboard',
          action: 'UPDATE_FIELD',
          parameters: {
            entity: 'loan',
            field: 'customer_notified',
            value: true,
          },
        },
        {
          order: 5,
          name: 'Log Event',
          action: 'LOG_EVENT',
          parameters: {
            event_type: 'LOAN_APPROVAL_NOTIFIED',
            severity: 'INFO',
          },
        },
      ],
    });
  }

  /**
   * Example workflow: Charge fees on scheduled dates
   */
  createMonthlyFeeChargeWorkflow(tenantId: string): Promise<WorkflowDefinition> {
    return this.createWorkflow(tenantId, {
      name: 'Monthly Fee Charge',
      trigger: 'SCHEDULED_JOB_MONTHLY',
      steps: [
        {
          order: 1,
          name: 'Query Active Accounts',
          action: 'QUERY',
          parameters: {
            entity: 'account',
            filter: 'status = "ACTIVE"',
            batch_size: 1000,
          },
        },
        {
          order: 2,
          name: 'Calculate Fee',
          action: 'CALCULATE',
          parameters: {
            formula: 'account.product.monthly_fee',
          },
        },
        {
          order: 3,
          name: 'Charge Fee',
          action: 'CHARGE_FEE',
          parameters: {
            fee_type: 'ACCOUNT_MAINTENANCE',
            gl_account: '50100',  // Expense account
          },
          condition: 'fee_amount > 0',
        },
        {
          order: 4,
          name: 'Create Transaction',
          action: 'CREATE_TRANSACTION',
          parameters: {
            transaction_type: 'FEE_CHARGE',
          },
        },
        {
          order: 5,
          name: 'Generate Report',
          action: 'GENERATE_REPORT',
          parameters: {
            report_type: 'daily_fee_charge_summary',
            recipients: ['finance@institution.co.mz'],
          },
        },
      ],
    });
  }

  /**
   * Get all workflows for event
   */
  getWorkflowsByTrigger(tenantId: string, trigger: string): Promise<WorkflowDefinition[]> {
    return this.store.listWorkflowsByTrigger(tenantId, trigger);
  }

  /**
   * Execute workflow steps sequentially
   */
  async executeWorkflow(
    tenantId: string,
    workflowId: string,
    context: Record<string, any>
  ): Promise<{ success: boolean; results: any[] }> {
    const workflow = this.workflows.get(workflowId)
      || (await this.store.listWorkflows(tenantId)).find((candidate) => candidate.workflow_id === workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

    const results = [];

    for (const step of workflow.steps) {
      // Check condition
      if (step.condition && !this.evaluateCondition(step.condition, context)) {
        console.log(`  Step ${step.order} skipped (condition not met): ${step.name}`);
        continue;
      }

      console.log(`  Executing step ${step.order}: ${step.name}`);

      const result = await this.executeStep(step, context);
      results.push({
        step: step.name,
        status: result.success ? 'SUCCESS' : 'FAILED',
        data: result.data,
      });

      // Stop on critical failure
      if (!result.success && this.isCriticalStep(step)) {
        return { success: false, results };
      }
    }

    console.log(`✓ Workflow executed: ${workflowId}`);
    return { success: true, results };
  }

  private async executeStep(
    step: WorkflowStep,
    context: Record<string, any>
  ): Promise<{ success: boolean; data?: any }> {
    switch (step.action) {
      case 'SEND_SMS':
        return this.sendSMS(step.parameters);
      case 'SEND_EMAIL':
        return this.sendEmail(step.parameters);
      case 'UPDATE_FIELD':
        return this.updateField(step.parameters);
      case 'LOG_EVENT':
        return this.logEvent(step.parameters);
      case 'CHARGE_FEE':
        return this.chargeFee(step.parameters);
      case 'CALCULATE':
        return this.calculateValue(step.parameters, context);
      default:
        console.warn(`Unknown step action: ${step.action}`);
        return { success: true, data: { action: step.action, status: 'skipped' } };
    }
  }

  private async sendSMS(params: Record<string, any>): Promise<{ success: boolean }> {
    console.log(`    📱 SMS to ${params.to}: "${params.message}"`);
    // In production: integrate with SMS provider (Vonage, Twilio)
    return { success: true };
  }

  private async sendEmail(params: Record<string, any>): Promise<{ success: boolean }> {
    console.log(`    📧 Email to ${params.to}: ${params.subject}`);
    // In production: integrate with email provider (SendGrid, AWS SES)
    return { success: true };
  }

  private async updateField(params: Record<string, any>): Promise<{ success: boolean }> {
    console.log(`    🔄 Update ${params.entity}.${params.field} = ${params.value}`);
    // In production: UPDATE table SET field = value
    return { success: true };
  }

  private async logEvent(params: Record<string, any>): Promise<{ success: boolean }> {
    console.log(`    📝 Event: ${params.event_type} (${params.severity})`);
    // In production: INSERT into audit_log
    return { success: true };
  }

  private async chargeFee(params: Record<string, any>): Promise<{ success: boolean }> {
    console.log(`    💰 Charge fee: ${params.fee_type} to GL ${params.gl_account}`);
    // In production: POST transaction + GL entry
    return { success: true };
  }

  private async calculateValue(
    params: Record<string, any>,
    context: Record<string, any>
  ): Promise<{ success: boolean; data: any }> {
    const result = this.evaluateFormula(String(params.formula || ''), context);
    console.log(`    Calculated: ${params.formula} = ${result}`);
    return { success: true, data: result };
  }

  private evaluateCondition(condition: string, context: Record<string, any>): boolean {
    const expression = condition.trim();
    if (!expression) {
      return true;
    }

    for (const orPart of expression.split('||')) {
      const andParts = orPart.split('&&').map((part) => part.trim()).filter(Boolean);
      if (andParts.length && andParts.every((part) => this.evaluateConditionPart(part, context))) {
        return true;
      }
    }

    return false;
  }

  private evaluateConditionPart(part: string, context: Record<string, any>): boolean {
    const match = part.match(/^(.+?)\s*(===|!==|>=|<=|==|!=|>|<)\s*(.+)$/);
    if (!match) {
      return Boolean(this.resolveOperand(part, context));
    }

    const left = this.resolveOperand(match[1], context);
    const right = this.resolveOperand(match[3], context);

    switch (match[2]) {
      case '===':
      case '==':
        return left === right;
      case '!==':
      case '!=':
        return left !== right;
      case '>':
        return Number(left) > Number(right);
      case '<':
        return Number(left) < Number(right);
      case '>=':
        return Number(left) >= Number(right);
      case '<=':
        return Number(left) <= Number(right);
      default:
        return false;
    }
  }

  private evaluateFormula(formula: string, context: Record<string, any>): number {
    const tokens = this.tokenizeFormula(formula);
    const output: Array<string | number> = [];
    const operators: string[] = [];
    const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

    for (const token of tokens) {
      if (typeof token === 'number') {
        output.push(token);
      } else if (this.isPathToken(token)) {
        output.push(Number(this.resolvePath(context, token) || 0));
      } else if (token in precedence) {
        while (
          operators.length &&
          operators[operators.length - 1] !== '(' &&
          precedence[operators[operators.length - 1]] >= precedence[token]
        ) {
          output.push(operators.pop()!);
        }
        operators.push(token);
      } else if (token === '(') {
        operators.push(token);
      } else if (token === ')') {
        while (operators.length && operators[operators.length - 1] !== '(') {
          output.push(operators.pop()!);
        }
        if (operators.pop() !== '(') {
          throw new Error(`Invalid formula: ${formula}`);
        }
      } else {
        throw new Error(`Unsupported formula token: ${token}`);
      }
    }

    while (operators.length) {
      const operator = operators.pop()!;
      if (operator === '(') {
        throw new Error(`Invalid formula: ${formula}`);
      }
      output.push(operator);
    }

    const stack: number[] = [];
    for (const token of output) {
      if (typeof token === 'number') {
        stack.push(token);
        continue;
      }

      const right = stack.pop();
      const left = stack.pop();
      if (left === undefined || right === undefined) {
        throw new Error(`Invalid formula: ${formula}`);
      }

      switch (token) {
        case '+':
          stack.push(left + right);
          break;
        case '-':
          stack.push(left - right);
          break;
        case '*':
          stack.push(left * right);
          break;
        case '/':
          stack.push(right === 0 ? 0 : left / right);
          break;
        default:
          throw new Error(`Unsupported operator: ${token}`);
      }
    }

    if (stack.length !== 1 || Number.isNaN(stack[0])) {
      throw new Error(`Invalid formula: ${formula}`);
    }

    return Number(stack[0].toFixed(2));
  }

  private tokenizeFormula(formula: string): Array<string | number> {
    const tokens: Array<string | number> = [];
    const source = formula.trim();
    let index = 0;

    while (index < source.length) {
      const char = source[index];
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }

      const numberMatch = source.slice(index).match(/^\d+(\.\d+)?/);
      if (numberMatch) {
        tokens.push(Number(numberMatch[0]));
        index += numberMatch[0].length;
        continue;
      }

      const pathMatch = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
      if (pathMatch) {
        if (source[index + pathMatch[0].length] === '(') {
          throw new Error(`Invalid formula: ${formula}`);
        }
        tokens.push(pathMatch[0]);
        index += pathMatch[0].length;
        continue;
      }

      if ('+-*/()'.includes(char)) {
        tokens.push(char);
        index += 1;
        continue;
      }

      throw new Error(`Unsupported formula token at position ${index}`);
    }

    return tokens;
  }

  private resolveOperand(raw: string, context: Record<string, any>): any {
    const value = raw.trim();
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (value === 'undefined') return undefined;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    if (!this.isPathToken(value)) {
      throw new Error(`Unsupported condition operand: ${value}`);
    }
    return this.resolvePath(context, value);
  }

  private resolvePath(context: Record<string, any>, path: string): any {
    return path.split('.').reduce((current, key) => {
      if (current === undefined || current === null) {
        return undefined;
      }
      return current[key];
    }, context as any);
  }

  private isPathToken(value: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value);
  }

  private isCriticalStep(step: WorkflowStep): boolean {
    return ['CHARGE_FEE', 'CREATE_TRANSACTION', 'UPDATE_FIELD'].includes(step.action);
  }

  /**
   * Export schema as JSON (for version control, sharing)
   */
  async exportSchema(tenantId: string, entityId: string): Promise<any> {
    const schema = this.schemas.get(entityId) || await this.store.getSchema(tenantId, entityId);
    if (!schema) throw new Error(`Schema not found: ${entityId}`);

    return {
      entity_name: schema.entity_name,
      display_name: schema.display_name,
      fields: schema.fields,
    };
  }

  /**
   * Import schema from JSON (for replication, backup)
   */
  importSchema(tenantId: string, data: any): Promise<CustomEntitySchema> {
    return this.createEntitySchema(tenantId, data);
  }
}
