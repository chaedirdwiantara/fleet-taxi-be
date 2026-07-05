import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ChangePasswordController } from './change-password.controller';

@Module({
  imports: [UsersModule],
  controllers: [AuthController, ChangePasswordController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
