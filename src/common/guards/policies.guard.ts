import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AbilityFactory } from '../../users/casl/ability.factory';
import { CHECK_POLICIES_KEY, PolicyHandler } from '../decorators/check-policies.decorator';

/**
 * Evaluates CASL policies declared with @CheckPolicies. Must run AFTER
 * SessionGuard (which attaches req.user). Attaches the built ability to the
 * request so services can do row-level checks.
 */
@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly abilityFactory: AbilityFactory,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const handlers =
      this.reflector.getAllAndOverride<PolicyHandler[]>(CHECK_POLICIES_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? [];

    const req = ctx.switchToHttp().getRequest<Request & { ability?: unknown }>();
    if (!req.user) throw new ForbiddenException('No authenticated user');

    const ability = this.abilityFactory.createForUser(req.user);
    req.ability = ability;

    if (!handlers.every((h) => h(ability))) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
