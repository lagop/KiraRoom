# Pull Request — KiraRoom

> One PR = one logical change. Keep the diff reviewable (< ~600 lines
> excluding generated files, fixtures, and lockfiles).

## Summary

<!-- What does this PR do, and why? Link the issue or RFC it resolves. -->

Fixes #

## What changed

- [ ]
- [ ]

## How it was tested

- [ ] `npm run lint` from repo root
- [ ] `npm run type-check` from repo root
- [ ] `npm test --workspace=@kira/backend` (or full `npm test`)
- [ ] `npm test --workspace=@kira/frontend` (or full `npm test`)
- [ ] Playwright (if UI-affecting): `npx playwright test <spec>`
- [ ] L1 e2e (if copilot-affecting): dispatched manually in CI
- [ ] Manual smoke (describe below)

### Manual smoke

<!-- Steps you ran locally -->

## Risk & rollback

- **Risk:** <!-- low / medium / high and why -->
- **Rollback plan:** <!-- revert merge commit / disable feature flag / etc. -->

## Checklist

- [ ] Branch is off `develop` (or `main` for `hotfix/*`)
- [ ] Commits are conventional (`feat:`, `fix:`, `chore:`, `docs:`,
      `refactor:`, `test:`, `security:`)
- [ ] No secrets, `.env*`, or `node_modules/` in the diff
- [ ] New env vars documented in `packages/backend/.env.example`
      (and frontend `NEXT_PUBLIC_*` if applicable)
- [ ] DB migrations are backwards-compatible (no destructive renames
      without a backfill in the same PR)
- [ ] Tests added/updated for the change
- [ ] `docs/` updated if the change is user-visible (staff guide, admin
      guide, runbook, changelog)
- [ ] Security-sensitive change? Reviewed by CODEOWNERS, no
      `ParseUUIDPipe` removed, no new `@Public()` without justification

## Screenshots / recordings

<!-- UI changes only -->
