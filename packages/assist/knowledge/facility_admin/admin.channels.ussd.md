---
id: admin.channels.ussd
title: USSD settings and session monitoring
audiences: [reception, counter, supervisor, facility_admin, auditor]
topics: [facility_configuration, registration]
requiresCapabilities: [ussd]
relatedRoutes: [admin.facility.channels]
availableSince: M6
version: 1
lastReviewed: 2026-11-20
keywords: [ussd settings, facility code, phone menu, channels, ussd monitoring, sessions, test mode]
---

# USSD settings (test mode)

USSD is in test mode here (sandbox): there is no real USSD code to dial and no real mobile-network session. The Channels screen of a facility shows the USSD setting and recent sessions.

## The setting

- Facility administrators turn the phone menu on or off. Other staff see the setting but cannot change it.
- The 6-digit facility code is created the first time the menu is turned on and stays the same afterwards. It identifies the facility for posters; it never opens a ticket.
- The provider mode is set by this deployment; the screen only shows it. Live is not available in this build.

## Reading the monitoring

Supervisors, facility administrators and auditors see:

- Sessions open now, ended by the menu, timed out, or out of order.
- Sessions that created a ticket, and the USSD tickets created today.

A session that timed out is never counted as a ticket. Sessions are kept for about an hour, so the session figures cover roughly the last hour. Phone numbers and menu entries are never shown.
