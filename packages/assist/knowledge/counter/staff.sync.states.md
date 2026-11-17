---
id: staff.sync.states
title: What the sync states mean
audiences: [reception, counter, supervisor, facility_admin, auditor]
topics: [connectivity]
requiresCapabilities: []
relatedRoutes: [staff.console, staff.connectivity]
availableSince: M3
version: 1
lastReviewed: 2026-11-17
keywords: [sync, offline, pending, committed, needs review, rejected, duplicate]
---

# Sync states

- **Local only:** saved on this device and not sent yet.
- **Pending sync:** waiting to be sent to the server.
- **Committed:** the server confirmed it. Only this state is final.
- **Duplicate:** the server already had this action, so nothing happened twice.
- **Needs review:** the server could not apply it; a supervisor decides.
- **Rejected:** the server refused it, so it did not happen.

## Before you go offline

- Register this device while online, on the same web address you will use offline.
- Offline progress stays provisional until it is committed.

Supervisors and auditors can see device and sync health in [connectivity and recovery](route:staff.connectivity).
