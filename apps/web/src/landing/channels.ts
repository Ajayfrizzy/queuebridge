import type { CapabilityManifest } from '@queuebridge/contracts';

/**
 * M7.2 honest channel availability (REQ-F15.3.3, design §14.4.5). The landing page never states
 * a channel's availability itself: it renders what the server's capability manifest says, and
 * fails closed. Only `live` + `available` is shown as "Live"; a `sandbox` channel is always
 * labelled as test-only; a missing manifest or entry shows "Status unavailable", never available.
 */
export const LANDING_CHANNELS = ['visitor_join', 'sms_turn_alerts', 'ussd'] as const;
export type LandingChannel = (typeof LANDING_CHANNELS)[number];

export type ChannelStatusKey =
  | 'live'
  | 'sandbox'
  | 'preview'
  | 'planned'
  | 'notSetUp'
  | 'switchedOff'
  | 'unknown';
export type ChannelExplainKey = ChannelStatusKey | 'sandboxNotSetUp';

export interface ChannelView {
  id: LandingChannel;
  /** i18n key under `channels.status` */
  status: ChannelStatusKey;
  /** i18n key under `channels.explain` */
  explain: ChannelExplainKey;
  /** Presented as usable now (live AND available) */
  usable: boolean;
  /** Raw manifest values, for `data-*` attributes and tests (never shown as text) */
  manifestStatus: string | null;
  manifestAvailability: string | null;
}

export function channelView(manifest: CapabilityManifest | null, id: LandingChannel): ChannelView {
  const e = manifest?.capabilities[id];
  const base = {
    id,
    manifestStatus: e?.status ?? null,
    manifestAvailability: e?.availability ?? null,
  };
  if (!e) return { ...base, status: 'unknown', explain: 'unknown', usable: false };
  if (e.status === 'planned')
    return { ...base, status: 'planned', explain: 'planned', usable: false };
  if (e.availability === 'available') {
    if (e.status === 'live') return { ...base, status: 'live', explain: 'live', usable: true };
    if (e.status === 'sandbox')
      return { ...base, status: 'sandbox', explain: 'sandbox', usable: false };
    return { ...base, status: 'preview', explain: 'preview', usable: false };
  }
  // Unavailable: a sandbox stays labelled as such; otherwise say why
  if (e.status === 'sandbox') {
    return { ...base, status: 'sandbox', explain: 'sandboxNotSetUp', usable: false };
  }
  if (e.unavailableReason === 'switched_off') {
    return { ...base, status: 'switchedOff', explain: 'switchedOff', usable: false };
  }
  if (e.unavailableReason === 'not_configured') {
    return { ...base, status: 'notSetUp', explain: 'notSetUp', usable: false };
  }
  return { ...base, status: 'planned', explain: 'planned', usable: false };
}
