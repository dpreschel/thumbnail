import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { chromium } from 'playwright';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { pngImage } from './helpers.js';

const LONG = 'A long description that goes on and on. '.repeat(20).trim();
const DESCRIPTIONS = {
  'https://short3.test/': 'Short three.',
  'https://short2.test/': 'Short two.',
  'https://short.test/': 'Short.',
  'https://long.test/': LONG,
};

let dir, server, base, browser;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-ui-'));
  const png = await pngImage(640, 400);
  const capturer = {
    capture: async (url) => ({
      title: new URL(url).hostname, description: DESCRIPTIONS[url], url, finalUrl: url, siteName: null,
      httpStatus: 200, image: png, captureMode: 'browser', fallbackReason: null,
    }),
  };
  const app = createApp({ store: createStore(dir), capturer, sizes: { medium: 320 }, logger: { warn() {}, error() {} } });
  // Newest first on screen, so this shows: long, short, short2 | short3
  for (const url of Object.keys(DESCRIPTIONS)) {
    await request(app).post('/api/sites').send({ url }).expect(201);
    await new Promise((r) => setTimeout(r, 5)); // distinct capturedAt so the order is stable
  }
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const card = (page, host) => page.locator('.card', { has: page.locator('.title', { hasText: new RegExp(`^${host}$`) }) });
const box = (loc) => loc.boundingBox();

async function openApp(layout) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(base);
  await card(page, 'long.test').waitFor();
  if (layout) await page.selectOption('#layout', layout);
  return page;
}

describe('grid layout', () => {
  it('matches card heights within each row and shows the full description in a pop-over', async () => {
    const page = await openApp();
    expect(await page.inputValue('#layout')).toBe('grid');
    expect(await page.locator('#desc-default-picker').isVisible()).toBe(false);

    // Row 1 (long, short, short2) shares one height; row 2 (short3) is only as tall as itself.
    const cards = await page.locator('.card').evaluateAll((cs) => cs.map((c) => ({ top: c.offsetTop, h: c.offsetHeight })));
    const row1 = cards.filter((c) => c.top === cards[0].top);
    expect(row1).toHaveLength(3);
    expect(new Set(row1.map((c) => c.h)).size).toBe(1);
    expect(cards[3].h).toBeLessThan(row1[0].h);

    const long = card(page, 'long.test');
    const short = card(page, 'short.test');
    expect(await short.locator('.desc-toggle').isVisible()).toBe(false);
    const lines = await long.locator('.desc').evaluate((d) => Math.round(d.clientHeight / parseFloat(getComputedStyle(d).lineHeight)));
    expect(lines).toBe(4);
    const toggle = long.locator('.desc-toggle');
    const pop = long.locator('.desc-pop');
    const before = await box(long);

    await toggle.click();
    expect(await pop.isVisible()).toBe(true);
    expect(await pop.locator('.desc-full').textContent()).toBe(LONG);
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await box(long)).toEqual(before); // the grid doesn't move
    const popBox = await box(pop);
    expect(popBox.y + popBox.height).toBeGreaterThan(before.y + before.height); // floats past the card

    await pop.locator('.pop-close').click();
    expect(await pop.isVisible()).toBe(false);
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');

    await toggle.click();
    await page.keyboard.press('Escape');
    expect(await pop.isVisible()).toBe(false);

    await toggle.click();
    await page.locator('h1').click();
    expect(await pop.isVisible()).toBe(false);

    // A phone's address bar hiding only changes the height; that must not close it.
    await toggle.click();
    await page.setViewportSize({ width: 1280, height: 700 });
    expect(await pop.isVisible()).toBe(true);
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect.poll(() => pop.isVisible()).toBe(false);
    await page.close();
  }, 30_000);
});

describe('masonry layout', () => {
  it('sizes cards to their content, packs them, and expands in place', async () => {
    const page = await openApp('masonry');
    expect(await page.locator('#desc-default-picker').isVisible()).toBe(true);

    const long = card(page, 'long.test');
    const short = card(page, 'short.test');
    const short3 = card(page, 'short3.test');
    expect((await box(long)).height).toBeGreaterThan((await box(short)).height);

    // The fourth card drops into the shortest column, right under its card.
    const [s, s3] = [await box(short), await box(short3)];
    expect(s3.x).toBe(s.x);
    expect(Math.abs(s3.y - (s.y + s.height + 16))).toBeLessThan(5);

    const shortBefore = await box(short);
    const longBefore = await box(long);
    await long.locator('.desc-toggle').click();
    expect(await long.locator('.desc-toggle').textContent()).toBe('Show less');
    expect(await long.locator('.desc-pop').isVisible()).toBe(false);
    expect((await box(long)).height).toBeGreaterThan(longBefore.height + 50);
    expect(await box(short)).toEqual(shortBefore);

    const boxes = await page.locator('.card').evaluateAll((cs) => cs.map((c) => c.getBoundingClientRect().toJSON()));
    for (const a of boxes) for (const b of boxes) {
      if (a === b) continue;
      const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      expect(overlap).toBe(false);
    }
    await page.close();
  }, 30_000);

  it('remembers the layout and the description default across reloads', async () => {
    const page = await openApp('masonry');
    await page.selectOption('#desc-default', 'expanded');
    expect(await card(page, 'long.test').locator('.desc-toggle').textContent()).toBe('Show less');

    await page.reload();
    await card(page, 'long.test').waitFor();
    expect(await page.inputValue('#layout')).toBe('masonry');
    expect(await page.inputValue('#desc-default')).toBe('expanded');
    expect(await card(page, 'long.test').locator('.desc').getAttribute('class')).not.toMatch(/collapsed/);
    await page.close();
  }, 30_000);
});
