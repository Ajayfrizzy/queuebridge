## Summary

<!-- What changes and why. Reference the feature (F1–F15) or milestone (M0–M7, MQ). -->

## Ask Que knowledge base (MQ.6 maintenance rule)

If this PR changes user-visible behaviour, a capability, a route or a screen label:

- [ ] Affected articles in `packages/assist/knowledge` updated, with version bumps, `kbVersion` bumped and `kb.lock.json` regenerated
- [ ] `packages/assist/knowledge/capabilities.json` updated for any capability status or availability change
- [ ] New screens registered in `packages/assist/src/registry.ts` with default articles; new articles added to the coverage matrix
- [ ] Not applicable: no user-visible change

CI enforces these checks (Group 13.5, `packages/assist/knowledge/README.md`).

## Validation

- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`
- [ ] `pnpm test`, `pnpm test:db`, Playwright
- [ ] Evidence updated in `docs/testing/`
