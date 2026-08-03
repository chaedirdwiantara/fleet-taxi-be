import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AdminPlatesController } from './admin-plates.controller';
import { AdminPlatesService } from './admin-plates.service';

// UsersModule provides AbilityFactory, which PoliciesGuard injects.
@Module({
  imports: [UsersModule],
  controllers: [AdminPlatesController],
  providers: [AdminPlatesService],
  exports: [AdminPlatesService],
})
export class AdminPlatesModule {}
