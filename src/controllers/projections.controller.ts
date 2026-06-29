import { Controller, Get, NotFoundException, Param, Req } from '@nestjs/common';
import { ReadProjectionService } from '../read-models/read-projection.service';
import { ReadProjectionName } from '../read-models/read-projection.types';

@Controller('projections')
export class ProjectionsController {
  constructor(private readonly projections: ReadProjectionService) {}

  @Get('status')
  status(@Req() req: any) {
    return this.projections.status(this.tenant(req));
  }

  @Get('loan-activity')
  loanActivity(@Req() req: any) {
    return this.projections.list(this.tenant(req), 'loan_activity');
  }

  @Get('loan-activity/:loanId')
  async loanActivityDetails(@Req() req: any, @Param('loanId') loanId: string) {
    return this.requireProjection(this.tenant(req), 'loan_activity', loanId);
  }

  @Get('ledger-activity')
  ledgerActivity(@Req() req: any) {
    return this.projections.list(this.tenant(req), 'ledger_activity');
  }

  @Get('ledger-activity/:journalEntryId')
  async ledgerActivityDetails(
    @Req() req: any,
    @Param('journalEntryId') journalEntryId: string,
  ) {
    return this.requireProjection(this.tenant(req), 'ledger_activity', journalEntryId);
  }

  @Get('product-publications')
  productPublications(@Req() req: any) {
    return this.projections.list(this.tenant(req), 'product_publication');
  }

  @Get('product-publications/:productId')
  async productPublicationDetails(@Req() req: any, @Param('productId') productId: string) {
    return this.requireProjection(this.tenant(req), 'product_publication', productId);
  }

  private async requireProjection(
    tenantId: string,
    projectionName: ReadProjectionName,
    entityId: string,
  ) {
    const projection = await this.projections.get(tenantId, projectionName, entityId);
    if (!projection) {
      throw new NotFoundException(`Projection not found: ${projectionName}/${entityId}`);
    }
    return projection;
  }

  private tenant(req: any): string {
    return req.tenantId || 'public';
  }
}
