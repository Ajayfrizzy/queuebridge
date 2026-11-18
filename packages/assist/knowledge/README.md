# Ask Que knowledge base

Source articles for Ask Que (F13), compiled by `scripts/build-kb.mjs` into one versioned JSON
bundle per audience (`dist/kb/<audience>.json`). Design: `.kiro/specs/queuebridge/design.md` §11.2
and §11.5.

**Status (MQ.2):** the four articles here are _initial delivery content_, written only to prove
compilation, the public and restricted endpoints, offline caching and the D4 privacy check. The
full M1–M5 inventory (design §11.10a), the content review checklist and the article-existence
check belong to MQ.5.

## Rules

- One file per article: `knowledge/<audience>/<article-id>.md`. The folder must be one of the
  article's audiences; the file name must equal the `id`.
- Front-matter: `key: value`, inline lists `[a, b]`, integers. Every field of `KbArticle` is
  required. The body is Safe Markdown: headings, lists, emphasis and `[text](route:<RouteId>)`
  links only.
- No tenant data: no emails, phone numbers, UUIDs, ticket codes, placeholders or secrets (the
  build fails).
- Staff-only articles may list `privatePhrases`; the build fails if any public article contains
  one (decision D4). The key is build-time only and is never shipped.
- Any content change needs a higher article `version`; any change to the set needs a higher
  `kbVersion` in `kb.json`. Then run `pnpm --filter @queuebridge/assist kb:lock` and commit
  `kb.lock.json`. The normal build only checks the lock.
