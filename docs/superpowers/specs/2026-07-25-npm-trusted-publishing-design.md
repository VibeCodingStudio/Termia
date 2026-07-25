# npm Trusted Publishing Design

## Goal

Publish Termia from GitHub Actions through npm Trusted Publishing without an
npm token or GitHub secret.

## Design

- Add `.github/workflows/publish.yml`.
- Trigger the workflow only when a `v*` tag is pushed.
- Grant the job only `contents: read` and `id-token: write` permissions.
- Run on a GitHub-hosted Ubuntu runner with Node.js 24 and npm's registry.
- Require the tag to equal `v` plus the version in `package.json`.
- Install with `npm ci`, then run typecheck, tests, and
  `npm publish --access public`.
- Use npm's OIDC exchange automatically; do not store an npm access token.

## npm Configuration

The package owner will add this Trusted Publisher later from a browser that can
complete the account's WebAuthn check:

- Provider: GitHub Actions
- Organization or user: `VibeCodingStudio`
- Repository: `Termia`
- Workflow filename: `publish.yml`
- Environment: blank
- Allowed action: `npm publish`

After that binding exists, pushing `v0.1.4` will publish the current package.
The tag must not be pushed before the binding is confirmed.

## Failure Behavior

- A tag/version mismatch fails before installation or publication.
- Typecheck or test failures prevent publication.
- A missing or incorrect npm Trusted Publisher binding makes `npm publish`
  fail without exposing or falling back to a token.
- A failed workflow can be rerun after correcting the npm-side binding.

## Validation

- Validate the workflow syntax and inspect its effective permissions.
- Run `npm ci`, `npm run typecheck`, `npm test`, and
  `npm publish --dry-run --access public` locally.
- Do not create or push `v0.1.4` until the npm-side binding is confirmed.

## Scope

No runtime code, package dependencies, release bot, GitHub environment, or
long-lived npm credential is added.
