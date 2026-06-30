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

Three edits, all in `lib/coreBundle.js`, all inside the rebrowser runtime-fix machinery. They exist
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

## 3. Our three patches (re-apply / re-verify these on every upgrade)

All three live in the `__re__emitExecutionContext` method (and one line just above it). Find it:

```
grep -n "__re__emitExecutionContext" lib/coreBundle.js   # the method def is the big one (~line 33840)
grep -n "RUNTIME_FIX_MODE.*||"       lib/coreBundle.js   # the default-mode line
grep -n "this.utilityWorldName ="    lib/coreBundle.js   # confirms PW's current utility-world naming
grep -n "_onExecutionContextCreated" lib/coreBundle.js   # confirms the world-matching logic
```

### Patch A — utility-world name in `addBinding` mode

In the `fixMode === "addBinding"` branch, the `world === "utility"` case must emit the context under
**the page's current utility-world name**, not a hardcoded string:

```js
return {
  id: contextId,
  // Must equal crPage.utilityWorldName so _onExecutionContextCreated maps this to "utility".
  // PW ≥1.60 makes that name per-page (__playwright_utility_world_<guid>); the old hardcoded
  // "__playwright_utility_world__" no longer matches and hangs every locator query.
  name: frame?._page?.delegate?.utilityWorldName ?? "__playwright_utility_world__",
  auxData: { frameId: targetId, isDefault: false }
};
```

The upstream value to replace is the literal `name: "__playwright_utility_world__"`.

### Patch B — utility world support in `alwaysIsolated` mode

Upstream's `alwaysIsolated` branch ignores `world` and reports **everything** as the default (main)
world, so the utility world never exists → locators hang. Replace it so it mirrors the `addBinding`
mapping, backing **both** worlds with isolated worlds but giving them **distinct CDP world names**
(see the critical note below):

```js
} else if (fixMode === "alwaysIsolated") {
  // Back both main and utility with isolated worlds (never the real main world — that's the
  // detection vector). Report the utility request under crPage.utilityWorldName/isDefault:false
  // and the main request as the default world, so locators get a utility world AND evaluate stays
  // out of the page main world.
  //
  // CRITICAL: main and utility MUST use different CDP world names. Page.createIsolatedWorld keys on
  // worldName, so reusing one name returns the SAME execution context for both worlds, corrupting
  // the main/utility mapping (order-dependent hangs when a locator is the first operation).
  const isUtility = world === "utility";
  getWorldPromise = this.__re__getIsolatedWorld({
    client: this,
    frameId: targetId,
    worldName: isUtility ? utilityWorldName : `${utilityWorldName}__main`
  }).then((contextId) => {
    return {
      id: contextId,
      name: isUtility ? frame?._page?.delegate?.utilityWorldName ?? "__playwright_utility_world__" : "",
      auxData: { frameId: targetId, isDefault: !isUtility }
    };
  });
}
```

The upstream version creates one world with `worldName: utilityWorldName` and always returns
`{ name: "", auxData: { isDefault: true } }`.

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
     `publishConfig.access: public`, and set the new `version` to match the Playwright version.
   - Verify Layer 1 is present: `grep -c "__re__emitExecutionContext" lib/coreBundle.js` should be
     ≥ 1 and the `REBROWSER_PATCHES_*` env vars should appear.

2. **Re-apply our three patches (Section 3).** Don't blind-replace by line number — the bundle
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
- [ ] Patch A: utility name in `addBinding` = `frame?._page?.delegate?.utilityWorldName ?? "__playwright_utility_world__"`.
- [ ] Patch B: `alwaysIsolated` branches on `world`, distinct world names (`util` vs `util__main`).
- [ ] Patch C: default mode `|| "alwaysIsolated"`.
- [ ] `_onExecutionContextCreated` matching + `crPage.utilityWorldName` assumptions still hold.
- [ ] `browsers.json` revision updated; browser installed.
- [ ] Wrapper version + core pin bumped.
- [ ] `npm run test:all` green (features + bot-detector, not skipped).
- [ ] Downstream consumers re-pinned and re-tested.
