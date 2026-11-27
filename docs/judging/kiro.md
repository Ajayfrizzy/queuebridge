# Building QueueBridge with Kiro

**Kiro was the primary implementation tool for QueueBridge.** The project owner began with Kiro CLI and moved to Kiro IDE, using Kiro to build the vast majority of the product's functional features, not merely to scaffold or plan the application. The documented handover confirms that M0–M6, Ask Que, M7.1 and M7.2 were implemented and merged before Codex took over the final implementation phase at M7.3. The owner explains that this transition was necessary because the remaining Kiro credits were insufficient to complete the final phase.

## Development workflow and attribution

| Phase | Contribution | Evidence |
| --- | --- | --- |
| Kiro CLI | Initial scaffolding and early implementation: breaking down the product requirements, establishing package boundaries, creating the API, worker and PWA foundations, database schema, shared packages and initial tests. | [M0 completion report](../archive/milestones/M0-completion.md) |
| Kiro IDE | Primary environment for continued feature implementation: the owner moved from CLI to IDE and configured approval settings to reduce repeated interruptions. Kiro built the core product capabilities before the final hardening phase. | Owner's development account; [specifications](../../.kiro/specs/queuebridge) and [steering](../../.kiro/steering) provide the shared engineering context. |
| Codex reviews | Earlier implementation review and defect identification, including continuity, tenant isolation and fairness-related regression fixes documented in milestone reports. | [M1](../archive/milestones/M1-completion.md), [M2](../archive/milestones/M2-completion.md), [M3](../archive/milestones/M3-completion.md), [M4](../archive/milestones/M4-completion.md) |
| Later Codex implementation | When the owner approached the Kiro credit limit, Codex took over final hardening, independent verification, refinements and release preparation. The M7.3 handover identifies the completed M7.2 baseline and preserves the established architecture. | [Codex handover](../archive/handover/QUEUEBRIDGE-CODEX-HANDOVER.md) |

The project owner confirms that Kiro was the main feature implementation tool, the CLI-to-IDE transition and the credit-related reason for switching to Codex. The milestone reports and handover corroborate the completed scope and timing of the transition. Earlier Codex review contributions remain separately credited. No precise percentage or exclusive per-commit attribution is claimed.

## How Kiro shaped the engineering process

- **Specifications:** [requirements](../../.kiro/specs/queuebridge/requirements.md), [design](../../.kiro/specs/queuebridge/design.md) and [tasks](../../.kiro/specs/queuebridge/tasks.md) translate product needs into implementation boundaries, milestone tasks and acceptance criteria.
- **Persistent steering:** [product](../../.kiro/steering/product.md), [architecture](../../.kiro/steering/architecture.md), [security](../../.kiro/steering/security.md) and [testing](../../.kiro/steering/testing.md) record constraints that must survive across development sessions.
- **Architecture and implementation:** the [M0 record](../archive/milestones/M0-completion.md) documents the initial five shared packages, database schema, API and web foundations, architecture decisions and 121 passing initial tests.
- **Continuity across tools:** [AGENTS.md](../../AGENTS.md) and the Kiro artifacts also informed the later handover, so subsequent implementation retained the agreed product and architecture rather than starting again.

## Milestone traceability

These records document the core product capabilities built during the Kiro-led implementation phase, as confirmed by the owner. They establish the scope already implemented before the final Codex handover; they are not exclusive per-commit tool-attribution logs.

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

Kiro helped convert a real operational problem into explicit requirements, implementation tasks and verifiable engineering constraints, and was the primary tool used to implement those requirements as a working product. Its CLI established the initial working foundation, and its IDE supported the bulk of feature development with fewer repetitive approval interruptions. The subsequent Codex hardening phase continued from the working product Kiro had helped build, rather than replacing it. The retained artifacts allow reviewers to trace decisions from requirements through code and acceptance evidence.
