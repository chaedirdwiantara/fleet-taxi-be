import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ACTIVITY_ACTIONS, ActivityLogService } from '../activity-log/activity-log.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SessionUser } from './session.types';

/**
 * Shared password-change surface for any authenticated human session (admin or
 * partner portal). Used both for the forced first-login change and voluntary
 * self-service changes.
 */
@ApiTags('auth')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('auth')
export class ChangePasswordController {
  constructor(
    private readonly authService: AuthService,
    private readonly activityLog: ActivityLogService,
  ) {}

  @Post('change-password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change the current session user’s password (clears mustChangePassword)',
  })
  async changePassword(
    @CurrentUser() user: SessionUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<SessionUser> {
    const updated = await this.authService.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
    // Reflect the cleared flag in the live session so the FE gate lifts — in
    // whichever audience slot holds this account (admin or partner).
    if (req.session.adminUser?.id === updated.id) req.session.adminUser = updated;
    if (req.session.partnerUser?.id === updated.id) req.session.partnerUser = updated;
    this.activityLog.record({
      audience: updated.partnerId != null ? 'partner' : 'admin',
      actorId: updated.id,
      actorEmail: updated.email,
      actorName: updated.fullName,
      partnerId: updated.partnerId,
      action: ACTIVITY_ACTIONS.passwordChange,
      method: 'POST',
      path: req.path,
      status: 'success',
      statusCode: 200,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    return updated;
  }
}
