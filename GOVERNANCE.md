# Governance

## Principles

1. **Neutral home.** The specification is owned by no vendor. It lives in a standalone GitHub organisation (`udmp-spec`, or the initiator's personal account until the org exists), not under any company. Companies sponsor; they do not own.
2. **Adversarial to lock-in, not to vendors.** Adapters use only documented, customer-accessible APIs. The project never ships code that circumvents authentication, scrapes rendered UIs, or violates terms of service. Vendors who ship first-party UDMP support are celebrated on the Exit Score.
3. **Spec and code evolve together.** No spec change lands without a passing validator and at least one adapter exercising it.

## Roles

- **Editors** (initially the initiator plus two elected contributors) merge spec changes. Editors serve one-year terms and are elected by maintainers.
- **Maintainers** merge code in `packages/`. Anyone with three merged non-trivial PRs may be nominated.
- **Adapter owners** own `adapter-<platform>` packages, including third-party ones listed in the registry. An adapter with no responsive owner for 90 days is marked unmaintained.
- **Scorecard reviewers** approve Exit Score changes. Two independent reviewers are required for any score change, and vendor employees may not review their own vendor.

## Decision process

- Minor spec changes (new optional key, new vocabulary term, clarification): one editor approval, 7-day comment window.
- Normative changes (new type, new MUST, conformance rule): UDMP Improvement Proposal in `spec/uips/`, two editor approvals, 21-day comment window, and a reference implementation.
- Breaking changes require a major version and a migration tool.

## Conflicts of interest

Every editor, maintainer and reviewer lists their employer in `MAINTAINERS.md`. A vote on a matter that materially affects a listed employer is recused.

## Trademark

"UDMP" and the logo are held by the project. Anyone may say their software *supports* UDMP if it passes `udmp validate` at the claimed conformance level. Nobody may call software "UDMP certified" without passing the public conformance suite.

## Funding

Sponsorships are listed publicly. No sponsor gets a seat, a veto, or early access.
