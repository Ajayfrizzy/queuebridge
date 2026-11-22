# M7 landing and UI acceptance review

**Recommendation for owner review, 22 November 2026.** Retain the M7.1 shell and M7.2 landing structure. The clearest refinement is the collision between Ask Que and the mobile hero actions. The primary facility setup action remains visible. The screenshots support a placement adjustment and two small editorial or artwork refinements.

## Browser evidence

Reviewed the local application on the working tree of `feature/m7-3-hardening` at HEAD `5d2e5ea`, including uncommitted work. Screenshots use local fixture data in Chromium 158.0.8127.18. Desktop captures use 1280 × 800 in Light and phone captures use a 375 × 812 viewport in Dark. The phone captures represent browser emulation. Physical touch, safe areas on installed devices and assistive technology remain human acceptance items.

| Screen                             | Desktop                                           | Phone                                            |
| ---------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Landing at initial scroll position | [Light hero](media/m7-ui/desktop.png)             | [Dark hero](media/m7-ui/phone.png)               |
| Continuity story                   | [Two-column story](media/m7-ui/desktop-story.png) | [Stacked story](media/m7-ui/phone-story.png)     |
| Visitor join                       | [Desktop join](media/m7-ui/desktop-join.png)      | [Phone join](media/m7-ui/phone-join.png)         |
| Authenticated workspace            | [Staff queue](media/m7-ui/staff.png)              | [Administration, desktop](media/m7-ui/admin.png) |

## Findings and scope for approval

| Priority | Observation                                                                                                                                                                                                                                                                                                                                            | Proposed correction and regression check                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Medium   | At 375 × 812 the fixed Ask Que launcher covers the right side of Sign in. Its label remains legible, but two tap targets occupy the same space. At the captured story scroll position the launcher also covers the end of a stage heading. On desktop it sits over staff recovery copy and near the lower edge of Create facility.                     | Approve a narrow placement trial at the affected sizes. Reserve space for the closed launcher where actions terminate and check actual hit targets at the top, middle and end of the page. A larger fixed inset alone could move the obstruction onto another control. Preserve launcher visibility, safe-area clearance, focus restoration and touch-target size. |
| Low      | The narrow hero repeats the brand from the header, then places the category line and a long outage explanation before the action group. Desktop action bottoms were 636, 636 and 632 CSS px. On the phone, setup ends at 749, Sign in at 813 and visitor guidance at 869. This makes the organizational path easy to find but delays the visitor path. | If the owner wants faster visitor discovery, shorten the lead to the joining methods and one sentence about authorized offline service. Keep the server-confirmation explanation in the adjacent story. Recheck wrapping at large text and preserve the distinction between local and committed work.                                                              |
| Low      | In the desktop hero illustration the green confirmation badge clips the end of its own label. The same concept reads clearly in the larger continuity diagram.                                                                                                                                                                                         | Widen the badge or adjust its internal text placement in the illustration. Verify the complete label at desktop and intermediate widths without shrinking the type.                                                                                                                                                                                                |

## Fit against the approved design

The dark navy desktop hero gives the headline first reading priority. The bold three-line heading, restrained ticket illustration and filled setup button establish a clear path to organization onboarding. Sign in is secondary and visitor guidance uses a text link. On the phone the headline is still legible and the actions stack. Below the hero, the sequence moves from a worked example through audiences, capabilities, channel availability and visitor instructions to setup. The longer descriptions earn their space most clearly in the continuity story, where they explain what each device can claim. [Approved landing and design-system decision](../adr/ADR-014-final-ui-ux-landing-and-design-system.md)

The six-stage story keeps one identifiable ticket and coordinator in view. Text, labels and status changes explain joining, waiting, disconnection, authorized local work, reconciliation and the eventual call. A conflicting action stays visible for review. The diagram and stage list fit side by side on desktop. On the phone, the readable stacked list sits below the diagram and the controls wrap onto two rows. Five seconds per stage is brisk for the longer explanations, but readers can pause, step backward or forward and read all six descriptions independently. Retain that pacing and the static reduced-motion version. [Story implementation](../../apps/web/src/landing/ContinuityStory.tsx)

The local browser run exercised the seven-step signed-out checklist and the administrator checklist with links driven by readiness. The manifest-driven channel presentation identifies web and QR as live and SMS and USSD as sandbox/test-only in this configuration. The offline explanation reserves confirmation for the server, and the call stage describes alerts as best effort. These sections need no copy or workflow changes.

## Secondary screens

The visitor join screen gives recovery its own link, explains the queue discipline and places Get a ticket directly beneath the queue details. The empty estimate has an explicit explanation. The captured phone layout leaves the action clear of Ask Que. Recommend accepting this screen as rendered.

