# QueueBridge in practice

## Submission description

When the internet drops at a busy service desk, who remembers who was next? QueueBridge gives visitors, receptionists and counter staff a shared ticket history. A visitor can scan a facility QR code or ask reception for a walk-in ticket. Staff call the next eligible visitor, and the visitor can follow their place without the public board displaying their name.

A designated staff device can keep recording permitted work through an outage. When it reconnects, the server confirms each operation or flags it for review. A supervisor can explain a priority change, and an auditor can trace how the queue moved. A clinic intake desk, municipal service centre or registration hall can use the same workflow with its own services, counters and staff permissions.

Try Willow Crossing Service Centre with fictional records. [Judge walkthrough](walkthrough.md) · [Hosted application](https://queuebridge.rumptycloud.app) · [Demo video and evidence](demo-video.md)

## Feature overview

| #   | Feature                                                                  | Status |
| --- | ------------------------------------------------------------------------ | ------ |
| F1  | Offline-first queue operations                                           | M3     |
| F2  | Visitor registration by web, QR or staff walk-in, plus simulated USSD    | M2/M6  |
| F3  | Queue fairness and transparency                                          | M4     |
| F4  | Ticket recovery and missed-turn handling                                 | M5     |
| F5  | Adaptive service routing                                                 | M4     |
| F6  | Explainable wait-time estimates                                          | M2     |
| F7  | Accessibility-first visitor experience                                   | M5     |
| F8  | Tamper-evident operational history                                       | M4     |
| F9  | Connectivity and recovery dashboard                                      | M3     |
| F10 | Portable facility setup                                                  | M1     |
| F11 | Consented SMS turn alerts in internal simulation                         | M6     |
| F12 | USSD phone-menu registration, status and recovery in internal simulation | M6     |
| F13 | Ask Que role-aware help and navigation                                   | MQ     |
| F14 | Smart Turn Alerts (in-app alert; opt-in Web Push, best effort)           | M5     |
| F15 | Responsive public landing page and facility onboarding                   | M7     |

SMS and USSD use internal simulation only. Simulated receipts establish no handset delivery. Live Nigerian telecom connectivity is unavailable, and Africa’s Talking integration is deferred until after judging. Optional AI is disabled. Ask Que uses its curated knowledge and role-aware navigation.
