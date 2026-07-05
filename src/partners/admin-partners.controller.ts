import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CheckPolicies } from '../common/decorators/check-policies.decorator';
import { PoliciesGuard } from '../common/guards/policies.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { UsersService } from '../users/users.service';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { CreatePartnerUserDto } from './dto/create-partner-user.dto';
import { CreatePartnerDto } from './dto/create-partner.dto';
import { PartnersService } from './partners.service';

@ApiTags('admin-partners')
@ApiCookieAuth('session')
@UseGuards(SessionGuard, PoliciesGuard)
@Controller('admin/partners')
export class AdminPartnersController {
  constructor(
    private readonly partnersService: PartnersService,
    private readonly usersService: UsersService,
    private readonly apiKeysService: ApiKeysService,
  ) {}

  @Post()
  @HttpCode(201)
  @CheckPolicies((a) => a.can('manage', 'Partner'))
  @ApiOperation({ summary: 'Create a partner entity (super_admin only)' })
  create(@Body() dto: CreatePartnerDto) {
    return this.partnersService.createPartner({ code: dto.code, name: dto.name, type: dto.type });
  }

  @Get()
  @CheckPolicies((a) => a.can('manage', 'Partner'))
  @ApiOperation({ summary: 'List partners (for the "pick existing partner" dropdown)' })
  list() {
    return this.partnersService.listPartners();
  }

  @Post(':id/users')
  @HttpCode(201)
  @CheckPolicies((a) => a.can('manage', 'User'))
  @ApiOperation({ summary: 'Create a partner-portal user linked to this partner' })
  async createUser(@Param('id', ParseIntPipe) id: number, @Body() dto: CreatePartnerUserDto) {
    await this.partnersService.requirePartner(id);
    return this.usersService.createUser({
      email: dto.email,
      fullName: dto.fullName,
      password: dto.password,
      roleNames: ['partner'],
      partnerId: id,
    });
  }

  @Post(':id/api-keys')
  @HttpCode(201)
  @CheckPolicies((a) => a.can('manage', 'ApiKey'))
  @ApiOperation({
    summary: 'Generate an external API key for this partner — rawKey returned ONCE',
  })
  async createApiKey(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateApiKeyDto) {
    await this.partnersService.requirePartner(id);
    const {
      rawKey,
      keyPrefix,
      id: apiKeyId,
    } = await this.apiKeysService.createKey({
      partnerId: id,
      label: dto.label,
      scopes: dto.scopes,
      rateLimit: dto.rateLimit,
    });
    // rawKey is shown exactly once and never stored/logged.
    return { id: apiKeyId, keyPrefix, rawKey };
  }
}
