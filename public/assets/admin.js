'use strict';

const $ = (id) => document.getElementById(id);

async function checkSession() {
  const { admin } = await (await fetch('/api/admin/me')).json();
  if (admin) enterAdmin();
}

$('loginBtn').onclick = async () => {
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('password').value }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    $('loginError').textContent = data.error || 'Login failed';
    $('loginError').style.display = 'block';
    return;
  }
  enterAdmin();
};
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });
$('toggleEye').addEventListener('click', () => {
  const pw = $('password');
  pw.type = pw.type === 'password' ? 'text' : 'password';
});

async function enterAdmin() {
  $('loginCard').style.display = 'none';
  $('loginHero').style.display = 'none';
  $('adminArea').style.display = 'block';
  fetch('/api/config').then((r) => r.json()).then((cfg) => {
    $('adminCouple').textContent = `${cfg.coupleNames}'s Wedding`;
  });
  await renderGrid();
}

async function renderGrid() {
  const { photos } = await (await fetch('/api/photos')).json();
  const grid = $('grid');
  grid.innerHTML = '';
  $('empty').style.display = photos.length ? 'none' : 'block';
  for (const p of photos) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.innerHTML = p.isVideo && p.thumb
      ? `<img loading="lazy" src="${p.thumb}" alt=""><div class="play-overlay"><div class="play-circle">▶</div></div>`
      : p.isVideo
        ? `<div class="video-badge"><div class="play-circle">▶</div></div>`
        : p.thumb
          ? `<img loading="lazy" src="${p.thumb}" alt="">`
          : `<div class="file-badge">🖼️</div>`;
    if (p.name) cell.insertAdjacentHTML('beforeend', `<div class="tag">${p.name.replace(/-/g, ' ')}</div>`);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.onclick = async () => {
      if (!confirm('Delete this photo permanently?')) return;
      await fetch('/api/admin/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: p.key }),
      });
      renderGrid();
    };
    cell.appendChild(del);
    grid.appendChild(cell);
  }
}

checkSession();
