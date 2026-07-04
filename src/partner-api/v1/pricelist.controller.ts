import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { PricelistService } from '../pricelist.service';
import { ApiKeyThrottlerGuard, RequireScopes, ScopesGuard } from '../scopes';

@ApiTags('partner-v1')
@ApiBearerAuth('partner-api-key')
@UseGuards(ApiKeyGuard, ScopesGuard, ApiKeyThrottlerGuard)
@Controller('partner/v1/pricelist')
export class PricelistController {
  constructor(private readonly pricelistService: PricelistService) {}

  @Get()
  @RequireScopes('pricelist')
  @ApiOperation({ summary: 'Route/car pricelist for the authenticated partner' })
  @ApiQuery({ name: 'pickupCode', example: 'BHISA_CAWANG' })
  @ApiQuery({ name: 'destinationCode', example: 'EVISTA_HALIM' })
  quote(
    @Query('pickupCode') pickupCode?: string,
    @Query('destinationCode') destinationCode?: string,
  ) {
    if (!pickupCode || !destinationCode) {
      throw new BadRequestException('pickupCode and destinationCode are required');
    }
    return this.pricelistService.quote(pickupCode, destinationCode);
  }
}
