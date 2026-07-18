'use strict';

const $ = (id) => document.getElementById(id);
const PAGE = 60;

let allPhotos = [];
let shown = 0;

async function load() {
  const res = await fetch('/api/photos');
  const data = await res.json();
  $('couple').textContent = `${data.coupleNames}'s Wedding`;
  document.title = `${data.coupleNames}'s Wedding — Gallery`;
  allPhotos = data.photos;
  $('grid').innerHTML = '';
  $('empty').style.display = allPhotos.length ? 'none' : 'block';
  shown = 0;
  showMore();
}

function showMore() {
  const batch = allPhotos.slice(shown, shown + PAGE);
  shown += batch.length;
  const grid = $('grid');
  for (const p of batch) grid.appendChild(cellFor(p));
  $('moreBtn').style.display = shown < allPhotos.length ? 'block' : 'none';
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
  cell.onclick = () => openLightbox(p);
  return cell;
}

function openLightbox(p) {
  const media = $('lbMedia');
  media.innerHTML = p.isVideo
    ? `<video src="${p.full}" controls autoplay playsinline></video>`
    : `<img src="${p.full}" alt="">`;
  $('lbCaption').textContent = p.name ? `by ${p.name.replace(/-/g, ' ')}` : '';
  $('lightbox').classList.add('open');
}

$('lbClose').onclick = closeLightbox;
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });
function closeLightbox() {
  $('lightbox').classList.remove('open');
  $('lbMedia').innerHTML = '';
}

load();
