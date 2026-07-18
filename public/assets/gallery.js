'use strict';

const $ = (id) => document.getElementById(id);
const PAGE = 60;

let allPhotos = [];
let filtered = [];
let shown = 0;
let activeTable = null;

async function load() {
  const res = await fetch('/api/photos');
  const data = await res.json();
  $('couple').textContent = `${data.coupleNames}'s Wedding`;
  document.title = `${data.coupleNames}'s Wedding — Gallery`;
  allPhotos = data.photos;
  renderChips(data.counts);
  renderLeader(data.counts);
  applyFilter(activeTable);
}

function renderChips(counts) {
  const chips = $('chips');
  chips.innerHTML = '';
  const mk = (label, table, count) => {
    const b = document.createElement('button');
    b.className = 'chip' + (table === activeTable ? ' active' : '');
    b.innerHTML = `${label} <span class="count">${count}</span>`;
    b.onclick = () => { activeTable = table; renderChips(counts); applyFilter(table); };
    chips.appendChild(b);
  };
  mk('All', null, allPhotos.length);
  Object.entries(counts)
    .filter(([, c]) => c > 0)
    .forEach(([t, c]) => mk(`Table ${t}`, parseInt(t, 10), c));
}

function renderLeader(counts) {
  const entries = Object.entries(counts).filter(([, c]) => c > 0);
  if (entries.length < 2) return ($('leader').textContent = '');
  const [topTable, topCount] = entries.sort((a, b) => b[1] - a[1])[0];
  $('leader').textContent = `📸 Table ${topTable} is in the lead with ${topCount} photos!`;
}

function applyFilter(table) {
  filtered = table ? allPhotos.filter((p) => p.table === table) : allPhotos;
  shown = 0;
  $('grid').innerHTML = '';
  $('empty').style.display = filtered.length ? 'none' : 'block';
  showMore();
}

function showMore() {
  const batch = filtered.slice(shown, shown + PAGE);
  shown += batch.length;
  const grid = $('grid');
  for (const p of batch) grid.appendChild(cellFor(p));
  $('moreBtn').style.display = shown < filtered.length ? 'block' : 'none';
}
$('moreBtn').onclick = showMore;

function cellFor(p) {
  const cell = document.createElement('button');
  cell.className = 'cell';
  if (p.isVideo) {
    cell.innerHTML = `<div class="video-badge">🎬<span>video</span></div>`;
  } else if (p.thumb) {
    cell.innerHTML = `<img loading="lazy" src="${p.thumb}" alt="">`;
  } else {
    cell.innerHTML = `<div class="file-badge">🖼️<span>photo</span></div>`;
  }
  cell.insertAdjacentHTML('beforeend', `<div class="tag">T${p.table}</div>`);
  cell.onclick = () => openLightbox(p);
  return cell;
}

function openLightbox(p) {
  const media = $('lbMedia');
  media.innerHTML = p.isVideo
    ? `<video src="${p.full}" controls autoplay playsinline></video>`
    : `<img src="${p.full}" alt="">`;
  const who = p.name ? `by ${p.name.replace(/-/g, ' ')} · ` : '';
  $('lbCaption').textContent = `${who}Table ${p.table}`;
  $('lightbox').classList.add('open');
}

$('lbClose').onclick = closeLightbox;
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });
function closeLightbox() {
  $('lightbox').classList.remove('open');
  $('lbMedia').innerHTML = '';
}

load();
