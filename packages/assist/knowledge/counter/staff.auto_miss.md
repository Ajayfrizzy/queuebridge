---
id: staff.auto_miss
title: How automatic missed turns work
audiences: [counter, supervisor, facility_admin, auditor]
topics: [staff_operations]
requiresCapabilities: [auto_miss]
relatedRoutes: [staff.console, staff.audit, admin.facility]
availableSince: M5
version: 1
lastReviewed: 2026-11-18
keywords: [automatic, auto miss, no show, system, unanswered call, call window, missed automatically]
---

# Automatic missed turns

- Off by default. A facility administrator turns it on per service and sets the seconds, from 60 to 3600.
- The server marks a called ticket as missed after that time, counted from the call by server time. It follows the normal queue rules and appears in the audit trail as Missed, by the system.
- It never runs while an offline coordinator holds the queue. After coordinator authority ends, or after a server outage, the clock starts again.
- It never depends on whether a turn alert reached the visitor.
- Visitors see the rule on their ticket page while they are called.
