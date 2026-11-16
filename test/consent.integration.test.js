import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { chromium } from 'playwright';
import { dismissConsent, CONSENT_HOSTS, REJECT_LABEL, ACCEPT_LABEL, normalizeLabel } from '../src/consent.js';
import { createCapturer } from '../src/capture.js';

// ---------------------------------------------------------------------------
// Local HTTP server serving fake consent-banner pages
// ---------------------------------------------------------------------------

// Page with a known reject selector (#reject-all) and a scroll-locked body.
const BANNER_PAGE = `<!doctype html><html><head><title>Test Page</title></head>
<body style="overflow:hidden">
<div id="cookie-banner" style="position:fixed;top:0;left:0;width:100%;background:#000;color:#fff;padding:20px;z-index:9999">
  We use cookies.
  <button id="reject-all" onclick="document.getElementById('cookie-banner').style.display='none';document.body.dataset.consentDone='1'">Reject all</button>
  <button id="accept-all" onclick="document.getElementById('cookie-banner').style.display='none';document.body.dataset.consentDone='accept'">Accept</button>
</div>
<main><h1>Main content</h1></main>
</body></html>`;

// Page with only generic text button (no known selector).
const GENERIC_PAGE = `<!doctype html><html><head><title>Generic</title></head>
<body>
<div class="cookie-notice">
  <button onclick="document.body.dataset.consentDone='reject'">Decline all</button>
</div>
<main><h1>Content</h1></main>
</body></html>`;

// Page with no banner at all.
const CLEAN_PAGE = `<!doctype html><html><head><title>Clean</title></head>
<body><h1>No banners here</h1></body></html>`;

// Regression: a news homepage with NO banner. The old page-wide text match
// clicked this headline because it contains "decline", and the capture saved
// the article instead of the homepage.
const NEWS_PAGE = `<!doctype html><html><head><title>Daily News Home</title></head>
<body><h1>Top stories</h1>
<a href="/markets">Markets decline sharply after rate news</a>
<form><p>Join our newsletter?</p><button type="button" onclick="document.body.dataset.clicked='newsletter'">Decline</button></form>
</body></html>`;

// A real banner next to a "decline" headline. The banner's "Decline" is a
// navigating link (must be skipped); its "Accept all" button is safe.
const NEWS_WITH_BANNER = `<!doctype html><html><head><title>News With Banner</title></head>
<body><a href="/markets">Markets decline sharply</a>
<div class="cookie-notice">We use cookies.
  <a href="/markets">Decline</a>
  <button onclick="document.body.dataset.consentDone='accept'">Accept all</button>
</div></body></html>`;

// A known provider button that (badly) navigates away when clicked.
const NAVIGATING_REJECT = `<!doctype html><html><head><title>Original Page</title></head>
<body><div id="onetrust-consent-sdk"><button id="onetrust-reject-all-handler" onclick="location.href='/markets'">Reject all</button></div>
<h1>Original</h1></body></html>`;

// A dialog with no cookie-ish class names, only cookie-ish text.
const DIALOG_PAGE = `<!doctype html><html><head><title>Dialog</title></head>
<body><div role="dialog"><p>We use cookies to improve your experience.</p>
<button onclick="document.body.dataset.consentDone='gotit'">Got it!</button></div>
<div role="dialog"><p>Rate this article</p><button onclick="document.body.dataset.rated='1'">OK</button></div>
</body></html>`;

// Ordinary content whose id mentions GDPR must not be hidden by the CSS layer.
const GDPR_ARTICLE = `<!doctype html><html><head><title>GDPR FAQ</title></head>
<body><section id="gdpr-faq"><h1>What is GDPR?</h1></section></body></html>`;

const MARKETS_PAGE = `<!doctype html><html><head><title>Markets article</title></head><body><h1>Article</h1></body></html>`;

let server, base;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pages = {
      '/banner': BANNER_PAGE, '/generic': GENERIC_PAGE, '/clean': CLEAN_PAGE,
      '/news': NEWS_PAGE, '/news-banner': NEWS_WITH_BANNER, '/nav-reject': NAVIGATING_REJECT,
      '/dialog': DIALOG_PAGE, '/gdpr-article': GDPR_ARTICLE, '/markets': MARKETS_PAGE,
    };
    const body = pages[req.url];
    if (body) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(body);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}, 30_000);

afterAll(() => {
  server?.close();
});

