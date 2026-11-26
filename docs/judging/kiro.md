# Building QueueBridge with Kiro

**Kiro CLI** is the interface identified in the M0 completion record. The team used it to break down the PRD, establish package boundaries, scaffold the API, worker and PWA, and write the first architecture decisions. The later Codex handover records the transition between tools. CLI use and spec-driven development are the evidence-backed claims for this entry. [M0 contribution record](../archive/milestones/M0-completion.md) · [Handover](../archive/handover/QUEUEBRIDGE-CODEX-HANDOVER.md)

## Follow one decision through the build

1. The requirements identified a practical failure: during an outage two desks could both believe they had advanced the same queue. The design assigned offline authority to one coordinator and the task list defined milestones and acceptance checks. [Requirements](../../.kiro/specs/queuebridge/requirements.md) · [Design](../../.kiro/specs/queuebridge/design.md) · [Tasks](../../.kiro/specs/queuebridge/tasks.md)
2. Product and architecture steering kept the distinction between local and committed work visible. Security steering required tenant and authority checks. Testing steering required replay and stale-coordinator cases. [Four steering documents](../../.kiro/steering)
3. Trace that decision to the coordinator ADR, the synchronization route and the M3 completion record. A repeated operation must not create a second final event. An obsolete coordinator must not keep advancing the queue. [Coordinator decision](../archive/adr/ADR-006-single-offline-coordinator.md) · [Sync API](../../apps/api/src/routes/sync.ts) · [M3 evidence](../archive/milestones/M3-completion.md)

## What review changed

The M0 correction pass documented a migration script that could not resolve its database driver from the workspace root. Declaring the dependency where the script ran fixed the issue. The lesson was to exercise the operator's command from its real entry point as well as testing package code. Later, the ticket-first experiment was preserved separately for review. Its measurements are historical evidence, and the judging architecture retains the accepted application shell. [Correction record](../archive/milestones/M0-completion.md) · [Prototype investigation](../archive/reports/M7.3F-ticket-first.md)
