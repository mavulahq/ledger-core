import { Body, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { SchemaManagerService } from '../schema-manager/schema-manager.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CreateSchemaV1Dto } from '../dto/public.dto';

@Controller('schemas')
@RequirePermissions('finance.read')
export class SchemasController {
  constructor(private readonly schemas: SchemaManagerService) {}

  @Get()
  async list(@Req() req: any) {
    return this.schemas.listEntitySchemas(this.tenant(req));
  }

  @Get(':schemaId')
  async get(@Req() req: any, @Param('schemaId') schemaId: string) {
    const schema = await this.schemas.getEntitySchema(this.tenant(req), schemaId);
    if (!schema) {
      throw new NotFoundException(`Schema not found: ${schemaId}`);
    }
    return schema;
  }

  @Get(':schemaId/export')
  async export(@Req() req: any, @Param('schemaId') schemaId: string) {
    return this.schemas.exportSchema(this.tenant(req), schemaId);
  }

  @Post()
  @RequirePermissions('configuration.write')
  async create(@Req() req: any, @Body() body: CreateSchemaV1Dto) {
    return this.schemas.createEntitySchema(this.tenant(req), body);
  }

  @Post('import')
  @RequirePermissions('configuration.write')
  async import(@Req() req: any, @Body() body: CreateSchemaV1Dto) {
    return this.schemas.importSchema(this.tenant(req), body);
  }

  @Post('presets/business-registration')
  @RequirePermissions('configuration.write')
  async createBusinessRegistration(@Req() req: any) {
    return this.schemas.createBusinessRegistrationSchema(this.tenant(req));
  }

  private tenant(req: any): string {
    return req.tenantId;
  }
}
