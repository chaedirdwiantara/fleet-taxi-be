import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { parsePagination } from '../../common/util/pagination';
import { CreatePartnerOrderDto } from '../dto/partner-api.dto';
import { PartnerOrdersService } from '../partner-orders.service';
import { ApiKeyThrottlerGuard, RequireScopes, ScopesGuard } from '../scopes';

@ApiTags('partner-v1')
@ApiBearerAuth('partner-api-key')
@UseGuards(ApiKeyGuard, ScopesGuard, ApiKeyThrottlerGuard)
@Controller('partner/v1/orders')
export class PartnerOrdersController {
  constructor(private readonly ordersService: PartnerOrdersService) {}

  @Post()
  @HttpCode(201)
  @RequireScopes('order:create')
  @ApiOperation({ summary: 'Create an order (replaces legacy GET /partner/v1/order/create)' })
  create(@Body() dto: CreatePartnerOrderDto, @Req() req: Request) {
    return this.ordersService.create(req.partner!.id, dto);
  }

  @Get()
  @RequireScopes('order:read')
  @ApiOperation({ summary: 'Order history for the authenticated partner' })
  @ApiQuery({ name: 'page', type: Number, required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', type: Number, required: false, example: 50 })
  list(
    @Req() req: Request,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ) {
    const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);
    return this.ordersService.list(req.partner!.id, page, pageSize);
  }

  @Get(':id')
  @RequireScopes('order:read')
  @ApiOperation({ summary: "One order's detail (own orders only — 404 for any other order)" })
  detail(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.ordersService.detail(req.partner!.id, id);
  }
}
