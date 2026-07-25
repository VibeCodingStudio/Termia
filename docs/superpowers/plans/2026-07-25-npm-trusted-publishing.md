# npm Trusted Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish tagged Termia releases through npm Trusted Publishing without a stored npm token.

**Architecture:** A single GitHub Actions workflow handles `v*` tags. It validates that the tag matches `package.json`, verifies the package, and lets npm exchange GitHub's OIDC identity for publish access.

**Tech Stack:** GitHub Actions, Node.js 24, npm 11, npm Trusted Publishing

## Global Constraints

- Add no package dependency, GitHub environment, npm token, or other long-lived credential.
- Grant only `contents: read` and `id-token: write` permissions.
- Do not create or push `v0.1.4` until the npm Trusted Publisher binding is confirmed.

---

### Task 1: Add the Trusted Publishing workflow

**Files:**
- Create: `.github/workflows/publish.yml`

**Interfaces:**
- Consumes: Git tags named `v<package.json version>` and npm's GitHub Actions OIDC provider.
- Produces: A verified `npm publish --access public` run for matching release tags.

- [x] **Step 1: Create the workflow**

```yaml
name: Publish

on:
  push:
    tags:
      - "v*"

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          package-manager-cache: false
      - name: Validate tag
        run: |
          node -e 'const { version } = require("./package.json"); if (process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error(`tag ${process.env.GITHUB_REF_NAME} does not match package version ${version}`)'
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm publish --access public
```

- [x] **Step 2: Validate the workflow and package**

Run:

```bash
python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/publish.yml")); print("valid YAML")'
npm ci
npm run typecheck
npm test
npm publish --dry-run --access public
```

Expected: YAML prints `valid YAML`; dependency installation, typecheck, tests,
and the publish dry run all succeed.

- [x] **Step 3: Commit and push the configuration**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: add npm trusted publishing"
git push origin main
```

Expected: `main` is pushed with the workflow, but no release tag is created.
