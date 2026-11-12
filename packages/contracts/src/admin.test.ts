import { describe, expect, it } from 'vitest';
import {
  AcceptInvitationRequestSchema,
  AssignRoleRequestSchema,
  CounterServiceCapabilityRequestSchema,
  CreateFacilityRequestSchema,
  CreateOrganizationRequestSchema,
  CreateServiceRequestSchema,
  InviteStaffRequestSchema,
  LoginRequestSchema,
  UpdateServiceRequestSchema,
} from './admin.js';

const validOrg = {
  organization_name: 'Acme Health',
  organization_slug: 'acme-health',
  admin_display_name: 'Ada Admin',
  admin_email: '  Ada@Example.COM ',
  admin_password: 'correct-horse-battery-1',
};

describe('CreateOrganizationRequestSchema', () => {
  it('accepts valid input and normalizes email (trim + lowercase)', () => {
    const r = CreateOrganizationRequestSchema.parse(validOrg);
    expect(r.admin_email).toBe('ada@example.com');
  });

  it.each([
    ['password under 12 chars', { admin_password: 'elevenchars' }],
    ['password over 128 chars', { admin_password: 'x'.repeat(129) }],
    ['slug with uppercase', { organization_slug: 'Acme' }],
    ['slug with underscores', { organization_slug: 'acme_health' }],
    ['slug with double hyphen', { organization_slug: 'acme--health' }],
    ['slug too short', { organization_slug: 'ab' }],
    ['not an email', { admin_email: 'nope' }],
    ['unknown field organization_id', { organization_id: '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b' }],
  ])('rejects %s', (_label, patch) => {
    expect(CreateOrganizationRequestSchema.safeParse({ ...validOrg, ...patch }).success).toBe(
      false,
    );
  });
});

describe('facility / service / counter schemas', () => {
  it('defaults timezone to UTC and rejects unknown zones', () => {
    expect(CreateFacilityRequestSchema.parse({ name: 'Main', slug: 'main' }).timezone).toBe('UTC');
    expect(
      CreateFacilityRequestSchema.safeParse({ name: 'Main', slug: 'main', timezone: 'Not/AZone' })
        .success,
    ).toBe(false);
    expect(
      CreateFacilityRequestSchema.safeParse({
        name: 'Main',
        slug: 'main',
        timezone: 'Africa/Lagos',
      }).success,
    ).toBe(true);
  });

  it('applies the published default FIFO policy', () => {
    const s = CreateServiceRequestSchema.parse({ name: 'Registration' });
    expect(s.policy).toEqual({
      version: 'v1',
      priority_order: ['normal'],
      grace_window_seconds: 300,
      // M4: configured override reasons and transfer placement are part of the published policy
      override_reasons: [
        'accessibility_need',
        'urgent_need',
        'returning_visitor',
        'administrative_error',
      ],
      transfer_placement: 'by_original_join_time',
    });
  });

  it('validates override reason codes and transfer placement (M4)', () => {
    const ok = (policy: unknown): boolean =>
      CreateServiceRequestSchema.safeParse({ name: 'Svc', policy }).success;
    expect(ok({ override_reasons: ['wheelchair_user'] })).toBe(true);
    expect(ok({ override_reasons: [] })).toBe(false);
    expect(ok({ override_reasons: ['Has Spaces'] })).toBe(false);
    expect(ok({ override_reasons: ['dup', 'dup'] })).toBe(false);
    expect(ok({ override_reasons: Array.from({ length: 13 }, (_, i) => `r${i}x`) })).toBe(false);
    expect(ok({ transfer_placement: 'end_of_queue' })).toBe(true);
    expect(ok({ transfer_placement: 'jump_ahead' })).toBe(false);
  });

  it('validates priority_order: must include normal, no repeats, known classes only', () => {
    const base = { name: 'Svc' };
    const ok = CreateServiceRequestSchema.safeParse({
      ...base,
      policy: { priority_order: ['urgent', 'normal'] },
    });
    expect(ok.success).toBe(true);
    for (const priority_order of [['urgent'], ['normal', 'normal'], ['vip', 'normal'], []]) {
      expect(
        CreateServiceRequestSchema.safeParse({ ...base, policy: { priority_order } }).success,
      ).toBe(false);
    }
  });

  it('UpdateServiceRequestSchema requires at least one known field', () => {
    expect(UpdateServiceRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateServiceRequestSchema.safeParse({ status: 'inactive' }).success).toBe(true);
    expect(UpdateServiceRequestSchema.safeParse({ status: 'deleted' }).success).toBe(false);
    expect(UpdateServiceRequestSchema.safeParse({ facility_id: 'x' }).success).toBe(false);
  });

  it('capability request needs two UUIDs and nothing else', () => {
    const id = '018d1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b';
    expect(
      CounterServiceCapabilityRequestSchema.safeParse({ counter_id: id, service_id: id }).success,
    ).toBe(true);
    expect(CounterServiceCapabilityRequestSchema.safeParse({ counter_id: id }).success).toBe(false);
    expect(
      CounterServiceCapabilityRequestSchema.safeParse({ counter_id: id, service_id: 'x' }).success,
    ).toBe(false);
  });
});

describe('staff schemas', () => {
  it('only facility-scope roles can be invited or assigned (never org_admin or visitor)', () => {
    for (const role of [
      'staff_reception',
      'staff_counter',
      'supervisor',
      'facility_admin',
      'auditor',
    ]) {
      expect(InviteStaffRequestSchema.safeParse({ email: 'a@b.co', role }).success).toBe(true);
      expect(AssignRoleRequestSchema.safeParse({ role }).success).toBe(true);
    }
    for (const role of ['org_admin', 'visitor_anonymous', 'root', '']) {
      expect(InviteStaffRequestSchema.safeParse({ email: 'a@b.co', role }).success).toBe(false);
      expect(AssignRoleRequestSchema.safeParse({ role }).success).toBe(false);
    }
  });

  it('accept-invitation needs a long URL-safe token and a strong password', () => {
    const ok = {
      token: 'A'.repeat(43),
      display_name: 'New Person',
      password: 'correct-horse-battery-1',
    };
    expect(AcceptInvitationRequestSchema.safeParse(ok).success).toBe(true);
    expect(AcceptInvitationRequestSchema.safeParse({ ...ok, token: 'short' }).success).toBe(false);
    expect(
      AcceptInvitationRequestSchema.safeParse({ ...ok, token: `${'A'.repeat(42)}/` }).success,
    ).toBe(false);
    expect(AcceptInvitationRequestSchema.safeParse({ ...ok, password: 'weak' }).success).toBe(
      false,
    );
  });

  it('login does not enforce password strength but requires a value', () => {
    const base = { organization_slug: 'acme', email: 'a@b.co' };
    expect(LoginRequestSchema.safeParse({ ...base, password: 'x' }).success).toBe(true);
    expect(LoginRequestSchema.safeParse({ ...base, password: '' }).success).toBe(false);
  });
});
