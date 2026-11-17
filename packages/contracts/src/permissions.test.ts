import { describe, expect, it } from 'vitest';
import { PERMISSION_NAMES, Permission } from './index.js';

/**
 * D3 check 1 (API permissions): the shared map is the map the API enforced before MQ.1,
 * unchanged. Any change to a permission's roles must update this matrix deliberately.
 */
describe('shared Permission map (MQ.1, decision D3)', () => {
  it('matches the pre-MQ.1 API permission matrix exactly', () => {
    expect(Permission).toEqual({
      FACILITY_READ: [
        'staff_reception',
        'staff_counter',
        'supervisor',
        'facility_admin',
        'auditor',
      ],
      FACILITY_CONFIGURE: ['facility_admin'],
      STAFF_MANAGE: ['facility_admin'],
      QUEUE_VIEW: ['staff_reception', 'staff_counter', 'supervisor', 'facility_admin', 'auditor'],
      QUEUE_MANAGE: ['supervisor', 'facility_admin'],
      OPERATIONS_VIEW: ['supervisor', 'facility_admin', 'auditor'],
      AUDIT_VIEW: ['auditor', 'supervisor', 'facility_admin'],
      WALK_IN: ['staff_reception', 'staff_counter', 'supervisor', 'facility_admin'],
    });
    expect(PERMISSION_NAMES).toEqual(Object.keys(Permission));
  });

  it('never lists org_admin (it satisfies every permission by rule) or the anonymous visitor', () => {
    for (const roles of Object.values(Permission)) {
      expect(roles).not.toContain('org_admin');
      expect(roles).not.toContain('visitor_anonymous');
    }
  });

  it('auditors can never manage, configure or register walk-ins', () => {
    for (const p of ['QUEUE_MANAGE', 'FACILITY_CONFIGURE', 'STAFF_MANAGE', 'WALK_IN'] as const) {
      expect(Permission[p]).not.toContain('auditor');
    }
  });
});
