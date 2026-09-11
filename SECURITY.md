# Security Policy — KiraRoom

## Supported versions

| Version | Supported          |
|---------|--------------------|
| `develop` | ✅ active development |
| `main`    | ✅ production (post Sprint 18 GA) |
| older     | ❌ no backports |

Until the closed-beta (Sprint 17) opens, `develop` is the only branch that
receives security fixes; the production hotfix flow (`hotfix/<name>` off
`main`) is reserved for incidents that cannot wait for the next release.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security findings.**

Email: **security@kirastudio.dev** (PGP key on request).
Reply window: within 2 business days.

For sensitive disclosures (auth bypass, tenant-isolation break, PII leak,
RCE, crypto envelope failure), please include:

1. Repro steps / payload / screenshot.
2. Affected component (`packages/backend/src/<module>`).
3. Impact assessment (which tenants are affected, what data is exposed).
4. Your name and whether you'd like credit in the release notes.

We follow a 90-day disclosure timeline aligned with
[disclose.io](https://disclose.io/) core terms.

## Status of the security backlog

The full self-review is in
[`docs/security-review-2026-07.md`](docs/security-review-2026-07.md).

| ID  | Title                                          | Severity | State |
|-----|------------------------------------------------|----------|-------|
| SEC-1 | JWT_SECRET strength check at startup         | MEDIUM   | ✅ fixed (`hotfix/sec-1-sec-2`) |
| SEC-2 | `ParseUUIDPipe` on `@Param('id')` controllers | MEDIUM   | ✅ fixed |
| SEC-3 | Stripe webhook signature audit                | LOW      | ⚠️ open |
| SEC-4 | Document `@Public()` on `/auth/impersonate`   | LOW      | ⚠️ open |
| SEC-5 | Real third-party SMB pen-test (~€1.5–3k)      | HIGH     | ⏸ deferred until €500 MRR sustained for 2 months |

## Out of scope (right now)

- Reports about non-default configurations.
- Reports requiring physical access to a tenant's device.
- Reports about the marketing site (`packages/marketing/`) — static Astro,
  no auth surface.
- Theoretical DoS without a concrete repro.

## Acknowledgements

Reporters who follow this policy will be credited in the relevant release
notes (unless they ask to remain anonymous).
