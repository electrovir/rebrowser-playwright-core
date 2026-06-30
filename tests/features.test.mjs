/**
 * Verifies that Playwright features work across runtime-fix modes — specifically the locator /
 * utility-world regression that the patch fixes — and that `alwaysIsolated` keeps `evaluate` out of
 * the page's main world.
 *
 * Offline: all pages are served via request interception, so no network is required.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {launchForMode, page1Url, page2Url} from './helpers.mjs';

const timeout = 60000;

test('the package default runs evaluate in an isolated world (alwaysIsolated)', {timeout}, async () => {
    const {page, cleanup} = await launchForMode(undefined);
    try {
        await page.goto(page1Url);
        const marker = await page.evaluate(() => window.__mainWorldMarker);
        assert.equal(
            marker,
            undefined,
            'default mode must isolate evaluate from the page main world',
        );
        // DOM is shared across worlds, so this must still resolve.
        const heading = await page.evaluate(() => document.querySelector('h1')?.textContent);
        assert.equal(heading, 'Example Heading');
    } finally {
        await cleanup();
    }
});

/**
 * The core regression: locators / title() / waitForSelector run in Playwright's UTILITY world.
 * Before the fix these hung forever in `addBinding` (Playwright 1.60 name mismatch) and in
 * `alwaysIsolated` (no separate utility world). They must work in every mode now.
 */
for (const mode of [
    'alwaysIsolated',
    'addBinding',
    '0',
]) {
    test(`utility-world + DOM features work in mode=${mode}`, {timeout}, async () => {
        const {page, cleanup} = await launchForMode(mode);
        try {
            await page.goto(page1Url);

            // selector queries (utility world)
            assert.equal(await page.getByRole('heading').textContent(), 'Example Heading');
            assert.equal(await page.locator('#lnk').textContent(), 'Learn more');

            // title() and waitForSelector (utility world)
            assert.equal(await page.title(), 'Page One');
            assert.ok(await page.waitForSelector('#btn'), 'waitForSelector should resolve');

            // evaluate DOM access
            assert.equal(
                await page.evaluate(() => document.querySelector('h1')?.textContent),
                'Example Heading',
            );

            // click with no navigation: inline onclick runs in the page world and sets the title
            await page.getByRole('button').click();
            assert.equal(await page.title(), 'clicked', 'page-world click handler should fire');

            // navigating click
            await page.getByRole('link').click();
            await page.waitForURL(page2Url);
            assert.equal(page.url(), page2Url);
            assert.equal(await page.getByRole('heading').textContent(), 'Second Page');
        } finally {
            await cleanup();
        }
    });
}

test('alwaysIsolated hides main-world globals from evaluate; addBinding/0 expose them', {timeout}, async () => {
    const seen = {};
    for (const mode of [
        'alwaysIsolated',
        'addBinding',
        '0',
    ]) {
        const {page, cleanup} = await launchForMode(mode);
        try {
            await page.goto(page1Url);
            seen[mode] = await page.evaluate(() => window.__mainWorldMarker);
        } finally {
            await cleanup();
        }
    }

    assert.equal(seen.alwaysIsolated, undefined, 'alwaysIsolated must NOT see the page main world');
    assert.equal(seen.addBinding, 'MAIN_WORLD_LEAK', 'addBinding evaluates in main world (control)');
    assert.equal(seen['0'], 'MAIN_WORLD_LEAK', 'fix-disabled evaluates in main world (control)');
});
