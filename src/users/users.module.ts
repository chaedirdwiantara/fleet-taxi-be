import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin-users.controller';
import { AbilityFactory } from './casl/ability.factory';
import { UsersService } from './users.service';

@Module({
  controllers: [AdminUsersController],
  providers: [UsersService, AbilityFactory],
  exports: [UsersService, AbilityFactory],
})
export class UsersModule {}
