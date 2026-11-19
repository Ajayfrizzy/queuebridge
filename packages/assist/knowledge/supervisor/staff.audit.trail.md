---
id: staff.audit.trail
title: The audit trail and integrity check
audiences: [supervisor, facility_admin, auditor]
topics: [audit]
requiresCapabilities: []
relatedRoutes: [staff.audit, staff.console]
availableSince: M4
version: 1
lastReviewed: 2026-11-18
keywords: [audit, history, log, events, who did what, verify integrity, hash chain, export, download, record]
---

# Open the audit trail

From the queue console, open **Audit trail and integrity check**. It is read-only.

- It lists recorded events, such as tickets issued, calls, service, completions, missed turns, holds, transfers, priority changes and policy changes, with the time and who did it.
- Priority changes show the reason, the private explanation and the policy version.

## Verify integrity

Press **Verify integrity**. The result is Verified, Failed or Incomplete. Incomplete is not a successful check. The check detects ordinary changes to the record. It cannot rule out a rewrite by someone who controls every key and the whole database.

## Export

**Download redacted export** leaves out staff names and private explanations.

## Who can open it

Supervisor, Facility administrator, Organization administrator, Auditor (read-only).
