'use strict';

const $ = (id) => document.getElementById(id);
const PAGE = 60;
// how often to check for new photos; ?pollMs= overrides (used by tests)
const POLL_MS = Math.max(500, parseInt(new URLSearchParams(location.search).get('pollMs'), 10) || 10000);

let photos = [];                 // newest-first, the source of truth
let shownCount = 0;              // how many from the top are rendered
const cells = new Map();         // key → cell element (so we don't rebuild/flicker)
let lastEtag = null;
let polling = false;
let pendingNew = 0;              // new arrivals while the guest is scrolled down

async function fetchPhotos() {
  const headers = lastEtag ? { 'If-None-Match': lastEtag } : {};
  const res = await fetch('/api/photos', { headers });
  if (res.status === 304) return null;         // nothing changed since last poll
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  lastEtag = res.headers.get('ETag') || lastEtag;
  return res.json();
}

async function load() {
  const data = await fetchPhotos();
  if (!data) return;
  $('couple').textContent = `${data.coupleNames}'s Wedding`;
  document.title = `${data.coupleNames}'s Wedding — Gallery`;
  photos = data.photos;
  shownCount = Math.min(PAGE, photos.length);
  render();
}

// Merge a fresh listing: new photos appear at the top, deletions disappear,
// video posters fill in — all without disturbing what the guest is viewing.
function merge(data) {
  const knownKeys = new Set(photos.map((p) => p.key));
  const incomingKeys = new Set(data.photos.map((p) => p.key));
  const added = data.photos.filter((p) => !knownKeys.has(p.key));

  photos = data.photos;
  // reveal every genuinely new photo on top of whatever was already shown
  shownCount = Math.min(photos.length, Math.max(shownCount + added.length, Math.min(PAGE, photos.length)));
  // drop cells for removed photos so render() doesn't try to reuse them
  for (const key of [...cells.keys()]) if (!incomingKeys.has(key)) { cells.get(key).remove(); cells.delete(key); }

  render();

  if (added.length && window.scrollY > 300) {
    pendingNew += added.length;
    showNewPill();
  }
}

function fillCell(cell, p) {
  const sig = `${p.isVideo ? 'v' : 'p'}:${p.thumb || ''}`;
  if (cell.dataset.sig === sig) return; // unchanged — leave the loaded image alone
  cell.dataset.sig = sig;
  if (p.isVideo && p.thumb) {
    cell.innerHTML = `<img loading="lazy" src="${p.thumb}" alt=""><div class="play-overlay"><div class="play-circle">▶</div></div>`;
  } else if (p.isVideo) {
    cell.innerHTML = `<div class="video-badge"><div class="play-circle">▶</div></div>`;
  } else if (p.thumb) {
    cell.innerHTML = `<img loading="lazy" src="${p.thumb}" alt="">`;
  } else {
    cell.innerHTML = `<div class="file-badge">🖼️</div>`;
  }
  cell.onclick = () => openLightbox(p);
}

// Keyed reconcile: make the grid's children exactly photos[0..shownCount] in order.
function render() {
  const grid = $('grid');
  const desired = photos.slice(0, shownCount);
  $('empty').style.display = photos.length ? 'none' : 'block';

  let prev = null;
  for (const p of desired) {
    let cell = cells.get(p.key);
    if (!cell) {
      cell = document.createElement('button');
      cell.className = 'cell';
      cells.set(p.key, cell);
    }
    fillCell(cell, p);
    const shouldFollow = prev ? prev.nextSibling : grid.firstChild;
    if (shouldFollow !== cell) grid.insertBefore(cell, prev ? prev.nextSibling : grid.firstChild);
    prev = cell;
  }
  // remove any trailing cells beyond shownCount
  const desiredKeys = new Set(desired.map((p) => p.key));
  for (const [key, cell] of cells) if (!desiredKeys.has(key)) { cell.remove(); cells.delete(key); }

  $('moreBtn').style.display = shownCount < photos.length ? 'flex' : 'none';
}

function showMore() {
  shownCount = Math.min(shownCount + PAGE, photos.length);
  render();
}
$('moreBtn').onclick = showMore;

// ---- "new photos" pill (only when scrolled away from the top)
function showNewPill() {
  const pill = $('newPill');
  pill.textContent = `↑ ${pendingNew} new photo${pendingNew > 1 ? 's' : ''}`;
  pill.hidden = false;
}
function hideNewPill() { pendingNew = 0; $('newPill').hidden = true; }
$('newPill').onclick = () => { window.scrollTo({ top: 0, behavior: 'smooth' }); hideNewPill(); };
window.addEventListener('scroll', () => { if (window.scrollY < 200) hideNewPill(); }, { passive: true });

// ---- lightbox
function openLightbox(p) {
  const media = $('lbMedia');
  media.innerHTML = p.isVideo
    ? `<video src="${p.full}" controls autoplay playsinline></video>`
    : `<img src="${p.full}" alt="">`;
  $('lbCaption').textContent = p.name ? `by ${p.name.replace(/-/g, ' ')}` : '';
  document.querySelector('.caption-heart').style.display = p.name ? 'block' : 'none';
  $('lightbox').classList.add('open');
}
$('lbClose').onclick = closeLightbox;
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });
function closeLightbox() {
  $('lightbox').classList.remove('open');
  $('lbMedia').innerHTML = '';
}

// ---- background polling: keep the wall live as guests upload
async function poll() {
  if (polling || document.hidden) return;
  polling = true;
  try {
    const data = await fetchPhotos();
    if (data) merge(data);
  } catch {
    /* transient (venue wifi) — try again next tick */
  } finally {
    polling = false;
  }
}
setInterval(poll, POLL_MS);
// catch up immediately when the guest returns to the tab
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

load();
