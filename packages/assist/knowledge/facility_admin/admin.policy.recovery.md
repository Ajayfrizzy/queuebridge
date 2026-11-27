---
id: admin.policy.recovery
title: Missed-turn and recovery rules for a service
audiences: [facility_admin]
topics: [facility_configuration, recovery]
requiresCapabilities: []
relatedRoutes: [admin.facility]
availableSince: M5
version: 1
lastReviewed: 2026-11-18
keywords: [grace window, rejoin policy, self resume, staff decide, automatic no show, auto miss, staff assisted recovery, missed turn settings]
---

# Missed turns and recovery

Choose **Edit policy** on a service.

- **Grace window (seconds):** how long after a missed turn the ticket can still return to the queue. Default 300, from 0 to 3600.
- **Visitors who missed their turn:** **Staff decide** (the default), or let the visitor return themselves inside the grace window.
- **Automatically mark an unanswered call as missed:** off by default. When on, set the seconds, from 60 to 3600. Visitors are shown the rule. It never runs while an offline coordinator holds the queue.
- **Allow staff-assisted ticket recovery:** on by default. When off, staff offer a new ticket instead.

Each saved change creates a new policy version.
