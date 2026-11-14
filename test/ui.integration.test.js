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
const SHORT = 'Short.';

let dir, server, base, browser;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-ui-'));
  const png = await pngImage(640, 400);
  const descriptions = { 'https://long.test/': LONG, 'https://short.test/': SHORT };
  const capturer = {
    capture: async (url) => ({
      title: new URL(url).hostname, description: descriptions[url], url, finalUrl: url, siteName: null,
      httpStatus: 200, image: png, captureMode: 'browser', fallbackReason: null,
    }),
  };
  const app = createApp({ store: createStore(dir), capturer, sizes: { medium: 320 }, logger: { warn() {}, error() {} } });
  await request(app).post('/api/sites').send({ url: 'long.test' }).expect(201);
  await request(app).post('/api/sites').send({ url: 'short.test' }).expect(201);
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const card = (page, host) => page.locator('.card', { has: page.locator('.title', { hasText: host }) });
const height = async (loc) => (await loc.boundingBox()).height;

describe('collapsible descriptions', () => {
  it('collapses by default, expands one card on click, and leaves its neighbour alone', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base);
    const long = card(page, 'long.test');
    const short = card(page, 'short.test');
    await long.waitFor();

    await expect(short.locator('.desc-toggle').isVisible()).resolves.toBe(false); // nothing to expand
    const toggle = long.locator('.desc-toggle');
    expect(await toggle.textContent()).toBe('Show more');
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');

    const [longBefore, shortBefore] = [await height(long), await height(short)];
    await toggle.click();
    expect(await toggle.textContent()).toBe('Show less');
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await height(long)).toBeGreaterThan(longBefore + 50);
    expect(await height(short)).toBe(shortBefore);

    await toggle.click();
    expect(await height(long)).toBe(longBefore);
    await page.close();
  }, 30_000);

  it('applies and remembers the default setting', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base);
    await card(page, 'long.test').waitFor();
    await page.selectOption('#desc-default', 'expanded');
    expect(await card(page, 'long.test').locator('.desc-toggle').textContent()).toBe('Show less');

    await page.reload();
    await card(page, 'long.test').waitFor();
    expect(await page.inputValue('#desc-default')).toBe('expanded');
    expect(await card(page, 'long.test').locator('.desc').getAttribute('class')).not.toMatch(/collapsed/);
    await page.close();
  }, 30_000);
});
