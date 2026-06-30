/**
 * Shared helpers for the rebrowser-patches behavior tests.
 *
 * These are integration tests: they launch a real (headless) patched Chromium and drive it with
 * Playwright. They require the matching browser binary to be installed (run
 * `node cli.js install chromium` once if it isn't).
 *
 * The runtime-fix mode is selected via the REBROWSER_PATCHES_RUNTIME_FIX_MODE env var, read lazily
 * per evaluate by the patch. Pass `undefined` to exercise the package default.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from '../index.mjs';

export const page1Url = 'http://rebrowser.test/page1';
export const page2Url = 'http://rebrowser.test/page2';

/**
 * page1 carries a main-world marker set by the page's OWN inline script. Isolated-world code has a
 * separate `window`, so reading this marker tells us which world `evaluate` ran in. It also has a
 * link (navigating click) and a button whose inline onclick mutates the DOM (page-world handler).
 */
const page1Html = [
    '<!doctype html><html><head><title>Page One</title></head><body>',
    '<h1>Example Heading</h1>',
    '<a id="lnk" href="http://rebrowser.test/page2">Learn more</a>',
    '<button id="btn" onclick="document.title=\'clicked\'">Press</button>',
    '<script>window.__mainWorldMarker = "MAIN_WORLD_LEAK";</script>',
    '</body></html>',
].join('');

const page2Html = [
    '<!doctype html><html><head><title>Page Two</title></head><body>',
    '<h1>Second Page</h1>',
    '</body></html>',
].join('');

/**
 * Launch a fresh headless persistent context for the given runtime-fix mode, serving the offline
 * fixture pages via request interception (no network needed). Returns the page plus a cleanup fn.
 */
export async function launchForMode(mode) {
    if (mode === undefined) {
        delete process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE;
    } else {
        process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = mode;
    }

    const userDataDir = await mkdtemp(join(tmpdir(), 'rbp-test-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
    });
    await context.route('**/*', async (route) => {
        const body = route.request().url().includes('/page2') ? page2Html : page1Html;
        await route.fulfill({
            contentType: 'text/html',
            body,
        });
    });

    const page = context.pages()[0] ?? (await context.newPage());

    async function cleanup() {
        await context.close();
        await rm(userDataDir, {
            recursive: true,
            force: true,
        });
    }

    return {
        context,
        page,
        cleanup,
    };
}
