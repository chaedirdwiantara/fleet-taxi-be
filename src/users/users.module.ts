import { Module } from '@nestjs/common';
import { AbilityFactory } from './casl/ability.factory';
import { UsersService } from './users.service';

@Module({
  providers: [UsersService, AbilityFactory],
  exports: [UsersService, AbilityFactory],
})
export class UsersModule {}
