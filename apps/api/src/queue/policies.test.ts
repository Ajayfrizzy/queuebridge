import { describe, expect, it } from 'vitest';
import { ServicePolicySchema, type ServicePolicy } from '@queuebridge/contracts';
import { samePolicy } from './policies.js';

/**
 * ADR-012: re-sending the same rules never creates a new policy version. M5.1 added defaulted
 * fields; a policy stored before them must equal the same rules with the defaults filled in.
 */
describe('samePolicy', () => {
  const stored = {
    version: 'v3',
    priority_order: ['priority', 'normal'],
    grace_window_seconds: 300,
    override_reasons: ['accessibility_need', 'urgent_need'],
    transfer_placement: 'by_original_join_time',
  } as unknown as ServicePolicy; // shape persisted by M4, without the M5.1 fields

  it('a pre-M5.1 policy equals the same rules with the new fields at their defaults', () => {
    const resent = ServicePolicySchema.parse({ ...stored });
    expect(resent).toMatchObject({ rejoin_policy: 'staff_resume', staff_recovery: true });
    expect(samePolicy(resent, stored)).toBe(true);
  });

  it('a real change of a new field is a change', () => {
    const changed = ServicePolicySchema.parse({ ...stored, rejoin_policy: 'self_resume' });
    expect(samePolicy(changed, stored)).toBe(false);
    const autoMiss = ServicePolicySchema.parse({
      ...stored,
      auto_miss: { enabled: true, after_seconds: 120 },
    });
    expect(samePolicy(autoMiss, stored)).toBe(false);
  });

  it('the version label is never part of the comparison', () => {
    expect(samePolicy({ ...stored, version: 'v9' }, stored)).toBe(true);
  });
});
