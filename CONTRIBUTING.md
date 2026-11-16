# Contributing

## Setup

```
pnpm install
pnpm build
pnpm test
```

Node 22.5 or newer is required (the SQLite importer uses the built-in `node:sqlite` module).

## Where things live

| Path | What |
|---|---|
| `spec/SPEC.md` | The normative specification. |
| `spec/VOCABULARY.md` | Semantic tags. |
| `spec/EXIT-SCORE.md` | The public vendor rubric. |
| `schemas/` | JSON Schema for the manifest. |
| `packages/core` | Types, validation, bundle reader/writer, integrity checks, export runner, SQLite importer. |
| `packages/cli` | The `udmp` command. |
| `packages/adapter-*` | Exporters. |
| `examples/` | Conformant sample bundles used by tests. |
| `scorecards/` | Exit Score data. |

## Writing an adapter

See `spec/ADAPTER-GUIDE.md`. The short version:

1. `pnpm create` a package `packages/adapter-<platform>` from `packages/adapter-linear`.
2. Implement `discover`, `read` and `fetchBlob` from `@udmp/core`.
3. Tag objects and fields with terms from `spec/VOCABULARY.md`.
4. Add a recorded-fixture test so CI runs without credentials.
5. Add `scorecards/<platform>.json` with evidence links.

## Pull requests

- Spec changes: say which section, whether it is normative, and link the adapter or validator change that exercises it.
- Keep PRs to one concern.
- Tests run with `node --test`; no network in CI.

## Code of conduct

Be direct, be kind, assume good faith, and never attack a vendor's people. Attack lock-in.
