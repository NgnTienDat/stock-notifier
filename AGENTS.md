# StockNotifier — Codex Instructions

## Project goal

Build a Shopify embedded inventory notifier that works locally on a Development Store. Target: a usable **3-day MVP**, not production deployment.

## Repository layout

- `docs/`: approved product, architecture, database, implementation, and acceptance specifications.
- `stock-notifier-app/`: the actual Shopify React Router application. Run app commands from this directory.
- Keep the official Shopify template conventions. Do not move or recreate generated/template files without a concrete reason.

## Source of truth

Read only the documents relevant to the requested task, using these roles:

1. `docs/PRD.md` — MVP scope and business rules.
2. `docs/ARCHITECTURE.md` — Shopify integration, transactions, module boundaries.
3. `docs/DATABASE.md` — models, relations, constraints.
4. `docs/IMPLEMENTATION_PLAN.md` — three-day implementation order.
5. `docs/ACCEPTANCE_CRITERIA.md` — tests and Definition of Done.

If documents disagree, identify the conflict and ask before changing product behavior or schema.

## Implementation rules

- Follow the official Shopify React Router template; TypeScript strict, React, Prisma, PostgreSQL, Telegram Bot API, and tests using the project's configured runner.
- Use Shopify Admin **GraphQL** API and template authentication/session handling. Verify version-specific API fields, scopes, and webhook topics against official Shopify docs.
- Keep routes thin: authentication, input validation, response; put business logic in services and persistence in repositories/Prisma access.
- Scope every database read/write to the authenticated Shopify shop and the monitored inventory location; legacy selection is only a compatibility/display preference after discovery.
- Deduplicate and authenticate webhooks; guard against stale events and concurrent updates. Persist inventory and alert transitions atomically before sending Telegram.
- Secrets belong in environment variables. Never commit credentials, tokens, `.env`, or local session data.
- Do not introduce Redis, queues, microservices, AI, advanced analytics, or production infrastructure for this MVP. M2 adds automatic discovery/sync for all active locations; all-location webhook routing remains M3, Dashboard/digests M4.
- Do not implement P1 features until P0 is working unless explicitly instructed.

## Workflow and verification

1. Before implementation, inspect existing code, migration state, package scripts, and affected docs. Reuse the template instead of generating a new app.
2. Work only on the requested milestone. Keep changes minimal and reviewable; do not start the next day automatically.
3. Add focused tests for business rules and critical integration behavior. Run available typecheck, tests, lint/build as appropriate; report exact results and any unrun checks.
4. Do not claim success without observed evidence. If Shopify credentials, live webhooks, Telegram, or database are unavailable, report the blocker and what was verified offline.
5. End each milestone with changed files, behavior implemented, tests run, remaining P0 gaps, and a PASS/FAIL verdict against its gate.

Start with Day 1 in `docs/IMPLEMENTATION_PLAN.md` only when requested.
