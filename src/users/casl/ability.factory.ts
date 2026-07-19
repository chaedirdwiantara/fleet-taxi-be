import { AbilityBuilder, createMongoAbility, MongoAbility } from '@casl/ability';
import { Injectable } from '@nestjs/common';
import { SessionUser } from '../../auth/session.types';

export type Action = 'manage' | 'create' | 'read' | 'update' | 'delete';

/**
 * Subjects are plain strings; condition matching uses the object passed to
 * ability.can() via casl's subject() helper.
 */
export type SubjectName =
  | 'Order'
  | 'FleetImport'
  | 'FleetTarget'
  | 'FleetException'
  | 'GrabImport'
  | 'GrabTarget'
  | 'Partner'
  | 'User'
  | 'ApiKey'
  // Only super_admin's blanket `manage all` grants this — the audit log is
  // deliberately invisible to plain admins.
  | 'ActivityLog'
  | 'all';

export type AppAbility = MongoAbility<[Action, SubjectName | Record<string, unknown>]>;

const FLEET_SUBJECTS: SubjectName[] = [
  'FleetImport',
  'FleetTarget',
  'FleetException',
  'GrabImport',
  'GrabTarget',
];

@Injectable()
export class AbilityFactory {
  createForUser(user: SessionUser): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

    if (user.roles.includes('super_admin')) {
      can('manage', 'all');
    } else if (user.roles.includes('admin')) {
      for (const s of FLEET_SUBJECTS) can('manage', s);
      can('read', 'Order');
      can('read', 'Partner');
    }

    if (user.roles.includes('partner') && user.partnerId != null) {
      // Row-scoped: a partner can NEVER touch another partner's rows
      can('read', 'Order', { partnerId: user.partnerId });
      can('create', 'Order', { partnerId: user.partnerId });
      can('read', 'Partner', { id: user.partnerId });
    }

    return build();
  }
}
