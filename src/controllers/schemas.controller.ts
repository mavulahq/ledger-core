import { Body, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { SchemaManagerService } from '../schema-manager/schema-manager.service';

@Controller('schemas')
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
  async create(@Req() req: any, @Body() body: any) {
    return this.schemas.createEntitySchema(this.tenant(req), body);
  }

  @Post('import')
  async import(@Req() req: any, @Body() body: any) {
    return this.schemas.importSchema(this.tenant(req), body);
  }

  @Post('presets/business-registration')
  async createBusinessRegistration(@Req() req: any) {
    return this.schemas.createBusinessRegistrationSchema(this.tenant(req));
  }

  private tenant(req: any): string {
    return req.tenantId || 'public';
  }
}
