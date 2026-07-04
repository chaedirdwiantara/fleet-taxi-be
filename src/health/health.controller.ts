import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

class HealthDto {
  status!: 'ok';
  uptimeSeconds!: number;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Liveness check' })
  @ApiOkResponse({ type: HealthDto })
  check(): HealthDto {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }
}
