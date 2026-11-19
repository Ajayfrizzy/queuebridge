---
id: admin.services
title: Setting up services and the queue order
audiences: [facility_admin, supervisor, auditor]
topics: [facility_configuration]
requiresCapabilities: []
relatedRoutes: [admin.facility]
availableSince: M1
version: 1
lastReviewed: 2026-11-18
keywords: [service, add service, ordering policy, first come first served, priority class, urgent, override reasons, transfer placement, policy version, policy history, deactivate service]
---

# Services

Open the facility in administration and choose **Services**. Facility administrators and organization administrators can change services. Other roles can read them.

## Add a service

Enter a name and an optional description, set the rules, and press **Add service**.

## Queue rules

- **Ordering:** first come, first served. You can also enable an urgent class and a priority class. Higher classes are called first.
- **Override reasons:** the reasons a supervisor can choose when changing a visitor's priority.
- **Transferred visitors:** keep their original waiting time, or join the end of the queue.
- The missed-turn and recovery rules have their own article.

## Policy versions

Saving changed rules creates a new policy version. Earlier versions stay in **Policy history**, so past decisions can be explained. Saving the same rules creates nothing.
