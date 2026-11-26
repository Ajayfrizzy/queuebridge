# ADR-006: One Designated Coordinator Per Queue During Outage

**Date:** 2026-10-30  
**Status:** Accepted — **core invariant, do not deviate**

## Context

During a network outage, a facility may need to continue serving visitors. Without any offline authority, the queue would freeze entirely. However, allowing multiple devices to independently advance the queue would produce conflicting state that cannot be safely reconciled.

## Decision

**One designated offline coordinator per queue session.**

- A supervisor designates a specific device as the coordinator for one or more queue sessions
- The designation is a signed, short-lived token: `{ device_id, queue_session_id, epoch, allowed_commands, expires_at }`
- The coordinator MAY perform locally-applied calls and completions while offline
- All coordinator actions are marked `offline_applied` — not globally final
- Non-coordinator devices may capture provisional ticket registrations with `temporary_ticket_ref` but may NOT independently advance the queue
- The coordinator cannot verify whether the server has replaced it during the partition — so all its offline actions remain provisional

## Consequences

**Positive:**

- Eliminates split-brain: only one source of local advancement per queue
- Clear attribution: every provisional action is linked to the coordinator's device_id and epoch
- Server can validate epoch compatibility on reconnect and reject stale decisions

**Negative:**

- If the coordinator device is lost (destroyed, dead battery, storage cleared), offline advancement suspends until a supervisor performs explicit failover
- Supervisors must understand and manage coordinator assignment before anticipated outages
- The conservative approach means some service disruption is inevitable for multi-device facilities

## Coordinator failover

If the designated coordinator is lost:

1. Supervisor performs explicit failover: assigns a new coordinator, incrementing the epoch
2. New coordinator's epoch is stored in `queue_sessions.coordinator_epoch`
3. Old coordinator's subsequent sync attempts are rejected (stale epoch)
4. Actions from the old coordinator are held in `needs_review` state

## What coordinators may NOT do

- Coordinators may not reassign themselves
- Coordinators may not perform priority overrides (supervisor action only)
- Coordinators may not create new queue sessions or modify service configurations
- Coordinator authority does not extend to cross-facility or cross-service operations

## Architectural acceptance gate

Before this feature is implemented (M3), the following must be answered in code and tests:

1. Who may advance the queue when the internet disappears?
2. Which progress is local only vs globally confirmed?
3. What happens when two devices or a server disagree?
4. Can duplicate requests change queue state twice?
5. What happens if a coordinator loses its device or storage?
6. How can staff recognize and resolve a conflicted operation?
