---
id: staff.sync.states
title: What the sync states mean
audiences: [reception, counter, supervisor, facility_admin, auditor]
topics: [connectivity]
requiresCapabilities: []
relatedRoutes: [staff.console, staff.connectivity]
availableSince: M3
version: 2
lastReviewed: 2026-11-18
keywords: [sync, offline, pending, committed, synced, local, needs review, rejected, duplicate, unsent]
---

# Sync states

- **Local:** saved on this device and not sent yet.
- **Pending sync:** waiting to be sent to the server.
- **Synced:** the server confirmed it (committed). Only this is final. An action the server already had also shows as Synced, and nothing happened twice.
- **Needs review:** the server could not apply it; a supervisor decides.
- **Rejected:** the server refused it, so it did not happen.

## Before you go offline

- Register this device while online, on the same web address you will use offline. Opening a queue console online registers it.
- Offline progress stays provisional until it is synced.

Supervisors, facility administrators and auditors can see device and sync health in [connectivity and recovery](route:staff.connectivity).
