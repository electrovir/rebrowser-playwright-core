# rebrowser-playwright-core

A fork of https://www.npmjs.com/package/rebrowser-playwright-core, updated to newer Playwright versions.

## Versioning

The first two version segments track the upstream Playwright version this fork is based on. The
patch segment is fork-local and encodes the upstream patch plus this fork's revision as
`<upstream-patch><fork-revision>`, zero-padded so it always sorts after the upstream release.

The fork revision starts at `00`, so the initial publish for a given Playwright base ends in `00`:
`1.61.100` is based on Playwright `1.61.1` with no fork-only changes yet. A fork-only fix that does
*not* change the underlying Playwright version bumps the revision: `1.61.101`, then `1.61.102`, and
so on. When the upstream base changes to `1.61.2`, the fork versions restart at `1.61.200`.

This keeps the fork's version pinned to a recognizable upstream base while still sorting *after* that
base (so `^1.61.x` consumers pick it up) and avoiding collisions with real upstream patch releases.
Do not use a pre-release tag (e.g. `1.61.1-fix.1`) for fork fixes: pre-releases sort *before*
`1.61.1` and are excluded from normal semver ranges.

