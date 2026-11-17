import { api } from '../lib/api.js';
import { QueHelpClient } from './helpClient.js';
import { IdbRestrictedHelpStore } from './store.js';

/**
 * Ask Que help on this device (MQ.2). The UI that reads it arrives in MQ.3; MQ.2 keeps the
 * restricted cache correct (fetch, revalidate, invalidate) from the auth layer.
 */
export const queHelp = new QueHelpClient(new IdbRestrictedHelpStore(), (known) => api.queKb(known));

export { loadCapabilities, loadPublicKb } from './publicKb.js';
export type { CachedRestrictedBundle } from './offlineHelp.js';
