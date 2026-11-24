/**
 * M7.2 landing page copy, English baseline (REQ-F15.3.5). Every user-facing string on the
 * landing page, including accessible names and the story captions, lives here and is read
 * through i18next. A second language is added only when its translation can be validated.
 *
 * Truthfulness (REQ-F15.3.3): no conflict-free, guaranteed-delivery or always-online claim, no
 * metric, customer, logo or testimonial. Channel availability is never written here as a fact:
 * it is rendered from the server's capability manifest (`channels.ts`).
 */
export const en = {
  meta: {
    regionLabel: 'QueueBridge home',
  },
  savedTickets: {
    heading: 'Your tickets on this device',
    intro: 'Open a ticket you joined on this device. No sign-in is needed.',
    item: '{{code}} — {{service}}, {{facility}}',
  },
  hero: {
    eyebrow: 'Queue coordination for public services',
    title: "Queues that keep moving when the connection doesn't.",
    lead: 'Give visitors a ticket they can follow. Keep serving offline with one authorized coordinator, then sync for server confirmation.',
    primary: 'Set up your facility',
    secondary: 'Sign in',
    tertiary: 'How visitors join',
    continue: 'Continue to administration',
    staffConsole: 'Open the staff console',
    logoAlt: 'QueueBridge',
    artLabel:
      'Illustration: a ticket G014 crossing a bridge from a phone to a counter, with a sync badge showing it is confirmed by the server.',
    artTicket: 'Ticket',
    artConfirmed: 'Confirmed',
    artCounter: 'Counter 2',
  },
  preview: {
    visitor: 'Visitor ticket preview',
    ticketAlt: 'Example ticket G001 is waiting, first in line, with a server-confirmed update.',
    heading: 'Inside the workspace',
    counter: 'At the counter',
    counterDetail: 'Register walk-ins and see the status of your queue while you serve.',
    counterAlt:
      'Staff console with the open consultation queue, counter selector and walk-in registration.',
    facility: 'Across the facility',
    facilityDetail:
      'Review live queues and published service order. Priority changes require a reason and appear in the audit history.',
    facilityAlt: 'Administration workspace showing the facility directory and creation form.',
  },
  story: {
    heading: 'How QueueBridge keeps the line moving',
    intro: 'Follow one ticket from joining the queue through an outage and back online.',
    stageOf: 'Stage {{n}} of {{total}}',
    pause: 'Pause the story',
    resume: 'Play the story',
    previous: 'Previous stage',
    next: 'Next stage',
    controls: 'Story controls',
    staticNote: 'Motion is reduced on this device, so all six stages are shown together.',
    sceneLabel: 'Illustration for stage {{n}}: {{title}}',
    local: 'Local only',
    pending: 'Pending sync',
    review: 'Needs review',
    synced: 'Synced',
    offline: 'Offline',
    online: 'Online',
    yourTurn: "It's your turn",
    /** Labels drawn inside the simulation (the captions carry the meaning) */
    sim: {
      online: 'Online',
      offline: 'Offline',
      syncing: 'Syncing',
      visitor: 'Ticket page',
      coordinator: 'Coordinator',
      joined: 'Joined',
      confirmed: 'Confirmed',
      ahead: '2 ahead of you',
      range: 'About 6–10 min',
      notUpdating: 'Not updating',
      lastConfirmed: 'Last confirmed',
      checking: 'Checking…',
      yourTurn: "It's your turn",
      counter: 'Counter 2',
      serving: 'Serving',
      waiting: 'Waiting',
      called: 'Called',
      localOnly: 'Local only',
      synced: 'Synced',
      review: 'Needs review',
      captureOnly: 'Other devices: capture only',
    },
    stages: [
      {
        title: 'A visitor joins',
        caption:
          'They scan the facility QR code or open its link and get a ticket. No account or app is needed. Staff can also issue a ticket at the desk.',
      },
      {
        title: 'They wait and can see where they stand',
        caption:
          'The ticket page shows their position and a wait estimate as a range, never an exact time.',
      },
      {
        title: 'The connection drops',
        caption:
          'Devices show that they are offline. Nothing on a visitor’s page is shown as confirmed while the server cannot be reached.',
      },
      {
        title: 'One authorized coordinator keeps going',
        caption:
          'Only the device a supervisor designated as coordinator may call and serve locally, within its authorization. Its actions are marked “Local only” until the server confirms them. Other devices can only capture new tickets.',
      },
      {
        title: 'The connection returns and actions sync',
        caption:
          'Saved actions are sent to the server, which verifies each one. Valid actions are confirmed; an action that conflicts with what the server already recorded is flagged “Needs review” for a supervisor and never silently overwrites it.',
      },
      {
        title: 'The visitor is told it is their turn',
        caption:
          'Once the server has committed the call, the ticket page shows “It’s your turn” with the counter. Push and text alerts are best effort; the board and staff calling remain the fallback.',
      },
    ],
  },
  audiences: {
    heading: 'Who QueueBridge serves',
    items: [
      {
        title: 'Visitors',
        body: 'Join without an account, follow your place, get your ticket back on another phone with your recovery key, and set text size, contrast and alerts on your device.',
      },
      {
        title: 'Reception staff',
        body: 'Issue walk-in tickets for people without a phone, help with recovery through a restricted procedure, and return missed visitors inside the grace window.',
      },
      {
        title: 'Counter operators',
        body: 'Call, serve, complete, put on hold and transfer visitors, with the current ticket always in front of you and the sync state visible.',
      },
      {
        title: 'Supervisors',
        body: 'Change priority or call out of order with a recorded reason, designate the offline coordinator, watch device health and resolve actions that need review.',
      },
      {
        title: 'Facility administrators',
        body: 'Set up services, counters, queue rules and staff, check readiness, and share the facility’s join link and QR code.',
      },
      {
        title: 'Auditors',
        body: 'Read the event history and run the integrity check. Auditors can look, never change.',
      },
    ],
  },
  channels: {
    heading: 'Channel availability',
    loading: 'Checking this deployment…',
    unavailableAll:
      'This deployment’s channel status could not be checked, so no channel is shown as available.',
    names: {
      visitor_join: 'Web and QR joining',
      sms_turn_alerts: 'SMS turn alerts',
      ussd: 'USSD phone menu',
    },
    status: {
      live: 'Live',
      sandbox: 'Sandbox',
      preview: 'Preview',
      planned: 'Planned',
      notSetUp: 'Not set up here',
      switchedOff: 'Switched off here',
      unknown: 'Status unavailable',
    },
    explain: {
      live: 'Available on this deployment.',
      sandbox:
        'Test mode only: no real messages are sent and no real mobile-network session is used. Not a production service.',
      sandboxNotSetUp: 'Test mode exists in this build but is not set up on this deployment.',
      preview: 'An early version; it may change.',
      planned: 'Not available yet.',
      notSetUp: 'Built, but not set up on this deployment.',
      switchedOff: 'Built, but switched off on this deployment.',
      unknown: 'Could not be checked, so it is not shown as available.',
    },
  },
  join: {
    heading: 'How visitors join',
    steps: [
      'Scan the QR code at the facility, or open the join link it shares.',
      'Choose the service and press Get a ticket. No account is needed.',
      'Keep the ticket page open, or save it. It shows your place and tells you when it is your turn.',
      'Use your private recovery key to restore the ticket on another phone. The public ticket code alone cannot restore it.',
    ],
    noPhone: 'No smartphone? Ask the reception desk for a walk-in ticket.',
  },
  onboarding: {
    heading: 'Get started',
    intro: 'Create an organization, prepare your counters and share your join link.',
    viewSteps: 'View setup steps',
    anonymousStart: 'Start by creating your organization.',
    afterSignup: 'Available after you create an organization and sign in.',
    already: 'Already set up?',
    signedInFor: 'Progress for {{facility}}',
    chooseFacility: 'Facility',
    noFacilities: 'You have no facility yet. Create one in Administration.',
    notAdmin:
      'Setting up facilities is for facility and organization administrators. Your work starts in the staff console.',
    loadError:
      'Your setup progress could not be loaded. The steps still link to the right screens.',
    open: 'Open',
    state: {
      done: 'Done',
      todo: 'To do',
      unknown: 'Check on the screen',
    },
    steps: [
      { title: 'Create your organization', body: 'You become its administrator.' },
      { title: 'Create a facility', body: 'A clinic, office or branch with its own queues.' },
      {
        title: 'Configure a service',
        body: 'What visitors queue for, with its published order and grace window.',
      },
      {
        title: 'Configure a counter',
        body: 'Where visitors are served. A counter must serve an active service.',
      },
      { title: 'Invite staff', body: 'Give each person the role they need.' },
      {
        title: 'Share the QR code or join link',
        body: 'Shown on the facility overview once the facility is ready and a queue is open.',
      },
      {
        title: 'Serve the first visitor',
        body: 'Open today’s queue in the staff console and call next.',
      },
    ],
  },
  footer: {
    privacyHeading: 'Privacy',
    privacy:
      'This page uses no analytics, trackers or third-party services. Visitors need no account and get no cookie; the only cookie is the sign-in session for staff. A ticket and your display settings are kept on your device. A phone number is asked for only when a facility offers text alerts and you choose them; it is stored encrypted and deleted when the visit ends. Staff accounts hold a name, an email and a hashed password.',
    accessibilityHeading: 'Accessibility',
    accessibility:
      'QueueBridge aims to meet WCAG 2.2 AA. It is checked with automated accessibility and keyboard tests; manual screen-reader reviews are still to be completed, and it has not been independently audited or certified. If something does not work for you, tell the staff of the facility, or raise it through the project repository.',
    projectHeading: 'Project',
    repository: 'Source code on GitHub',
    license: 'Released under the MIT License.',
    navHeading: 'Go to',
    navLabel: 'Footer',
    nav: {
      signup: 'Create an organization',
      signin: 'Sign in',
      recover: 'Recover a ticket',
    },
  },
};

export type LandingCopy = typeof en;
