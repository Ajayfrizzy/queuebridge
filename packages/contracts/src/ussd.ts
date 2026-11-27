import { z } from 'zod';

/**
 * M6.2 USSD (REQ-F12; ADR-009). Provider-neutral contract pieces shared by the API and the
 * channel adapters. Only the TEST-ONLY sandbox exists: no shortcode, no network relationship.
 */

/** Longest message a USSD screen may carry (the `[SANDBOX]` label counts against it). */
export const USSD_MAX_MESSAGE = 182;

/** The keypad code a facility posts so visitors can pick it on a feature phone. Public, never a credential. */
export const UssdAccessCodeSchema = z.string().regex(/^[1-9][0-9]{5}$/, 'a 6-digit code');

export const FacilityUssdSettingsUpdateSchema = z.object({ enabled: z.boolean() }).strict();
export type FacilityUssdSettingsUpdate = z.infer<typeof FacilityUssdSettingsUpdateSchema>;

export const FacilityUssdSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Generated when USSD is first turned on; kept when it is turned off (posters stay valid) */
  access_code: UssdAccessCodeSchema.nullable(),
  /** The deployment can answer USSD sessions (sandbox or an approved live provider) */
  deployment_available: z.boolean(),
  /** `sandbox` (TEST-ONLY, no real network) or `off`; `live` only with an approved provider */
  deployment_mode: z.enum(['off', 'sandbox', 'live']),
});
export type FacilityUssdSettings = z.infer<typeof FacilityUssdSettingsSchema>;

/**
 * M6.3 USSD monitoring. Sessions are kept about an hour after they expire (then deleted), so the
 * session figures cover only that window; tickets created over USSD come from the tickets table.
 */
export const UssdMonitoringSchema = z.object({
  /** Sessions that entered this facility's code, still kept (about the last hour) */
  sessions: z.object({
    active: z.number().int().min(0),
    /** The menu ended the session (any END screen: a ticket, a check, a refusal, Exit) */
    ended_by_menu: z.number().int().min(0),
    /** Timed out: no input before expiry (with or without a late input afterwards) */
    expired: z.number().int().min(0),
    /** Ended because a callback arrived out of order */
    out_of_step: z.number().int().min(0),
    /** Sessions that created a ticket (counted once each) */
    joined: z.number().int().min(0),
  }),
  /** Tickets created over USSD at this facility today (facility time zone), from committed tickets */
  tickets_today: z.number().int().min(0),
});
export type UssdMonitoring = z.infer<typeof UssdMonitoringSchema>;
