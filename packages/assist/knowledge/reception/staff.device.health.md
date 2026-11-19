---
id: staff.device.health
title: Device health and alerts
audiences: [reception, counter, supervisor, facility_admin, auditor]
topics: [connectivity]
requiresCapabilities: [device_health]
relatedRoutes: [staff.connectivity, staff.console]
availableSince: M5
version: 1
lastReviewed: 2026-11-18
keywords: [device health, alerts, offline device, stale, last contact, unsent actions, acknowledge, coordinator not responding, sync failing, recovery attempts, turn alerts failing]
---

# Connectivity and recovery

[Connectivity and recovery](route:staff.connectivity) lists each staff device with its health, last contact, approximate unsent actions and coordinator role. A silent device may be offline, asleep, closed or lost: the server cannot tell which.

## Alerts

Alerts appear on this page only and are not sent anywhere else. They include:

- The offline coordinator is not responding.
- Coordinator authorization is about to end, or has ended.
- A device has been silent for a long time with unsent actions.
- Sending keeps failing.
- Offline actions are waiting for review.
- Many failed ticket-recovery attempts.
- Turn alerts are failing.

Supervisors, facility administrators and organization administrators can **Acknowledge** alerts. Auditors can read them.

## Alerts never act by themselves

An alert never fails over, renews or revokes anything, and never changes which device is the coordinator.

## On your own device

Reception and counter staff see a warning about their own device in the console, for example when its coordinator authorization is ending or sending keeps failing.
