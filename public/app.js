// All untrusted site data goes in via textContent / attributes — never innerHTML.
const $ = (sel, root = document) => root.querySelector(sel);
const form = $('#capture-form');
const input = $('#url');
const submit = $('#submit');
const statusEl = $('#status');
const list = $('#sites');
const tpl = $('#card-tpl');
const sizeSelect = $('#size');
const descDefaultSelect = $('#desc-default');
const layoutSelect = $('#layout');

let sites = [];
let sizes = {}; // { small: 320, ... } from the server
const descOverrides = new Map(); // site id -> expanded?, for cards toggled away from the default (masonry)
let poppedCard = null; // grid layout: the card whose description pop-over is open
const isMasonry = () => layoutSelect.value === 'masonry';

// Masonry: the grid has 4px rows and each card spans enough of them to fit its height plus the gap.
const MASONRY_ROW = 4;
const MASONRY_GAP = 16;
const masonryObserver = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const rows = Math.ceil((target.getBoundingClientRect().height + MASONRY_GAP) / MASONRY_ROW);
    target.style.gridRowEnd = `span ${rows}`;
  }
});

const prefs = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
};

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Pick the stored size closest to the chosen one (records may predate a size change). */
function thumbFor(site, wanted) {
  const available = site.thumbnails ? Object.keys(site.thumbnails) : [];
  if (!available.length) return site.thumbnail ?? null; // records saved by v0.1 had one size

  if (site.thumbnails[wanted]) return site.thumbnails[wanted];
  const target = sizes[wanted] ?? 640;
  available.sort((a, b) => Math.abs((sizes[a] ?? 640) - target) - Math.abs((sizes[b] ?? 640) - target));
  return site.thumbnails[available[0]];
}

function renderCard(site) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  const img = $('.thumb', node);
  const src = thumbFor(site, sizeSelect.value);
  if (src) {
    img.src = `${src}?v=${encodeURIComponent(site.capturedAt)}`;
    img.alt = `${site.captureMode === 'fallback' ? 'Preview image' : 'Screenshot'} of ${site.title}`;
  } else {
    img.hidden = true;
    $('.placeholder', node).hidden = false;
    $('.initial', node).textContent = (site.title || '?').trim().charAt(0).toUpperCase();
  }
  $('.thumb-link', node).href = site.url;
  $('.title', node).textContent = site.title;
  if (site.captureMode === 'fallback') {
    const badge = $('.badge', node);
    badge.hidden = false;
    badge.title = `The browser could not render this page, so only basic info was fetched.\n${site.fallbackReason || ''}`;
  }
  $('.site-name', node).textContent = site.siteName || '';
  const desc = $('.desc', node);
  desc.textContent = site.description || 'No description provided.';
  desc.classList.toggle('muted', !site.description);
  desc.id = `desc-${site.id}`;
  const toggle = $('.desc-toggle', node);
  const pop = $('.desc-pop', node);
  pop.id = `desc-pop-${site.id}`;
  $('.desc-full', pop).textContent = desc.textContent;
  $('.pop-close', pop).addEventListener('click', closePopover);
  if (isMasonry()) {
    toggle.setAttribute('aria-controls', desc.id);
    setExpanded(node, descOverrides.get(site.id) ?? descDefaultSelect.value === 'expanded');
  } else {
    toggle.setAttribute('aria-controls', pop.id);
    setExpanded(node, false);
  }
  toggle.addEventListener('click', () => {
    if (!isMasonry()) return openPopover(node);
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    descOverrides.set(site.id, expanded);
    setExpanded(node, expanded);
  });
  const link = $('.url', node);
  link.href = site.url;
  link.textContent = site.url;
  const when = $('.when', node);
  when.dateTime = site.capturedAt;
  when.textContent = `Captured ${new Date(site.capturedAt).toLocaleString()}`;
  $('.refresh', node).addEventListener('click', () => capture(site.inputUrl));
  $('.delete', node).addEventListener('click', async () => {
    try {
      await api('DELETE', `/api/sites/${site.id}`);
      await refresh();
    } catch (err) {
      setStatus(err.message, 'error');
    }
  });
  return node;
}

