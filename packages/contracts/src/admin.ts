import { z } from 'zod';
import { PriorityClass, Role } from './enums.js';
import { UuidSchema } from './schemas.js';

/**
 * M1 — tenancy, staff identity, and facility setup DTOs.
 *
 * Request schemas are `.strict()`: unknown fields (for example a client-supplied
 * `organization_id` or `actor_id`) are rejected rather than ignored. Tenant and
 * actor identity are always derived from the authenticated session on the server.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const SlugSchema = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens');

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.string().email('Enter a valid email address'));

const NameSchema = z.string().trim().min(2).max(100);

/** Passwords: 12–128 characters. Hashed with argon2id server-side. */
export const PasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

/** IANA time zone, validated against the runtime's tz database. */
export const TimezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Unknown IANA time zone' },
);

/** Roles that can be granted at facility scope (org_admin is organization-wide). */
export const FacilityRole = {
  STAFF_RECEPTION: Role.STAFF_RECEPTION,
  STAFF_COUNTER: Role.STAFF_COUNTER,
  SUPERVISOR: Role.SUPERVISOR,
  FACILITY_ADMIN: Role.FACILITY_ADMIN,
  AUDITOR: Role.AUDITOR,
} as const;
export type FacilityRole = (typeof FacilityRole)[keyof typeof FacilityRole];
export const FacilityRoleSchema = z.enum([
  Role.STAFF_RECEPTION,
  Role.STAFF_COUNTER,
  Role.SUPERVISOR,
  Role.FACILITY_ADMIN,
  Role.AUDITOR,
]);

// ---------------------------------------------------------------------------
// Auth and organizations
// ---------------------------------------------------------------------------

export const CreateOrganizationRequestSchema = z
  .object({
    organization_name: NameSchema,
    organization_slug: SlugSchema,
    admin_display_name: NameSchema,
    admin_email: EmailSchema,
    admin_password: PasswordSchema,
  })
  .strict();
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;

export const LoginRequestSchema = z
  .object({
    organization_slug: SlugSchema,
    email: EmailSchema,
    // Login does not re-validate password strength: only that something was supplied.
    password: z.string().min(1).max(128),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RoleGrantSchema = z.object({
  role: z.enum([
    Role.STAFF_RECEPTION,
    Role.STAFF_COUNTER,
    Role.SUPERVISOR,
    Role.FACILITY_ADMIN,
    Role.ORG_ADMIN,
    Role.AUDITOR,
  ]),
  /** null for organization-wide roles (org_admin) */
  facility_id: UuidSchema.nullable(),
});
export type RoleGrant = z.infer<typeof RoleGrantSchema>;

export const SessionUserSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  display_name: z.string(),
  organization: z.object({ id: UuidSchema, name: z.string(), slug: z.string() }),
  roles: z.array(RoleGrantSchema),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

// ---------------------------------------------------------------------------
// Facilities, services, counters
// ---------------------------------------------------------------------------

export const CreateFacilityRequestSchema = z
  .object({
    name: NameSchema,
    slug: SlugSchema,
    timezone: TimezoneSchema.default('UTC'),
  })
  .strict();
export type CreateFacilityRequest = z.infer<typeof CreateFacilityRequestSchema>;

export const FacilitySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  status: z.enum(['active', 'inactive', 'suspended']),
  created_at: z.string(),
});
export type Facility = z.infer<typeof FacilitySchema>;

/** Published ordering policy for a service (F3). Default: FIFO within `normal`. */
export const ServicePolicySchema = z
  .object({
    version: z.string().min(1).max(32).default('v1'),
    priority_order: z
      .array(z.enum([PriorityClass.URGENT, PriorityClass.PRIORITY, PriorityClass.NORMAL]))
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length, 'priority_order must not repeat classes')
      .refine((v) => v.includes(PriorityClass.NORMAL), 'priority_order must include "normal"')
      .default([PriorityClass.NORMAL]),
    grace_window_seconds: z.number().int().min(0).max(3600).default(300),
  })
  .strict();
export type ServicePolicy = z.infer<typeof ServicePolicySchema>;

export const CreateServiceRequestSchema = z
  .object({
    name: NameSchema,
    description: z.string().trim().max(500).optional(),
    policy: ServicePolicySchema.default({
      version: 'v1',
      priority_order: [PriorityClass.NORMAL],
      grace_window_seconds: 300,
    }),
  })
  .strict();
export type CreateServiceRequest = z.infer<typeof CreateServiceRequestSchema>;

