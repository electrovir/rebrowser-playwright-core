# Upgrading Playwright while keeping the stealth patches

> Audience: a future Claude (or human) tasked with moving `@electrovir/rebrowser-playwright(-core)`
> to a newer Playwright version **without losing stealth or breaking locators**.

Read this whole file before touching anything. The patches are subtle and the failure mode
(locators silently hanging, or stealth silently regressing) is easy to ship.

---

## 1. The big picture

There are **two packages** and **two layers of patches**.

### Packages

| Package | Repo | Role |
| --- | --- | --- |
| `@electrovir/rebrowser-playwright-core` | `~/repos/electrovir/rebrowser-playwright-core` | The patched `playwright-core`. **All stealth logic lives here**, baked into `lib/coreBundle.js`. |
| `@electrovir/rebrowser-playwright` | `~/repos/electrovir/rebrowser-playwright` | Thin wrapper. Depends on the core via an npm alias (`playwright-core: npm:@electrovir/rebrowser-playwright-core@~X`). **No stealth code; no `coreBundle.js`.** Almost never needs editing except its dependency pin + version. |

Both repos are **published build artifacts** — there is no `src/`, no build step, and a single
`init` commit. You edit the compiled bundle (`lib/coreBundle.js`) directly. (If a future maintainer
sets up a real patch→build pipeline, this guide's "where" still applies; the "how to edit" becomes
"edit the patch source then rebuild".)

### Versioning scheme

The first two version segments track the upstream Playwright version. The patch segment is
fork-local and encodes `<upstream-patch><fork-revision>` (zero-padded), so it always sorts *after*
the upstream release while staying pinned to a recognizable base:

- `1.61.100` → based on Playwright `1.61.1`, fork revision `00` (initial publish for this base).
- Fork-only fix that does *not* change the Playwright version → `1.61.101`, then `1.61.102`, …
- New upstream base `1.61.2` → fork versions restart at `1.61.200`.

**Never** use a pre-release tag (`1.61.1-fix.1`) for a fork fix: pre-releases sort *before* `1.61.1`
and are excluded from normal `^`/`~` ranges. Bump the fork revision (both packages) on every
publish, and reset it when the upstream base changes.

### Layer 1 — rebrowser-patches (upstream stealth)

This is the community project [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches).
It modifies Playwright so automated execution is hidden from bot detectors. Its fingerprints in
`coreBundle.js`:

- functions/identifiers prefixed `__re__` (e.g. `__re__emitExecutionContext`,
  `__re__getMainWorld`, `__re__getIsolatedWorld`).
- env vars `REBROWSER_PATCHES_RUNTIME_FIX_MODE`, `REBROWSER_PATCHES_UTILITY_WORLD_NAME`,
  `REBROWSER_PATCHES_DEBUG`.

What it buys us (verified by the bot-detector test): no `Runtime.enable` leak, no
`mainWorldExecution` / `sourceUrlLeak` when running isolated, no `__pwInitScripts` leak.

**Modes** (set via `REBROWSER_PATCHES_RUNTIME_FIX_MODE`):

- `addBinding` — upstream default. `page.evaluate` runs in the page's **main world** (so it can
  read page JS globals), Runtime leak still suppressed. Detectable on `mainWorldExecution`.
- `alwaysIsolated` — `page.evaluate` runs in an **isolated world** (shares DOM, not page JS). This
  is the stealthy mode; it's what hides `mainWorldExecution`/`sourceUrlLeak`.
- `0` — patches disabled (stock Playwright behavior + leaks). Used only as a test control.

### Layer 2 — our patches (this fork's additions)

Three edits (one now shipped upstream), all in `lib/coreBundle.js`, all inside the rebrowser runtime-fix machinery. They exist
because porting rebrowser-patches to **Playwright ≥ 1.60 broke locators**, and because we want
maximum stealth by default. **These are the things most likely to break on upgrade.** Section 3
documents each one.

---

## 2. Why locators broke (the mental model you need)

Playwright uses **two JS worlds per frame**:

- **main world** — where `page.evaluate` runs by default.
- **utility world** — a separate isolated world where Playwright runs *locator* queries, plus
  `page.title()`, `waitForSelector`, `textContent`, actionability checks, etc.

