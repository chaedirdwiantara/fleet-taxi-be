import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CheckPolicies } from '../common/decorators/check-policies.decorator';
import { PoliciesGuard } from '../common/guards/policies.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePagination } from '../common/util/pagination';
import { SessionUser } from '../auth/session.types';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@ApiTags('admin-users')
@ApiCookieAuth('session')
@UseGuards(SessionGuard, PoliciesGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @HttpCode(201)
  @CheckPolicies((a) => a.can('manage', 'User'))
  @ApiOperation({ summary: 'Create an admin/staff user (super_admin only)' })
  create(@Body() dto: CreateAdminUserDto) {
    return this.usersService.createUser({
      email: dto.email,
      fullName: dto.fullName,
      password: dto.password,
      roleNames: dto.roles,
      partnerId: null,
    });
  }

  @Get()
  @CheckPolicies((a) => a.can('manage', 'User'))
  @ApiOperation({
    summary: 'List admin/staff (type=admin) or partner-portal (type=partner) users',
  })
  async list(@Query() query: ListUsersQueryDto) {
    const type = query.type ?? 'admin';
    const { page, pageSize } = parsePagination(query.page, query.pageSize);
    const { data, total } = await this.usersService.listUsers(type, page, pageSize);
    return { data, meta: { page, pageSize, total } };
  }

  @Patch(':id')
  @CheckPolicies((a) => a.can('manage', 'User'))
  @ApiOperation({ summary: 'Edit an account (name/email/roles/partner/active/password)' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    return this.usersService.updateUser(id, {
      email: dto.email,
      fullName: dto.fullName,
      isActive: dto.isActive,
      roles: dto.roles,
      partnerId: dto.partnerId,
      password: dto.password,
    });
  }

  @Delete(':id')
  @CheckPolicies((a) => a.can('manage', 'User'))
  @ApiOperation({ summary: 'Delete an account (self / last super_admin blocked)' })
  remove(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.usersService.deleteUser(user.id, id);
  }
}
