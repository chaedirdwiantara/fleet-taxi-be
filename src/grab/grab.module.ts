import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { GrabController } from './grab.controller';
import { GrabGridService } from './grab-grid.service';

@Module({
  imports: [UsersModule],
  controllers: [GrabController],
  providers: [GrabGridService],
  exports: [GrabGridService],
})
export class GrabModule {}