rebrowser's runtime fix suppresses `Runtime.enable`, so Playwright never receives the normal
`Runtime.executionContextCreated` events. Instead the patch **lazily creates worlds on demand** and
**synthesizes** those events (`__re__emitExecutionContext` → `this.emit("Runtime.executionContextCreated", …)`).

Playwright then maps each synthesized context to a world in `_onExecutionContextCreated`:

```js
if (contextPayload.auxData?.isDefault) worldName = "main";
else if (contextPayload.name === this._crPage.utilityWorldName) worldName = "utility";
```

So a synthesized context is only recognized as the **utility** world if its `name` **exactly
matches** `crPage.utilityWorldName`. **Playwright 1.60 changed that name** from a static
`"__playwright_utility_world__"` to a **per-page** value:

```js
// CRPage constructor, in coreBundle.js:
this.utilityWorldName = `__playwright_utility_world_${this._page.guid}`;
```

The upstream patch was still emitting the old static name → no match → utility world never
registered → **every locator / title / waitForSelector hangs until timeout.** That's the bug our
patches fix. If a *future* Playwright changes the utility-world naming or the matching logic again,
locators will hang again and you'll be back here.

---

## 3. Our patches (re-apply / re-verify these on every upgrade)

All of them live in the `__re__emitExecutionContext` method (and one line just above it). Find it:

```
grep -n "__re__emitExecutionContext" lib/coreBundle.js   # the method def is the big one (~line 33840)
grep -n "RUNTIME_FIX_MODE.*||"       lib/coreBundle.js   # the default-mode line
grep -n "this.utilityWorldName ="    lib/coreBundle.js   # confirms PW's current utility-world naming
grep -n "_onExecutionContextCreated" lib/coreBundle.js   # confirms the world-matching logic
```

### Patch A — utility-world name (upstream since rebrowser 1.64.102)

The `world === "utility"` case must emit the context under **the page's current utility-world
name** (`frame?._page?.delegate?.utilityWorldName`), not a hardcoded string. Upstream rebrowser
1.64.102 does this itself: it sets `CRPage.utilityWorldName` from `REBROWSER_PATCHES_UTILITY_WORLD_NAME`
(default `"util"`) and handles `world === "utility"` before branching on the fix mode, so there is
nothing to re-apply. Re-check it if upstream ever emits a literal `name: "__playwright_utility_world__"`
again.

### Patch B — distinct world names in `alwaysIsolated` mode

In the `fixMode === "alwaysIsolated" && frame` branch (the main-world request), upstream creates the
isolated world with `worldName: utilityWorldName`, the same name the utility branch uses. Change it
to `` worldName: `${utilityWorldName}__main` ``:

```js
} else if (fixMode === "alwaysIsolated" && frame) {
  // CRITICAL: main and utility MUST use different CDP world names. ...
  const contextId4 = await this.__re__getIsolatedWorld({ client: this, frameId: targetId, worldName: `${utilityWorldName}__main` });
  contextPayload = { id: contextId4, name: "", auxData: { frameId: targetId, isDefault: true } };
}
```

On 1.64.102 the features test passes with or without this edit, so it is no longer proven necessary.
It is kept so `page.evaluate` and Playwright's injected locator scripts never share one JS world.

### Patch C — default mode is `alwaysIsolated`

We flip the default so the stealthy mode is on without callers setting an env var:

```js
const fixMode = process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] || "alwaysIsolated";
```

Upstream is `|| "addBinding"`. This is the **only** place the default mode is decided (the other
`REBROWSER_PATCHES_RUNTIME_FIX_MODE` reads are `=== "0"` / `!== "0"` on/off checks — leave them).

> Trade-off this default implies: under `alwaysIsolated`, `page.evaluate` cannot read the page's own
> `window.*` globals (it shares the DOM, not the JS world). DOM-only automation is unaffected. If a
> consumer relies on page globals in `page.evaluate`, audit those call sites first: DOM reads are
> fine; reads of page-authored `window.*` globals are not.

---

## 4. The upgrade procedure

