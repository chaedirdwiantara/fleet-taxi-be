import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UploadedFile as UploadedFileDecorator,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CheckPolicies } from '../common/decorators/check-policies.decorator';
import { PoliciesGuard } from '../common/guards/policies.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { SessionUser } from '../auth/session.types';
import { CreateImportDto } from './dto/create-import.dto';
import { ImportService, UploadedFile } from './import.service';
import { parsePlatform } from './import.types';

@ApiTags('admin-fleet-imports')
@ApiCookieAuth('session')
@UseGuards(SessionGuard, PoliciesGuard)
@Controller('admin/fleet/:platform/imports')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post()
  @HttpCode(202)
  @CheckPolicies((a) => a.can('create', 'FleetImport'))
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'platform', enum: ['gojek', 'grab'] })
  @ApiOperation({ summary: 'Upload a CSV/XLSX for a period — parsed asynchronously' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'month', 'year'],
      properties: {
        file: { type: 'string', format: 'binary' },
        month: { type: 'integer', example: 7 },
        year: { type: 'integer', example: 2026 },
      },
    },
  })
  async upload(
    @Param('platform') platformRaw: string,
    @UploadedFileDecorator() file: UploadedFile | undefined,
    @Body() dto: CreateImportDto,
    @CurrentUser() user: SessionUser,
  ): Promise<{ importId: number }> {
    if (!file) throw new BadRequestException('file is required (multipart field "file")');
    return this.importService.upload(
      parsePlatform(platformRaw),
      file,
      dto.month,
      dto.year,
      user.id,
    );
  }

  @Get()
  @CheckPolicies((a) => a.can('read', 'FleetImport'))
  @ApiParam({ name: 'platform', enum: ['gojek', 'grab'] })
  @ApiOperation({ summary: 'List import batches' })
  list(@Param('platform') platformRaw: string) {
    return this.importService.list(parsePlatform(platformRaw));
  }

  @Get(':id')
  @CheckPolicies((a) => a.can('read', 'FleetImport'))
  @ApiParam({ name: 'platform', enum: ['gojek', 'grab'] })
  @ApiOperation({ summary: 'Import status/progress (also streamed via Socket.IO /rt)' })
  getById(@Param('platform') platformRaw: string, @Param('id', ParseIntPipe) id: number) {
    return this.importService.getById(parsePlatform(platformRaw), id);
  }

  @Delete(':id')
  @HttpCode(202)
  @CheckPolicies((a) => a.can('delete', 'FleetImport'))
  @ApiParam({ name: 'platform', enum: ['gojek', 'grab'] })
  @ApiOperation({ summary: 'Rollback a whole import batch (queued)' })
  rollback(@Param('platform') platformRaw: string, @Param('id', ParseIntPipe) id: number) {
    return this.importService.requestRollback(parsePlatform(platformRaw), id);
  }
}
