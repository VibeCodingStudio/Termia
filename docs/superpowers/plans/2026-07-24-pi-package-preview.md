# Pi Package Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a clean Termia product preview through the Pi package manifest.

**Architecture:** Create one repository-owned PNG from the existing real Termia screenshot, then expose it through the package's `pi.image` metadata. Keep the asset in the npm tarball and point Pi at its stable raw GitHub URL.

**Tech Stack:** PNG, npm package manifest, Pi package metadata

## Global Constraints

- The preview must show a real Termia `/termia-history` view.
- The image must not expose real usernames, hosts, IP addresses, prices, tokens, or session identifiers.
- The final asset must be a readable 16:9 PNG at `assets/termia-preview.png`.
- Runtime behavior and terminal UI code must not change.

---

### Task 1: Create and publish the package preview

**Files:**
- Source: `/mnt/d/Documents/ShareX/Screenshots/2026-07/WindowsTerminal_gNh7EjmdxU.png`
- Create: `assets/termia-preview.png`
- Modify: `package.json`

**Interfaces:**
- Consumes: Pi's `pi.image` package metadata field.
- Produces: `https://raw.githubusercontent.com/VibeCodingStudio/Termia/main/assets/termia-preview.png`.

- [ ] **Step 1: Run the metadata assertion before editing**

Run:

```bash
node -e 'const p=require("./package.json"); const a=require("node:assert/strict"); a.equal(p.pi.image,"https://raw.githubusercontent.com/VibeCodingStudio/Termia/main/assets/termia-preview.png"); a.ok(p.files.includes("assets"))'
```

Expected: FAIL because `pi.image` and the `assets` package entry do not exist.

- [ ] **Step 2: Create the clean preview PNG**

Inspect the source screenshot, then edit it into a 16:9 package preview. Preserve the authentic Termia history overlay and terminal styling, replace identifying values with neutral examples, remove surrounding visual clutter, and save the result as `assets/termia-preview.png`.

- [ ] **Step 3: Add the asset and Pi image metadata**

Set the relevant manifest fields to:

```json
{
  "files": ["extensions", "assets", "README.md", "LICENSE"],
  "pi": {
    "extensions": ["./extensions/termia/index.ts"],
    "image": "https://raw.githubusercontent.com/VibeCodingStudio/Termia/main/assets/termia-preview.png"
  }
}
```

- [ ] **Step 4: Inspect the image and verify metadata**

Inspect `assets/termia-preview.png` visually and run:

```bash
node -e 'const p=require("./package.json"); const a=require("node:assert/strict"); a.equal(p.pi.image,"https://raw.githubusercontent.com/VibeCodingStudio/Termia/main/assets/termia-preview.png"); a.ok(p.files.includes("assets"))'
```

Expected: PASS with no output.

- [ ] **Step 5: Run the repository verification bundle**

Run:

```bash
npm test
npm run typecheck
npm pack --dry-run --json
git diff --check
```

Expected: tests and typecheck pass; the dry-run tarball includes `assets/termia-preview.png`; `git diff --check` prints nothing.

- [ ] **Step 6: Commit the preview**

```bash
git add assets/termia-preview.png package.json docs/superpowers/plans/2026-07-24-pi-package-preview.md
git commit -m "feat: add Pi package preview"
```
