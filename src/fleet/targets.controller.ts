import { BadRequestException, Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CheckPolicies } from '../common/decorators/check-policies.decorator';
import { PoliciesGuard } from '../common/guards/policies.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { Platform } from '../import/import.types';
import { UpsertGojekTargetDto, UpsertGrabTargetDto } from './dto/fleet.dto';
import { TargetsService } from './targets.service';

function parsePlatform(value: string): Platform {
  if (value === 'gojek' || value === 'grab') return value;
  throw new BadRequestException(`Unknown platform: ${value} (expected gojek|grab)`);
}

@ApiTags('admin-fleet-targets')
@ApiCookieAuth('session')
@UseGuards(SessionGuard, PoliciesGuard)
@Controller('admin/fleet/:platform/targets')
export class TargetsController {
  constructor(private readonly targetsService: TargetsService) {}

  @Get(':plate')
  @CheckPolicies((a) => a.can('read', 'FleetTarget'))
  @ApiParam({ name: 'platform', enum: ['gojek', 'grab'] })
  @ApiOperation({ summary: 'Read driver/target metadata for a plate' })
  get(@Param('platform') platformRaw: string, @Param('plate') plate: string) {
    return this.targetsService.get(parsePlatform(platformRaw), plate);
  }

  @Put(':plate')
  @CheckPolicies((a) => a.can('update', 'FleetTarget'))
  @ApiParam({ name: 'platform', enum: ['gojek', 'grab'] })
  @ApiOperation({ summary: 'Create/update driver/target metadata (upsert by plate)' })
  upsert(
    @Param('platform') platformRaw: string,
    @Param('plate') plate: string,
    @Body() dto: UpsertGojekTargetDto & UpsertGrabTargetDto,
  ) {
    const platform = parsePlatform(platformRaw);
    return platform === 'gojek'
      ? this.targetsService.upsertGojek(plate, dto)
      : this.targetsService.upsertGrab(plate, {
          rentalPartner: dto.rentalPartner,
          vehicleType: dto.vehicleType,
          city: dto.city,
        });
  }
}
