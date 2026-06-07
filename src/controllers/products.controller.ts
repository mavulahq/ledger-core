import { Body, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { ProductConfigService, ProductType } from '../products/product-config.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductConfigService) {}

  @Get()
  async list(@Req() req: any) {
    return this.products.listProducts(this.tenant(req));
  }

  @Get('config')
  async getTenantConfig(@Req() req: any) {
    const config = await this.products.getTenantConfig(this.tenant(req));
    if (!config) {
      throw new NotFoundException('Tenant product configuration not found');
    }
    return config;
  }

  @Get(':productId')
  async get(@Req() req: any, @Param('productId') productId: string) {
    const product = await this.products.getProduct(this.tenant(req), productId);
    if (!product) {
      throw new NotFoundException(`Product not found: ${productId}`);
    }
    return product;
  }

  @Post()
  async upsert(@Req() req: any, @Body() body: any) {
    return this.products.createOrUpdateProduct(
      this.tenant(req),
      body.type as ProductType,
      body.config || body,
    );
  }

  @Post('config/generate')
  async generateTenantConfig(@Req() req: any, @Body() body: any) {
    return this.products.generateTenantConfigSchema(
      this.tenant(req),
      body.jurisdiction || 'SADC',
    );
  }

  private tenant(req: any): string {
    return req.tenantId || 'public';
  }
}
