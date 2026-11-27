---
id: admin.channels.sms
title: Text message settings and delivery monitoring
audiences: [reception, counter, supervisor, facility_admin, auditor]
topics: [facility_configuration, turn_alerts]
requiresCapabilities: [sms_turn_alerts]
relatedRoutes: [admin.facility.channels]
availableSince: M6
version: 1
lastReviewed: 2026-11-20
keywords: [sms settings, text message settings, daily limit, sms cap, sms delay, channels, sms monitoring, delivery status, test mode]
---

# Text message settings (test mode)

Text messages are in test mode here (sandbox): no real messages are sent. The Channels screen of a facility shows the text message settings, today's use and what happened to each turn alert.

## The settings

- Facility administrators turn text message turn alerts on or off and set the facility's daily limit. Other staff see the settings but cannot change them.
- The provider mode is set by this deployment; the screen only shows it. Live is not available in this build.
- A message over the facility's or the deployment's daily limit is not sent and is recorded as failed (limit reached). Limits reset at midnight UTC.

## The optional delay

- Off by default: the text message is sent as soon as the visitor is called.
- With a delay, the text message is sent only if the visitor's ticket page has not shown the alert by then. It can save messages, but the text message arrives later; it is not recommended where timely calling matters.
- The longest delay is limited by the turn-alert time limit and by any automatic no-show setting. A longer value is refused.
- The ticket page reports only that it showed the alert, not that the visitor read it. No report does not mean the visitor missed it.

## Reading the monitoring

Supervisors, facility administrators and auditors see the recent turn alerts:

- Accepted: the provider took the message. It is not proof of delivery.
- Delivered: a provider receipt arrived. In test mode the receipt is simulated.
- Not sent: the visitor stopped text messages, the ticket changed, or the ticket page showed the alert first.
- Unknown: the outcome is not known. It is never sent again.

Phone numbers and message text are never shown.
