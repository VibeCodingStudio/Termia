# Pi Package Preview Design

## Goal

Add a clean, authentic Termia preview image to its Pi package page.

## Design

- Show a real Termia terminal view with `/termia-history` open.
- Use neutral example commands and paths; do not expose real usernames, hosts,
  IP addresses, prices, tokens, or session identifiers.
- Crop the preview to a 16:9 PNG that remains readable as a package card.
- Store it at `assets/termia-preview.png` so the repository and npm package own
  the published visual.
- Add `pi.image` to `package.json`, pointing to the image's public GitHub raw URL.

## Validation

- Inspect the generated PNG for legibility and accidental private data.
- Verify the configured image URL returns the PNG.
- Run the existing test, typecheck, and npm pack checks.

## Scope

No runtime behavior, terminal UI, or package installation behavior changes.
