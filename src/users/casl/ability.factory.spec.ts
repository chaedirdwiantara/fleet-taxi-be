import { subject } from '@casl/ability';
import { describe, expect, it } from 'vitest';
import { AbilityFactory } from './ability.factory';

const factory = new AbilityFactory();

const partnerUser = (partnerId: number) => ({
  id: 10,
  email: 'p@x.example',
  fullName: null,
  roles: ['partner'],
  partnerId,
});

describe('AbilityFactory (row-scoped RBAC)', () => {
  it('super_admin can manage everything', () => {
    const ability = factory.createForUser({
      id: 1,
      email: 'root@x',
      fullName: null,
      roles: ['super_admin'],
      partnerId: null,
    });
    expect(ability.can('manage', 'FleetImport')).toBe(true);
    expect(ability.can('delete', subject('Order', { partnerId: 99 }))).toBe(true);
  });

  it('admin can manage fleet subjects but not manage partners', () => {
    const ability = factory.createForUser({
      id: 2,
      email: 'admin@x',
      fullName: null,
      roles: ['admin'],
      partnerId: null,
    });
    expect(ability.can('manage', 'FleetImport')).toBe(true);
    expect(ability.can('manage', 'GrabTarget')).toBe(true);
    expect(ability.can('read', 'Order')).toBe(true);
    expect(ability.can('update', 'Partner')).toBe(false);
    expect(ability.can('manage', 'all')).toBe(false);
  });

  it('partner can only read/create own orders — NEVER another partner’s', () => {
    const ability = factory.createForUser(partnerUser(7));
    expect(ability.can('read', subject('Order', { partnerId: 7 }))).toBe(true);
    expect(ability.can('create', subject('Order', { partnerId: 7 }))).toBe(true);
    expect(ability.can('read', subject('Order', { partnerId: 8 }))).toBe(false);
    expect(ability.can('create', subject('Order', { partnerId: 8 }))).toBe(false);
    expect(ability.can('read', subject('Partner', { id: 8 }))).toBe(false);
    expect(ability.can('manage', 'FleetImport')).toBe(false);
  });

  it('partner role without partnerId gets no partner abilities', () => {
    const ability = factory.createForUser({ ...partnerUser(7), partnerId: null });
    expect(ability.can('read', subject('Order', { partnerId: 7 }))).toBe(false);
  });
});
