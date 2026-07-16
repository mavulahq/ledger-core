import { Body, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { ProductConfigService, ProductType } from '../products/product-config.service';
import { RequirePermissions } from '../auth/permissions.decorator';
import { GenerateTenantConfigV1Dto, UpsertProductV1Dto } from '../dto/public.dto';
import { IdempotentOperation } from '../idempotency/idempotent-operation.decorator';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductConfigService) {}

  @Get()
  @RequirePermissions('finance.read')
  async list(@Req() req: any) {
    return this.products.listProducts(this.tenant(req));
  }

  @Get('config')
  @RequirePermissions('finance.read')
  async getTenantConfig(@Req() req: any) {
    const config = await this.products.getTenantConfig(this.tenant(req));
    if (!config) {
      throw new NotFoundException('Tenant product configuration not found');
    }
    return config;
  }

  @Get(':productId')
  @RequirePermissions('finance.read')
  async get(@Req() req: any, @Param('productId') productId: string) {
    const product = await this.products.getProduct(this.tenant(req), productId);
    if (!product) {
      throw new NotFoundException(`Product not found: ${productId}`);
    }
    return product;
  }

  @Post()
  @RequirePermissions('configuration.write')
  @IdempotentOperation('products.upsert')
  async upsert(@Req() req: any, @Body() body: UpsertProductV1Dto) {
    return this.products.createOrUpdateProduct(
      this.tenant(req),
      body.type as ProductType,
      body.config,
    );
  }

  @Post('config/generate')
  @RequirePermissions('configuration.write')
  @IdempotentOperation('products.config.generate')
  async generateTenantConfig(@Req() req: any, @Body() body: GenerateTenantConfigV1Dto) {
    return this.products.generateTenantConfigSchema(
      this.tenant(req),
      body.jurisdiction,
    );
  }

  private tenant(req: any): string {
    return req.tenantId;
  }
}
