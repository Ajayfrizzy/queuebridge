---
id: staff.coordinator.limits
title: Working offline: the coordinator device
audiences: [counter, supervisor, facility_admin]
topics: [connectivity, staff_operations]
requiresCapabilities: [offline_coordinator]
relatedRoutes: [staff.console, staff.connectivity]
availableSince: M3
version: 1
lastReviewed: 2026-11-18
keywords: [offline, outage, internet down, coordinator, no connection, call offline, provisional, authority, expired, capture only]
---

# One coordinator per queue

- While the connection is down, only the one designated coordinator device for a queue can call and serve visitors. Other devices can only capture walk-in tickets.
- What the coordinator does offline is provisional. It is final only when the server confirms it.
- While a coordinator holds the queue, calling from other devices is paused, even online.

## Expired or replaced authority

- When the coordinator's authority expires, that device can only capture tickets.
- If a supervisor replaced it, its unsent actions go to review. They are never applied automatically.

## What works offline

Capturing tickets, calling next, starting serving, completing and marking missed. Everything else needs a connection.
