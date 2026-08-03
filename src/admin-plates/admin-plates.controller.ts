import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CheckPolicies } from '../common/decorators/check-policies.decorator';
import { PoliciesGuard } from '../common/guards/policies.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { AdminPlatesService } from './admin-plates.service';
import { AdminPlateDto } from './dto/admin-plate.dto';

/**
 * Admin console "Plate Registration" — the admin's own plate registry, mirroring
 * the partner portal's Daftarkan Plat. Registering here widens the admin fleet
 * scope so vehicles no partner registered become visible; it never widens what a
 * partner sees. super_admin only: 'PlateRegistry' is granted solely by
 * `manage all` (see AbilityFactory).
 */
@ApiTags('admin-plates')
@ApiCookieAuth('session')
@UseGuards(SessionGuard, PoliciesGuard)
@Controller('admin/plates')
export class AdminPlatesController {
  constructor(private readonly plates: AdminPlatesService) {}

  @Get()
  @CheckPolicies((a) => a.can('manage', 'PlateRegistry'))
  @ApiOperation({
    summary: 'List admin-registered plates, with the partner that claimed each (super_admin only)',
  })
  list() {
    return this.plates.list();
  }

  @Post()
  @CheckPolicies((a) => a.can('manage', 'PlateRegistry'))
  @ApiOperation({ summary: 'Register a plate (nomor + Type) for the admin console' })
  create(@Body() dto: AdminPlateDto) {
    return this.plates.create(dto);
  }

  @Put(':id')
  @CheckPolicies((a) => a.can('manage', 'PlateRegistry'))
  @ApiOperation({ summary: 'Edit one admin-registered plate (nomor + Type)' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: AdminPlateDto) {
    return this.plates.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((a) => a.can('manage', 'PlateRegistry'))
  @ApiOperation({ summary: 'Remove one admin-registered plate' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.plates.remove(id);
  }
}