The staff queue separates live queue status and counter controls from walk-in registration and assisted recovery. Administration distinguishes existing facilities from the labeled creation form. Their headings, navigation selection and action colors are consistent. Both screen layouts can be accepted as rendered apart from the shared launcher placement review. These observations cover the captured states only.

## Verification and acceptance boundary

With the local Playwright database prerequisites satisfied, run `pnpm --filter @queuebridge/web test:e2e landing.spec.ts --project=desktop-chromium`. The focused suite completed with **24 passed, 0 failed, 0 skipped in 41.3 seconds**. It exercised story progression and reconciliation, system and device reduced motion, onboarding, manifest fallback, keyboard reachability and visible focus. Light, Dark, high-contrast and large-text cases passed their axe and horizontal-overflow assertions across the suite's 320–1440 px range. Passing those checks still permits the visual overlap captured above. [Executable browser evidence](../../apps/web/e2e/landing.spec.ts)

For approval, prioritize launcher clearance, then the illustration label. Treat hero copy compression as optional. Review any candidate against the same screenshots and focused suite, then check launcher obstruction on physical Android and iOS. This review supplies local rendered evidence only. Application implementation and deployment remain outside its scope.

## Owner-approved corrections

The fixed Ask Que button previously shared screen space with scrolling content. Extra padding on the last screenful protected the final control only. The application shell now scrolls within a height that leaves a dedicated bottom strip for the fixed launcher, including its existing safe-area inset. This keeps the same labeled button and mobile help sheet available throughout the page. The trade-off is less vertical reading space. At 375 × 812 users scroll to see the full set of hero actions.

The clipped label was in the desktop hero companion illustration. Its SVG placed the label 30 units inside a 92-unit badge. Widening the rectangle to 120 units gives the lettering room at its original size. A browser regression measures the right edge of the rendered text against its badge.

| Rendered check                                                                                     | Local result                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing, join, authenticated staff queue and administration at 320, 375, 768, 1280 and 1440 CSS px | At the top, quarter, halfway, three-quarter and end scroll settings, the page viewport ended 8 CSS px above the button. No measured shell overflow horizontally. Short pages naturally stay at their available scroll limit. |
| Chromium native 200% tab zoom                                                                      | Logged zoom factor 2 with a 1280 px window and 640 CSS px layout. Landing, sign-up and recovery retained clearance across the five scroll settings, with working open and Escape actions.                                    |
| Physical devices and installed mobile safe areas                                                   | Await human verification. Local mobile evidence uses Chromium viewports.                                                                                                                                                     |

### Paired visual evidence

| State         | Original                                | Correction                                   |
| ------------- | --------------------------------------- | -------------------------------------------- |
| desktop       | [Before](media/m7-ui/desktop.png)       | [After](media/m7-ui/after/desktop.png)       |
| phone         | [Before](media/m7-ui/phone.png)         | [After](media/m7-ui/after/phone.png)         |
| desktop-story | [Before](media/m7-ui/desktop-story.png) | [After](media/m7-ui/after/desktop-story.png) |
| phone-story   | [Before](media/m7-ui/phone-story.png)   | [After](media/m7-ui/after/phone-story.png)   |
| desktop-join  | [Before](media/m7-ui/desktop-join.png)  | [After](media/m7-ui/after/desktop-join.png)  |
| phone-join    | [Before](media/m7-ui/phone-join.png)    | [After](media/m7-ui/after/phone-join.png)    |
| staff         | [Before](media/m7-ui/staff.png)         | [After](media/m7-ui/after/staff.png)         |
| admin         | [Before](media/m7-ui/admin.png)         | [After](media/m7-ui/after/admin.png)         |

Changed files for this correction are `apps/web/src/styles.css`, `apps/web/src/landing/HeroArt.tsx`, `apps/web/e2e/header-controls.spec.ts`, `apps/web/e2e/landing.spec.ts`, this report, `docs/testing/M7-evidence.md` and the eight PNGs in the After column.

A first 74-case browser run recorded 69 passes, four existing capture-only skips and one failure. I ran a separate build while the preview was live. The trace recorded a previously successful ticket chunk returning HTTP 404 after the build replaced it. The final run used one stable preview throughout.

Final command with disposable TEST_DATABASE_URL and E2E_WEB_PORT=4192: `pnpm --filter @queuebridge/web test:e2e header-controls.spec.ts landing.spec.ts ui-layout.spec.ts accessibility-m52.spec.ts`. **119 passed, 4 existing capture-only skips, 0 failed in 3.0 minutes.** The saved-ticket transition passed. Local `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm format:check` passed.
