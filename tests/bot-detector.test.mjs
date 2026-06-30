/**
 * Verifies stealth against rebrowser's OWN hosted detector (https://bot-detector.rebrowser.net).
 *
 * Network-dependent: if the detector is unreachable, the tests skip rather than fail. The detector
 * is a live third-party page; the assertions key off its per-test status markers (🟢 ok / 🔴 leak /
 * ⚪️ not-triggered). If the page structure changes the tests skip with a note instead of failing.
 *
 * The "active" world-execution tests (dummyFn, mainWorldExecution, sourceUrlLeak) only fire when we
 * run their trigger from Playwright's evaluate world — so we trigger them, then read the verdicts.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from '../index.mjs';

const detectorUrl = 'https://bot-detector.rebrowser.net/';
const timeout = 90000;

async function runDetector(mode) {
    if (mode === undefined) {
        delete process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE;
    } else {
        process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = mode;
    }

    const userDataDir = await mkdtemp(join(tmpdir(), 'rbp-bd-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
    });
    const page = context.pages()[0] ?? (await context.newPage());

    async function cleanup() {
        await context.close();
        await rm(userDataDir, {
            recursive: true,
            force: true,
        });
    }

    try {
        await page.goto(detectorUrl, {
            waitUntil: 'commit',
            timeout: 20000,
        });
    } catch {
        await cleanup();
        return undefined;
    }

    await page.waitForTimeout(5000);
    // Trigger the active world-execution tests from Playwright's evaluate world. In an isolated
    // world these run against the isolated world's own DOM bindings and never fire the page's traps.
    await page.evaluate(() => {
        try {
            window.dummyFn && window.dummyFn();
        } catch {}
    }).catch(() => {});
    await page.evaluate(() => {
        try {
            document.getElementsByClassName('div');
        } catch {}
    }).catch(() => {});
    await page.evaluate(() => {
        try {
            document.getElementById('detections-json');
        } catch {}
    }).catch(() => {});
    await page.waitForTimeout(3000);

    const rows = await page.evaluate(() => {
        return [...document.querySelectorAll('table tr')]
            .map((tr) => tr.innerText.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
    });
    await cleanup();
    return rows;
}

/** Returns 'red' | 'green' | 'white' | undefined for a named detector test row. */
function statusFor(rows, name) {
    const row = rows.find((entry) => entry.includes(name));
    if (!row) {
        return undefined;
    }
    if (row.includes('🔴')) {
        return 'red';
    }
    if (row.includes('🟢')) {
        return 'green';
    }
    return 'white';
}

test('alwaysIsolated passes rebrowser bot-detector (no main-world / runtime / sourceUrl leak)', {timeout}, async (t) => {
    const rows = await runDetector('alwaysIsolated');
    if (!rows) {
        t.skip('bot-detector.rebrowser.net unreachable');
        return;
    }
    if (statusFor(rows, 'runtimeEnableLeak') == undefined) {
        t.skip('detector page structure changed (expected rows not found)');
        return;
    }

    assert.equal(statusFor(rows, 'runtimeEnableLeak'), 'green', 'runtimeEnableLeak should report no leak');
    assert.equal(statusFor(rows, 'pwInitScripts'), 'green', 'pwInitScripts should report no leak');
    assert.notEqual(statusFor(rows, 'mainWorldExecution'), 'red', 'mainWorldExecution must NOT be detected under isolation');
    assert.notEqual(statusFor(rows, 'sourceUrlLeak'), 'red', 'sourceUrlLeak must NOT be detected under isolation');
});

test('detector DOES catch main-world execution in addBinding (control — proves the test is meaningful)', {timeout}, async (t) => {
    const rows = await runDetector('addBinding');
    if (!rows) {
        t.skip('bot-detector.rebrowser.net unreachable');
        return;
    }
    if (statusFor(rows, 'mainWorldExecution') == undefined) {
        t.skip('detector page structure changed (expected rows not found)');
        return;
    }

    assert.equal(
        statusFor(rows, 'mainWorldExecution'),
        'red',
        'addBinding evaluates in the main world, so the detector should flag mainWorldExecution',
    );
});