function setExpanded(card, expanded) {
  $('.desc', card).classList.toggle('collapsed', !expanded);
  const toggle = $('.desc-toggle', card);
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.textContent = expanded ? 'Show less' : 'Show more';
}

/** Only offer the toggle where the collapsed description would actually be cut off. */
function updateToggles() {
  for (const card of list.children) {
    const desc = $('.desc', card);
    const wasCollapsed = desc.classList.contains('collapsed');
    desc.classList.add('collapsed');
    const clipped = desc.scrollHeight > desc.clientHeight + 1;
    desc.classList.toggle('collapsed', wasCollapsed);
    $('.desc-toggle', card).hidden = !clipped;
  }
}

function openPopover(card) {
  closePopover();
  const desc = $('.desc', card);
  const pop = $('.desc-pop', card);
  pop.style.top = `${desc.offsetTop - 9}px`; // 8px padding + 1px border: text lands on top of the clamped text
  pop.hidden = false;
  card.classList.add('popped');
  $('.desc-toggle', card).setAttribute('aria-expanded', 'true');
  $('.pop-close', pop).focus({ preventScroll: true });
  poppedCard = card;
}

function closePopover() {
  if (!poppedCard) return;
  const card = poppedCard;
  poppedCard = null;
  $('.desc-pop', card).hidden = true;
  card.classList.remove('popped');
  const toggle = $('.desc-toggle', card);
  toggle.setAttribute('aria-expanded', 'false');
  if (card.contains(document.activeElement)) toggle.focus({ preventScroll: true });
}

document.addEventListener('click', (e) => {
  if (poppedCard && !poppedCard.contains(e.target)) closePopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePopover();
});

function render() {
  poppedCard = null;
  masonryObserver.disconnect();
  list.dataset.size = sizeSelect.value;
  list.dataset.layout = layoutSelect.value;
  $('#desc-default-picker').hidden = !isMasonry();
  list.replaceChildren(...sites.map(renderCard));
  $('#empty').hidden = sites.length > 0;
  updateToggles();
  if (isMasonry()) for (const card of list.children) masonryObserver.observe(card);
}

let resizeFrame = 0;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  // Height-only resizes happen when a phone's address bar slides away mid-scroll; ignore them.
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  closePopover(); // its position was measured for the old width
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(updateToggles);
});

async function refresh() {
  sites = await api('GET', '/api/sites');
  render();
}

async function capture(url) {
  submit.disabled = true;
  setStatus(`Capturing ${url}… (this can take a few seconds)`, 'busy');
  try {
    const site = await api('POST', '/api/sites', { url });
    const how = site.captureMode === 'fallback' ? ' (basic capture — browser render failed)' : '';
    setStatus(`Captured “${site.title}”${how}.`, site.captureMode === 'fallback' ? 'warn' : 'ok');
    await refresh();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    submit.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (url) capture(url).then(() => form.reset());
});

sizeSelect.addEventListener('change', () => {
  prefs.set('thumbSize', sizeSelect.value);
  render();
});

descDefaultSelect.addEventListener('change', () => {
  prefs.set('descDefault', descDefaultSelect.value);
  descOverrides.clear(); // a new default applies to every card
  render();
});

layoutSelect.addEventListener('change', () => {
  prefs.set('layout', layoutSelect.value);
  render();
});

async function init() {
  if (prefs.get('descDefault') === 'expanded') descDefaultSelect.value = 'expanded';
  if (prefs.get('layout') === 'masonry') layoutSelect.value = 'masonry';
  ({ thumbnailSizes: sizes } = await api('GET', '/api/config'));
  const names = Object.keys(sizes).sort((a, b) => sizes[a] - sizes[b]);
  sizeSelect.replaceChildren(
    ...names.map((n) => new Option(`${n[0].toUpperCase()}${n.slice(1)} (${sizes[n]}px)`, n)),
  );
  const saved = prefs.get('thumbSize');
  sizeSelect.value = saved && sizes[saved] ? saved : (names.includes('medium') ? 'medium' : names[0]);
  await refresh();
}

init().catch((err) => setStatus(err.message, 'error'));
