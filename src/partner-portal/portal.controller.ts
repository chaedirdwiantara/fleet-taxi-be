import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { LoginDto } from '../auth/dto/login.dto';
import { destroySession, regenerateSession, saveSession } from '../auth/session-ops';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePagination } from '../common/util/pagination';
import { PortalExportService } from './export.service';
import { PortalOrdersService } from './portal-orders.service';
import { requirePartner } from './portal.util';

@ApiTags('partner-portal')
@Controller('partner/portal')
export class PortalController {
  constructor(
    private readonly authService: AuthService,
    private readonly ordersService: PortalOrdersService,
    private readonly exportService: PortalExportService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Partner portal login — sets the session cookie' })
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<SessionUser> {
    const user = await this.authService.validateCredentials(dto.email, dto.password);
    // Same message as bad credentials: don't reveal that the account exists
    if (!user.roles.includes('partner') || user.partnerId == null) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // Regenerate against fixation, but carry any coexisting admin session across
    // so a partner login doesn't log the admin out.
    const adminUser = req.session.adminUser;
    await regenerateSession(req);
    if (adminUser) req.session.adminUser = adminUser;
    req.session.partnerUser = user;
    return user;
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  async logout(@Req() req: Request): Promise<{ loggedOut: true }> {
    delete req.session.partnerUser;
    if (req.session.adminUser) {
      await saveSession(req);
    } else {
      await destroySession(req);
    }
    return { loggedOut: true };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Current partner user + partner profile' })
  async me(@CurrentUser() user: SessionUser) {
    const partnerId = requirePartner(user);
    const partner = await this.ordersService.partnerProfile(partnerId);
    return { user, partner };
  }

  @Get('dashboard')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Partner metrics/summary widgets (own data only)' })
  dashboard(@CurrentUser() user: SessionUser) {
    return this.ordersService.dashboard(requirePartner(user));
  }

  @Get('orders')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'List own orders (paginated, filterable)' })
  @ApiQuery({ name: 'page', type: Number, required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', type: Number, required: false, example: 50 })
  @ApiQuery({ name: 'tripStatus', required: false })
  orders(
    @CurrentUser() user: SessionUser,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @Query('tripStatus') tripStatus?: string,
  ) {
    const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);
    return this.ordersService.list(requirePartner(user), { page, pageSize, tripStatus });
  }

  @Get('orders/export')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Export own orders (?format=pdf|xlsx)' })
  @ApiQuery({ name: 'format', enum: ['xlsx', 'pdf'] })
  async export(
    @CurrentUser() user: SessionUser,
    @Query('format') format?: string,
  ): Promise<StreamableFile> {
    const partnerId = requirePartner(user);
    if (format !== 'xlsx' && format !== 'pdf') {
      throw new BadRequestException('format must be xlsx or pdf');
    }
    const [partner, rows] = await Promise.all([
      this.ordersService.partnerProfile(partnerId),
      this.ordersService.allForExport(partnerId),
    ]);
    const filename = `orders-${partner.code.toLowerCase()}.${format}`;
    const buffer =
      format === 'xlsx'
        ? await this.exportService.ordersToXlsx(partner.name, rows)
        : await this.exportService.ordersToPdf(partner.name, rows);
    return new StreamableFile(buffer, {
      type:
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get('orders/:id')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'One own order detail (403 for another partner’s order)' })
  order(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.ordersService.detail(requirePartner(user), id);
  }
}