1. **Get the patched core for the target Playwright version.**
   - If upstream `rebrowser-playwright`/`rebrowser-patches` already supports the target version,
     start from their published `playwright-core` build (or run their patch tool against
     `playwright-core@<target>`).
   - Re-scope `package.json` `name` to `@electrovir/rebrowser-playwright-core`, keep
     `publishConfig.access: public`, and set the new `version` per the scheme below.
   - Verify Layer 1 is present: `grep -c "__re__emitExecutionContext" lib/coreBundle.js` should be
     ≥ 1 and the `REBROWSER_PATCHES_*` env vars should appear.

2. **Re-apply our patches (Section 3).** Don't blind-replace by line number — the bundle
   shifts every release. Use the `grep` anchors, read the surrounding code, and confirm the
   assumptions still hold:
   - Does `_onExecutionContextCreated` still match utility via `contextPayload.name === this._crPage.utilityWorldName`? If the matching changed, Patch A/B's `name:` value must change to match.
   - Is the CRPage utility name still `this._page.delegate.utilityWorldName`? Confirm
     `frame._page.delegate` is still the path from a Frame to the CRPage (grep `this._page.delegate`
     inside the `context(world …)` method — it uses the same path).
   - Is the default-mode line still `… || "addBinding"`? Flip it (Patch C).

3. **Update the wrapper** `@electrovir/rebrowser-playwright`: bump its `version` and the
   `playwright-core: npm:@electrovir/rebrowser-playwright-core@~<new>` dependency pin.

4. **Update `browsers.json`** in the core (the Chromium revision the new Playwright expects) and
   install it locally for testing: `node cli.js install chromium`.

5. **Run the gate (Section 5).** Everything must pass before publishing.

6. **Publish** core first, then the wrapper. Then bump the pin in downstream consumers and re-run
   their suites.

---

## 5. Verification gate — `npm run test:all`

From `~/repos/electrovir/rebrowser-playwright-core`:

```bash
node cli.js install chromium   # once, if the browser for this version isn't installed
npm run test:all               # features (offline) + bot-detector (live)
```

The suite (`tests/`) is **version-agnostic behavioral verification** — it asserts outcomes, not
internals, so it keeps working across Playwright versions and is exactly the canary you need:

- **`features.test.mjs` (offline)** — the canary for **our locator/world fixes**:
  - package default actually runs `evaluate` isolated (Patch C),
  - selectors / `title()` / `waitForSelector` / `textContent` / clicks / navigating clicks / DOM
    `evaluate` all work in `alwaysIsolated`, `addBinding`, **and** `0` (Patches A & B),
  - `alwaysIsolated` hides main-world globals while `addBinding`/`0` expose them (control).
  - **If a locator test hangs for ~30s then fails, the utility-world mapping broke** — re-check
    Patches A/B against the new `_onExecutionContextCreated` / `utilityWorldName`.

- **`bot-detector.test.mjs` (live, against `bot-detector.rebrowser.net`)** — the canary for
  **stealth**:
  - `alwaysIsolated` → `runtimeEnableLeak` 🟢, `pwInitScripts` 🟢, `mainWorldExecution` not flagged,
    `sourceUrlLeak` not flagged,
  - `addBinding` control → detector *does* flag `mainWorldExecution` (proves the test is meaningful).
  - Skips (doesn't fail) if the detector is unreachable, so don't treat a skip as a pass — re-run
    with network.

CI runs this on every push via `.github/workflows/test.yml` (`npm run test:all`).

> A subtle bug Patch B originally shipped with: the `alwaysIsolated` selector only hung when a
> locator was the **first** operation (an `evaluate`-first sequence masked it). The features test
> exercises locator-first on purpose. Keep it that way.

---

## 6. Quick checklist

- [ ] Layer 1 (rebrowser) present for the new version (`__re__*`, `REBROWSER_PATCHES_*`).
- [ ] Patch A: utility context emitted under `frame?._page?.delegate?.utilityWorldName` (upstream since 1.64.102).
- [ ] Patch B: `alwaysIsolated` main world uses a distinct world name (`util` vs `util__main`).
- [ ] Patch C: default mode `|| "alwaysIsolated"`.
- [ ] `_onExecutionContextCreated` matching + `crPage.utilityWorldName` assumptions still hold.
- [ ] `browsers.json` revision updated; browser installed.
- [ ] Wrapper version + core pin bumped.
- [ ] `npm run test:all` green (features + bot-detector, not skipped).
- [ ] Downstream consumers re-pinned and re-tested.
