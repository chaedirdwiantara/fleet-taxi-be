import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CheckPolicies } from '../common/decorators/check-policies.decorator';
import { PoliciesGuard } from '../common/guards/policies.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePlatform } from '../import/import.types';
import { UpsertTargetDto } from './dto/fleet.dto';
import { TargetsService } from './targets.service';

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
    @Body() dto: UpsertTargetDto,
  ) {
    const platform = parsePlatform(platformRaw);
    return platform === 'gojek'
      ? this.targetsService.upsertGojek(plate, {
          fleetTarget: dto.fleetTarget,
          rentalPartner: dto.rentalPartner,
          deliveryBatch: dto.deliveryBatch,
          serviceArea: dto.serviceArea,
          vehicleType: dto.vehicleType,
          regionId: dto.regionId,
        })
      : this.targetsService.upsertGrab(plate, {
          rentalPartner: dto.rentalPartner,
          vehicleType: dto.vehicleType,
          city: dto.city,
        });
  }
}
