---
id: staff.alerts.status
title: Push alert status for visitors
audiences: [counter, supervisor, facility_admin, auditor]
topics: [turn_alerts]
requiresCapabilities: [turn_alert_web_push]
relatedRoutes: [staff.console, staff.connectivity]
availableSince: M5
version: 1
lastReviewed: 2026-11-18
keywords: [push, alert status, visitor alert, sent not confirmed, seen on device, push failed, did the visitor get it, notification status]
---

# In the console

Counter operators and supervisors see **Visitor alert** for a called visitor, one line per device:

- **Push not sent yet**
- **Push sent, not confirmed:** the push service accepted it. It does not mean the visitor saw it.
- **Seen on device:** the visitor's ticket page confirmed it.
- **Push failed**
- **Alert not sent (ticket changed)**
- **Push outcome unknown**

## On connectivity and recovery

**Visitor push alerts (last hour)** counts attempted, sent, seen, failed, not sent and unknown alerts.

## Remember

An alert outcome never changes the ticket. Calling the ticket aloud and the public board remain the reliable way to reach the visitor.