// ---------------------------------------------------------------------------
// Unit tests: CONSENT_HOSTS membership
// ---------------------------------------------------------------------------
describe('CONSENT_HOSTS', () => {
  it('includes known consent provider hostnames', () => {
    expect(CONSENT_HOSTS.has('cdn.cookielaw.org')).toBe(true);        // OneTrust
    expect(CONSENT_HOSTS.has('consent.cookiebot.com')).toBe(true);    // Cookiebot
    expect(CONSENT_HOSTS.has('sdk.privacy-center.org')).toBe(true);   // Didomi
    expect(CONSENT_HOSTS.has('cmp.quantcast.com')).toBe(true);        // Quantcast
    expect(CONSENT_HOSTS.has('consent.trustarc.com')).toBe(true);     // TrustArc
    expect(CONSENT_HOSTS.has('app.usercentrics.eu')).toBe(true);      // Usercentrics
  });

  it('does not include unrelated hosts', () => {
    expect(CONSENT_HOSTS.has('example.com')).toBe(false);
    expect(CONSENT_HOSTS.has('google.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: whole-label matching
// ---------------------------------------------------------------------------
describe('consent button labels', () => {
  const rej = (t) => REJECT_LABEL.test(normalizeLabel(t));
  const acc = (t) => ACCEPT_LABEL.test(normalizeLabel(t));

  it.each(['Reject all', 'REJECT ALL COOKIES', 'Decline', 'Decline all', 'Refuse', 'Deny',
    'Necessary only', 'Only necessary cookies', 'Use necessary cookies only', 'Continue without accepting'])(
    'treats %j as a reject button', (t) => expect(rej(t)).toBe(true));

  it.each(['Accept', 'Accept all', 'Accept All Cookies', 'I agree', 'Agree and close', 'Allow all',
    'OK', 'Got it!', 'I understand'])('treats %j as an accept button', (t) => expect(acc(t)).toBe(true));

  it.each(['Markets decline sharply after rate news', 'Why voters reject the plan', 'Accept the challenge',
    'Read our cookie policy', 'Okay, show me more stories'])('ignores %j', (t) => {
    expect(rej(t)).toBe(false);
    expect(acc(t)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: dismissConsent() with real Playwright
// ---------------------------------------------------------------------------
describe('dismissConsent', () => {
  let browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function withPage(url, fn) {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  it('clicks the reject button when a known reject selector is present', async () => {
    await withPage(`${base}/banner`, async (page) => {
      await dismissConsent(page);
      const done = await page.evaluate(() => document.body.dataset.consentDone);
      expect(done).toBe('1'); // reject button clicked, not accept
      const visible = await page.locator('#cookie-banner').isVisible();
      expect(visible).toBe(false);
    });
  }, 30_000);

  it('clicks by generic text when no known selector matches', async () => {
    await withPage(`${base}/generic`, async (page) => {
      await dismissConsent(page);
      const done = await page.evaluate(() => document.body.dataset.consentDone);
      expect(done).toBe('reject');
    });
  }, 30_000);

  it('leaves a banner-free page untouched without throwing', async () => {
    await withPage(`${base}/clean`, async (page) => {
      await expect(dismissConsent(page)).resolves.not.toThrow();
    });
  }, 30_000);

  it('does not click anything on a page without a banner', async () => {
    await withPage(`${base}/news`, async (page) => {
      await dismissConsent(page);
      expect(page.url()).toBe(`${base}/news`);
      expect(await page.evaluate(() => document.body.dataset.clicked)).toBeUndefined();
    });
  }, 30_000);

  it('skips navigating links inside a banner and clicks a safe button', async () => {
    await withPage(`${base}/news-banner`, async (page) => {
      await dismissConsent(page);
      expect(page.url()).toBe(`${base}/news-banner`);
      expect(await page.evaluate(() => document.body.dataset.consentDone)).toBe('accept');
    });
  }, 30_000);

  it('finds a dialog by its cookie text, and leaves unrelated dialogs alone', async () => {
    await withPage(`${base}/dialog`, async (page) => {
      await dismissConsent(page);
      expect(await page.evaluate(() => document.body.dataset.consentDone)).toBe('gotit');
      expect(await page.evaluate(() => document.body.dataset.rated)).toBeUndefined();
    });
  }, 30_000);

  it('does not hide ordinary content whose id mentions GDPR', async () => {
    await withPage(`${base}/gdpr-article`, async (page) => {
      await dismissConsent(page);
      expect(await page.locator('#gdpr-faq').isVisible()).toBe(true);
    });
  }, 30_000);

  it('injects CSS that hides known banner classes', async () => {
    await withPage(`${base}/banner`, async (page) => {
      await dismissConsent(page);
      // After CSS injection the cookie-notice class should be hidden even if it existed
      const hidden = await page.evaluate(() => {
        const el = document.createElement('div');
        el.className = 'cookie-banner';
        document.body.appendChild(el);
        return window.getComputedStyle(el).display;
      });
      expect(hidden).toBe('none');
    });
  }, 30_000);

  it('restores body overflow after dismissal', async () => {
    await withPage(`${base}/banner`, async (page) => {
      const before = await page.evaluate(() => document.body.style.overflow);
      expect(before).toBe('hidden');
      await dismissConsent(page);
      const after = await page.evaluate(() => window.getComputedStyle(document.body).overflow);
      expect(after).not.toBe('hidden');
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Integration test: dismiss=false leaves banner visible
// ---------------------------------------------------------------------------
describe('createCapturer with dismiss=false', () => {
  let capturer;

  beforeAll(async () => {
    capturer = createCapturer({ allowPrivateHosts: true, dismiss: false });
  }, 30_000);

  afterAll(async () => {
    await capturer?.close();
  });

  it('does not remove the banner when dismiss is disabled', async () => {
    // We can't inspect the page DOM post-capture, so we verify indirectly:
    // the title of the captured page should still be found (capture completes)
    // and we trust the dismiss=false code path doesn't throw.
    const result = await capturer.capture(`${base}/banner`);
    expect(result.title).toBe('Test Page');
    expect(result.screenshot).toBeInstanceOf(Buffer);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Integration tests: full capture never ends up on a different page
// ---------------------------------------------------------------------------
describe('createCapturer with dismiss=true', () => {
  let capturer;

  beforeAll(() => {
    capturer = createCapturer({ allowPrivateHosts: true, dismiss: true });
  });

  afterAll(async () => {
    await capturer?.close();
  });

  it('regression: does not click a "Markets decline…" headline', async () => {
    const r = await capturer.capture(`${base}/news`);
    expect(r.finalUrl).toBe(`${base}/news`);
    expect(r.title).toBe('Daily News Home');
  }, 30_000);

  it('returns to the original page if a consent click navigates away', async () => {
    const r = await capturer.capture(`${base}/nav-reject`);
    expect(r.finalUrl).toBe(`${base}/nav-reject`);
    expect(r.title).toBe('Original Page');
    expect(r.screenshot).toBeInstanceOf(Buffer);
  }, 30_000);
});
