---
id: staff.coordinator.manage
title: Designating, renewing and replacing a coordinator
audiences: [supervisor, facility_admin]
topics: [connectivity, staff_operations]
requiresCapabilities: [offline_coordinator]
relatedRoutes: [staff.connectivity]
availableSince: M3
version: 1
lastReviewed: 2026-11-18
keywords: [designate coordinator, make coordinator, renew authority, fail over, failover, end authority, lost coordinator, replace device]
---

# Before an outage

1. Open [connectivity and recovery](route:staff.connectivity) while online.
2. In the queue's card, choose the device under **Designate device**, set how long authority lasts (5 to 720 minutes) and press **Make coordinator**.

The device must already be registered. Its user must be a counter operator, supervisor, facility administrator or organization administrator.

## Renew or end

- **Renew authority** extends it. This needs a connection.
- **End authority (run online)**, with a reason, returns the queue to normal online calling.

## If the coordinator is lost

Choose a new device and a reason, then press **Fail over to this device**. The old device is fenced: its unsent actions go to review and are never applied automatically. Nothing happens automatically; failover is always a supervisor's decision.

## Who can do this

Supervisor, Facility administrator, Organization administrator.
