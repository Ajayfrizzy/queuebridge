import { createHash } from 'node:crypto';
import {
  canonicalJson,
  checkpointRoot as domainCheckpointRoot,
  computeEventHash as domainComputeEventHash,
  EVENT_DOMAIN_SEPARATOR,
  genesisHash,
  verifyChain as domainVerifyChain,
  type ChainVerification,
  type HashedEventBody,
  type Sha256Hex,
  type StoredEvent,
} from '@queuebridge/domain';

/**
 * Node binding of the shared audit primitives in `@queuebridge/domain` (one implementation for
 * the API and the worker; see packages/domain/src/audit.ts).
 */
export const sha256Hex: Sha256Hex = (input) =>
  createHash('sha256').update(input, 'utf8').digest('hex');

export { canonicalJson, EVENT_DOMAIN_SEPARATOR };
export type { ChainVerification, HashedEventBody, StoredEvent };

/** prev_hash of the first event in every queue session. */
export const GENESIS_HASH = genesisHash(sha256Hex);

export const computeEventHash = (prevHash: string, body: HashedEventBody): string =>
  domainComputeEventHash(sha256Hex, prevHash, body);

export const verifyChain = (events: readonly StoredEvent[]): ChainVerification =>
  domainVerifyChain(sha256Hex, events);

export const checkpointRoot = (eventHashes: readonly string[]): string =>
  domainCheckpointRoot(sha256Hex, eventHashes);
