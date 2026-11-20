import type { SmsAdapter } from './adapter.js';
import { SandboxSmsAdapter, type SandboxSmsOptions } from './sandbox.js';

/**
 * SMS adapter registry (ADR-009 `getAdapter(provider)`), selected by `SMS_PROVIDER`.
 *
 * Only the TEST-ONLY sandbox exists: no live provider has been approved (PRD §13, M6 evidence),
 * so any other name is refused instead of silently falling back. A live adapter is added here,
 * after approval, by implementing `SmsAdapter` (send, signed webhook verification with replay
 * window, receipt and inbound parsing); nothing else changes.
 */
export function createSmsAdapter(provider: string, opts: SandboxSmsOptions = {}): SmsAdapter {
  if (provider === 'sandbox') return new SandboxSmsAdapter(opts);
  throw new Error(`no SMS adapter for provider "${provider}" (no live provider is approved)`);
}
