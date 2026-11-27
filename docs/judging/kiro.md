# Building QueueBridge with Kiro

QueueBridge used both **Kiro CLI and Kiro IDE** during development. Kiro was not limited to generating an initial prototype: its specifications, steering documents and engineering decisions provided the foundation for the subsequent implementation.

## Development workflow and attribution

| Phase | Contribution | Evidence |
| --- | --- | --- |
| Kiro CLI | Initial scaffolding and early implementation: breaking down the product requirements, establishing package boundaries, creating the API, worker and PWA foundations, database schema, shared packages and initial tests. | [M0 completion report](../archive/milestones/M0-completion.md) |
| Kiro IDE | The project owner moved from the CLI to the IDE for continued implementation, configuring approval settings to reduce repeated terminal interruptions while working on the existing project. | Owner's development account; [specifications](../../.kiro/specs/queuebridge) and [steering](../../.kiro/steering) provide the shared engineering context. |
| Codex reviews | Earlier implementation review and defect identification, including continuity, tenant isolation and fairness-related regression fixes documented in milestone reports. | [M1](../archive/milestones/M1-completion.md), [M2](../archive/milestones/M2-completion.md), [M3](../archive/milestones/M3-completion.md), [M4](../archive/milestones/M4-completion.md) |
| Later Codex implementation | The documented M7.3 handover identifies M7.2 as the completed baseline and establishes the constraints for later hardening and release work. | [Codex handover](../archive/handover/QUEUEBRIDGE-CODEX-HANDOVER.md) |

The CLI-to-IDE transition is confirmed by the project owner. The repository records the work and its acceptance evidence, but does not independently identify the interface used for every individual edit. We do not attribute every commit or test exclusively to Kiro, or claim use of unverified Kiro capabilities.

## How Kiro shaped the engineering process

- **Specifications:** [requirements](../../.kiro/specs/queuebridge/requirements.md), [design](../../.kiro/specs/queuebridge/design.md) and [tasks](../../.kiro/specs/queuebridge/tasks.md) translate product needs into implementation boundaries, milestone tasks and acceptance criteria.
- **Persistent steering:** [product](../../.kiro/steering/product.md), [architecture](../../.kiro/steering/architecture.md), [security](../../.kiro/steering/security.md) and [testing](../../.kiro/steering/testing.md) record constraints that must survive across development sessions.
- **Architecture and implementation:** the [M0 record](../archive/milestones/M0-completion.md) documents the initial five shared packages, database schema, API and web foundations, architecture decisions and 121 passing initial tests.
- **Continuity across tools:** [AGENTS.md](../../AGENTS.md) and the Kiro artifacts also informed the later handover, so subsequent implementation retained the agreed product and architecture rather than starting again.

## Milestone traceability

These records demonstrate the progression from the Kiro-established specifications to implemented product capabilities. They are evidence of the development process, not exclusive tool-attribution logs.

| Milestone | Implemented capability | Evidence |
| --- | --- | --- |
| M1 | Tenant isolation, roles and facility setup | [M1 completion](../archive/milestones/M1-completion.md) |
| M2 | Online queue operations and visitor flows | [M2 completion](../archive/milestones/M2-completion.md) |
| M3 | Offline continuity, synchronization and conflict recovery | [M3 completion](../archive/milestones/M3-completion.md) |
| M4 | Fairness, adaptive routing and audit integrity | [M4 completion](../archive/milestones/M4-completion.md) |
| M5 | Recovery, accessibility, device health and turn alerts | [M5 completion](../archive/milestones/M5-completion.md) |
| MQ, M6, M7.1 and M7.2 | Ask Que, communication adapters and responsive product experience | [Completed baseline at handover](../archive/handover/QUEUEBRIDGE-CODEX-HANDOVER.md) |

## Follow one decision through the build

1. The requirements identified a practical failure: during an outage two desks could both believe they had advanced the same queue. The design assigned offline authority to one coordinator and the task list defined milestones and acceptance checks. [Requirements](../../.kiro/specs/queuebridge/requirements.md) · [Design](../../.kiro/specs/queuebridge/design.md) · [Tasks](../../.kiro/specs/queuebridge/tasks.md)
2. Product and architecture steering kept the distinction between local and committed work visible. Security steering required tenant and authority checks. Testing steering required replay and stale-coordinator cases. [Four steering documents](../../.kiro/steering)
3. Trace that decision to the coordinator ADR, the synchronization route and the M3 completion record. A repeated operation must not create a second final event. An obsolete coordinator must not keep advancing the queue. [Coordinator decision](../archive/adr/ADR-006-single-offline-coordinator.md) · [Sync API](../../apps/api/src/routes/sync.ts) · [M3 evidence](../archive/milestones/M3-completion.md)
4. The published [Continuity in Action documentary](https://youtu.be/pXa5h-StyYM) demonstrates the deployed application's actual offline provisional registration, reconnection, reconciliation and subsequent service recovery. The recording illustrates the practical result of the design; it is not a recording of every coordinator-authority or replay test.

## What review changed

The M0 correction pass documented a migration script that could not resolve its database driver from the workspace root. Declaring the dependency where the script ran fixed the issue. The lesson was to exercise the operator's command from its real entry point as well as testing package code. Later, the ticket-first experiment was preserved separately for review. Its measurements are historical evidence, and the judging architecture retains the accepted application shell. [Correction record](../archive/milestones/M0-completion.md) · [Prototype investigation](../archive/reports/M7.3F-ticket-first.md)

The [M3 completion record](../archive/milestones/M3-completion.md) also describes a review finding about selecting the authority tokens referenced by each synchronization batch, the correction and its regression coverage. This illustrates how implementation review reinforced the original continuity constraints.

## Why Kiro mattered

Kiro helped convert a real operational problem into explicit requirements, implementation tasks and verifiable engineering constraints. Its CLI established the initial working foundation, while the IDE supported continued development with fewer repetitive approval interruptions. The retained artifacts allow reviewers to trace decisions from requirements through code and acceptance evidence, including after the later tool handover.
