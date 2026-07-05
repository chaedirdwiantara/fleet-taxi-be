import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { CreatePlateDto } from './dto/create-plate.dto';
import { PortalPlatesService } from './portal-plates.service';
import { requirePartner } from './portal.util';

@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/plates')
export class PortalPlatesController {
  constructor(private readonly plates: PortalPlatesService) {}

  @Get()
  @ApiOperation({ summary: 'List own registered plates (Daftarkan Plat)' })
  list(@CurrentUser() user: SessionUser) {
    return this.plates.list(requirePartner(user));
  }

  @Post()
  @ApiOperation({ summary: 'Register a plate (nomor + Type) for the partner' })
  create(@CurrentUser() user: SessionUser, @Body() dto: CreatePlateDto) {
    return this.plates.create(requirePartner(user), dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove one own registered plate' })
  remove(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.plates.remove(requirePartner(user), id);
  }
}