export const UpdateServiceRequestSchema = z
  .object({
    name: NameSchema.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
    policy: ServicePolicySchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');
export type UpdateServiceRequest = z.infer<typeof UpdateServiceRequestSchema>;

export const ServiceSchema = z.object({
  id: UuidSchema,
  facility_id: UuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(['active', 'inactive']),
  policy: ServicePolicySchema,
  created_at: z.string(),
});
export type Service = z.infer<typeof ServiceSchema>;

export const CreateCounterRequestSchema = z.object({ name: NameSchema }).strict();
export type CreateCounterRequest = z.infer<typeof CreateCounterRequestSchema>;

export const UpdateCounterRequestSchema = z
  .object({ name: NameSchema.optional(), active: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');
export type UpdateCounterRequest = z.infer<typeof UpdateCounterRequestSchema>;

export const CounterSchema = z.object({
  id: UuidSchema,
  facility_id: UuidSchema,
  name: z.string(),
  active: z.boolean(),
  service_ids: z.array(UuidSchema),
  created_at: z.string(),
});
export type Counter = z.infer<typeof CounterSchema>;

export const CounterServiceCapabilityRequestSchema = z
  .object({ counter_id: UuidSchema, service_id: UuidSchema })
  .strict();
export type CounterServiceCapabilityRequest = z.infer<typeof CounterServiceCapabilityRequestSchema>;

// ---------------------------------------------------------------------------
// Staff, invitations, roles
// ---------------------------------------------------------------------------

export const InviteStaffRequestSchema = z
  .object({ email: EmailSchema, role: FacilityRoleSchema })
  .strict();
export type InviteStaffRequest = z.infer<typeof InviteStaffRequestSchema>;

export const InvitationSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  role: FacilityRoleSchema,
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  expires_at: z.string(),
  created_at: z.string(),
});
export type Invitation = z.infer<typeof InvitationSchema>;

/** Invitation secrets are high-entropy URL-safe strings (>= 128 bits). */
export const InvitationTokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const PreviewInvitationRequestSchema = z.object({ token: InvitationTokenSchema }).strict();
export type PreviewInvitationRequest = z.infer<typeof PreviewInvitationRequestSchema>;

export const AcceptInvitationRequestSchema = z
  .object({
    token: InvitationTokenSchema,
    display_name: NameSchema,
    password: PasswordSchema,
  })
  .strict();
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;

export const AssignRoleRequestSchema = z.object({ role: FacilityRoleSchema }).strict();
export type AssignRoleRequest = z.infer<typeof AssignRoleRequestSchema>;

export const StaffMemberSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  display_name: z.string(),
  status: z.enum(['active', 'inactive', 'suspended']),
  roles: z.array(FacilityRoleSchema),
});
export type StaffMember = z.infer<typeof StaffMemberSchema>;

export const FacilityJoinLinkSchema = z.object({
  /** Path portion, e.g. /join/acme/main-clinic */
  path: z.string(),
  /** Absolute URL using the configured public web origin */
  url: z.string().url(),
  /** False until visitor registration exists (M2): the link must not be shared yet. */
  operational: z.boolean(),
});
export type FacilityJoinLink = z.infer<typeof FacilityJoinLinkSchema>;

// ---------------------------------------------------------------------------
// Facility readiness (M1) — derived, never stored
// ---------------------------------------------------------------------------

export const ReadinessIssueCodeSchema = z.enum([
  'facility_inactive',
  'no_services',
  'no_active_services',
  'no_counters',
  'no_active_counters',
  'no_active_counter_serves_active_service',
]);
export type ReadinessIssueCode = z.infer<typeof ReadinessIssueCodeSchema>;

export const FacilityReadinessSchema = z.object({
  /**
   * True only when at least one ACTIVE counter is configured to serve at least one ACTIVE
   * service in an ACTIVE facility. Counting services or counters is not enough.
   */
  configuration_ready: z.boolean(),
  facility_active: z.boolean(),
  services: z.array(
    z.object({
      id: UuidSchema,
      name: z.string(),
      status: z.enum(['active', 'inactive']),
      /** Active service with at least one active counter that serves it. */
      operational: z.boolean(),
      active_counter_count: z.number().int().nonnegative(),
      /** Includes inactive counters (their assignments are preserved). */
      configured_counter_count: z.number().int().nonnegative(),
    }),
  ),
  counters: z.array(
    z.object({
      id: UuidSchema,
      name: z.string(),
      active: z.boolean(),
      /** Active counter that serves at least one active service. */
      operational: z.boolean(),
      active_service_count: z.number().int().nonnegative(),
      configured_service_count: z.number().int().nonnegative(),
    }),
  ),
  issues: z.array(z.object({ code: ReadinessIssueCodeSchema, message: z.string() })),
  /** Visitor registration arrives in M2; until then the join link is not operational. */
  visitor_join: z.object({
    operational: z.boolean(),
    reason: z.string(),
  }),
});
export type FacilityReadiness = z.infer<typeof FacilityReadinessSchema>;
