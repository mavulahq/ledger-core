import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductType } from '../products/product-config.service';

export class CreateAccountV1Dto {
  @IsString() @IsNotEmpty() @MaxLength(128) customer_id!: string;
  @IsString() @IsNotEmpty() @MaxLength(128) product_id!: string;
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
}

export class AccountStatementQueryV1Dto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class CreateAccountStatusTransitionV1Dto {
  @IsIn(['FREEZE', 'UNFREEZE', 'CLOSE'])
  transition!: 'FREEZE' | 'UNFREEZE' | 'CLOSE';
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

export class AccountLifecycleListQueryV1Dto {
  @IsOptional() @IsString() @MaxLength(128) account_id?: string;
  @IsOptional() @IsIn(['PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'FAILED'])
  status?: 'PENDING_APPROVAL' | 'APPLIED' | 'REJECTED' | 'FAILED';
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class ApproveAccountLifecycleV1Dto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class RejectAccountLifecycleV1Dto {
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

export class UpsertProductV1Dto {
  @IsEnum(ProductType) type!: ProductType;
  @IsObject() config!: Record<string, unknown>;
}

export class GenerateTenantConfigV1Dto {
  @IsString() @Matches(/^[A-Z][A-Z0-9_-]{1,15}$/) jurisdiction!: string;
}

export class CreateRuleV1Dto {
  @IsOptional() @IsString() @MaxLength(128) id?: string;
  @IsString() @IsNotEmpty() rule_type!: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) condition!: string;
  @IsObject() action!: Record<string, unknown>;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) applies_to?: string[];
}

export class UpdateRuleV1Dto {
  @IsOptional() @IsString() @MaxLength(2000) condition?: string;
  @IsOptional() @IsObject() action?: Record<string, unknown>;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) applies_to?: string[];
}

export class FieldDefinitionV1Dto {
  @IsString() @IsNotEmpty() name!: string;
  @IsIn(['STRING', 'NUMBER', 'DATE', 'BOOLEAN', 'ENUM', 'REFERENCE'])
  type!: 'STRING' | 'NUMBER' | 'DATE' | 'BOOLEAN' | 'ENUM' | 'REFERENCE';
  @IsBoolean() required!: boolean;
  @IsOptional() @IsInt() @Min(1) maxLength?: number;
  @IsOptional() @IsString() pattern?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) enum_values?: string[];
  @IsOptional() @IsString() reference_table?: string;
  @IsOptional() default?: unknown;
  @IsOptional() @IsString() description?: string;
}

export class CreateSchemaV1Dto {
  @IsString() @Matches(/^[a-z][a-z0-9_]{1,63}$/) entity_name!: string;
  @IsString() @IsNotEmpty() @MaxLength(160) display_name!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => FieldDefinitionV1Dto) fields!: FieldDefinitionV1Dto[];
}

export class WorkflowStepV1Dto {
  @IsInt() @Min(1) order!: number;
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsNotEmpty() action!: string;
  @IsObject() parameters!: Record<string, unknown>;
  @IsOptional() @IsString() condition?: string;
}

export class CreateWorkflowV1Dto {
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsString() @Matches(/^[A-Z][A-Z0-9_]{2,100}$/) trigger!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => WorkflowStepV1Dto) steps!: WorkflowStepV1Dto[];
}

export class ExecuteWorkflowV1Dto {
  @IsObject() context!: Record<string, unknown>;
}
