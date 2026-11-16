// Cookie/consent banner dismissal for headless captures.
// Layer 1 (request blocking) is handled in capture.js via CONSENT_HOSTS.
// Layer 2 (button clicks) and Layer 3 (CSS hiding) are handled by dismissConsent().
//
// Safety rule: we only ever click things that are (a) a known consent-provider
// button id, or (b) a button whose WHOLE label is a consent answer and that
// sits INSIDE something that looks like a consent banner. We never click a
// link that would navigate. Page-wide "text contains 'decline'" matching once
// clicked news headlines ("Markets decline…") and captured the wrong page.

export const CONSENT_HOSTS = new Set([
  'cdn.cookielaw.org',            // OneTrust
  'optanon.blob.core.windows.net',
  'consent.cookiebot.com',        // Cookiebot
  'consentcdn.cookiebot.com',
  'sdk.privacy-center.org',       // Didomi
  'api.privacy-center.org',
  'cmp.quantcast.com',            // Quantcast
  'secure.quantcast.com',
  'consent.trustarc.com',         // TrustArc
  'app.usercentrics.eu',          // Usercentrics
]);

// Known provider buttons, tried in order: reject, necessary-only, accept.
const REJECT_SELECTORS = [
  '#onetrust-reject-all-handler',
  '#CybotCookiebotDialogBodyButtonDecline',
  '#didomi-notice-disagree-button',
];

const NECESSARY_SELECTORS = [
  '#onetrust-pc-btn-handler',
  '.didomi-components-button--tertiary',
];

const ACCEPT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonAcceptSelected',
  '#didomi-notice-agree-button',
];

// Whole-label matches (after lower-casing, stripping punctuation and collapsing spaces).
export const REJECT_LABEL =
  /^(?:(?:reject|decline|refuse|deny)(?: all)?(?: cookies)?|(?:use |accept )?(?:only )?(?:strictly )?necessary(?: cookies)?(?: only)?|continue without accepting)$/;
export const ACCEPT_LABEL =
  /^(?:(?:i )?(?:accept|agree)(?: all)?(?: cookies)?(?: and close| and continue)?|allow(?: all)?(?: cookies)?|ok|okay|got it|i understand|understood|consent)$/;

export function normalizeLabel(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HIDE_CSS = `
#onetrust-consent-sdk,.onetrust-pc-dark-filter,
#CybotCookiebotDialog,#CybotCookiebotDialogBodyUnderlay,
.didomi-popup-container,.didomi-popup-backdrop,
.qc-cmp2-container,#qc-cmp2-ui,
.truste_overlay,.truste_box_overlay,
#usercentrics-root,
[class*="cookie-banner"],[class*="cookie-consent"],[class*="cookie-notice"],
[id*="cookie-banner"],[id*="cookie-consent"],[id*="cookie-notice"],
[class*="gdpr-banner"],[id*="gdpr-banner"],[id*="gdpr-consent"],
[class*="consent-banner"],[id*="consent-banner"]{
  display:none!important;visibility:hidden!important;
}
html,body{overflow:auto!important;}
`;

const MARK = 'data-thumbnailer-consent-target';

async function tryClick(frame, selectors) {
  for (const sel of selectors) {
    try {
      const loc = frame.locator(sel).first();
      if (await loc.isVisible()) {
        await loc.click({ timeout: 1000 });
        return true;
      }
    } catch {
      // not found or not clickable — try next
    }
  }
  return false;
}

/**
 * Runs inside the page (one round trip per frame). Finds consent-banner
 * containers, then the first visible, non-navigating control whose whole
 * label matches, and tags it with MARK so Playwright can click it for real.
 * Returns 'reject' | 'accept' | null.
 */
function markConsentButton({ reject, accept, mark, isMainFrame }) {
  const rejectRe = new RegExp(reject);
  const acceptRe = new RegExp(accept);
  const KEYWORDS = /cookie|consent|gdpr|privacy|tracking|personal data/i;
  const norm = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  // Containers: named like a consent banner, or a dialog that talks about cookies.
  const named = document.querySelectorAll(
    '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="gdpr" i],[class*="gdpr" i],[id*="cmp" i],[class*="cmp-" i]',
  );
  const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog')]
    .filter((el) => KEYWORDS.test(el.textContent || ''));
  const containers = [...named, ...dialogs];
  // A consent provider's own iframe IS the banner: its whole body counts.
  if (!isMainFrame && document.body && KEYWORDS.test(document.body.textContent || '')) containers.push(document.body);
  if (!containers.length) return null;

  const controls = new Set();
  for (const c of containers) {
    for (const el of c.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],a')) {
      if (el.tagName === 'A') {
        // Only links that act like buttons. Anything with a real href could navigate away.
        const href = (el.getAttribute('href') || '').trim();
        if (href && href !== '#' && !/^javascript:/i.test(href)) continue;
      }
      if (visible(el)) controls.add(el);
    }
  }
  const label = (el) => norm(el.value || el.getAttribute('aria-label') || el.textContent);
  for (const [kind, re] of [['reject', rejectRe], ['accept', acceptRe]]) {
    const hit = [...controls].find((el) => re.test(label(el)));
    if (hit) {
      hit.setAttribute(mark, kind);
      return kind;
    }
  }
  return null;
}

async function tryLabelClick(frame) {
  try {
    const kind = await frame.evaluate(markConsentButton, {
      reject: REJECT_LABEL.source,
      accept: ACCEPT_LABEL.source,
      mark: MARK,
      isMainFrame: frame === frame.page().mainFrame(),
    });
    if (!kind) return false;
    await frame.locator(`[${MARK}]`).first().click({ timeout: 1000 });
    return true;
  } catch {
    return false; // frame detached, element vanished, etc.
  }
}

async function dismissFrame(frame) {
  if (await tryClick(frame, REJECT_SELECTORS)) return;
  if (await tryClick(frame, NECESSARY_SELECTORS)) return;
  if (await tryLabelClick(frame)) return;
  await tryClick(frame, ACCEPT_SELECTORS);
}

/**
 * @param {import('playwright').Page} page
 * @param {{ click?: boolean }} [opts]  click: false = only inject the hide-CSS
 */
export async function dismissConsent(page, { click = true } = {}) {
  if (click) {
    // Layer 2: click buttons in main frame and all iframes
    await Promise.all(page.frames().map((f) => dismissFrame(f).catch(() => {})));
  }
  // Layer 3: inject CSS to hide remaining overlays and undo scroll-lock
  await page.addStyleTag({ content: HIDE_CSS }).catch(() => {});
}
