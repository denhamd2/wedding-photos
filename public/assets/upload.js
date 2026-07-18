'use strict';

const $ = (id) => document.getElementById(id);

$('uploaderName').value = localStorage.getItem('uploaderName') || '';

fetch('/api/config').then((r) => r.json()).then((cfg) => {
  $('couple').textContent = `${cfg.coupleNames}'s Wedding`;
  document.title = `${cfg.coupleNames}'s Wedding`;
});

$('pickBtn').addEventListener('click', () => $('fileInput').click());
$('cameraBtn').addEventListener('click', () => $('cameraInput').click());
$('moreBtn').addEventListener('click', () => {
  $('thanks').style.display = 'none';
  $('uploadCard').style.display = 'block';
  document.body.classList.remove('thanked');
  window.scrollTo({ top: 0 });
});

for (const inputId of ['fileInput', 'cameraInput']) {
  $(inputId).addEventListener('change', () => {
    const files = Array.from($(inputId).files);
    if (files.length) uploadFiles(files);
    $(inputId).value = '';
  });
}

function showError(msg) {
  $('errorNote').textContent = msg;
  $('errorNote').style.display = 'block';
}

async function uploadFiles(files) {
  $('errorNote').style.display = 'none';
  const uploaderName = $('uploaderName').value.trim();
  if (uploaderName) localStorage.setItem('uploaderName', uploaderName);

  let plan;
  try {
    const res = await fetch('/api/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploaderName,
        files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      }),
    });
    plan = await res.json();
    if (!res.ok) return showError(plan.error || 'Something went wrong — please try again.');
  } catch {
    return showError('No connection — please check your signal and try again.');
  }

  $('uploadCard').style.display = 'none';
  $('progressCard').style.display = 'block';
  const rows = files.map((file, i) => makeRow(file, plan.uploads[i]));
  updateCount(rows);

  // Upload 3 at a time — phones on venue wifi don't love 30 parallel PUTs.
  const queue = rows.slice();
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) await uploadOne(queue.shift(), 2, rows);
  }));
  checkAllDone(rows);
}

function updateCount(rows) {
  const done = rows.filter((r) => r.done).length;
  $('progressCount').textContent = `${Math.min(done + 1, rows.length)} of ${rows.length}`;
  if (done === rows.length) $('progressCount').textContent = `${done} of ${rows.length}`;
}

function checkAllDone(rows) {
  updateCount(rows);
  if (!rows.every((r) => r.done)) return;
  $('progressCard').style.display = 'none';
  $('fileList').innerHTML = '';
  $('thanks').style.display = 'block';
  document.body.classList.add('thanked');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function makeRow(file, upload) {
  const el = document.createElement('div');
  el.className = 'file-row';
  const isImage = (file.type || '').startsWith('image/');
  el.innerHTML = `
    ${isImage ? '<img class="fthumb" alt="">' : '<div class="fthumb generic">🎬</div>'}
    <div class="fmain">
      <div class="fname"></div>
      <div class="fsize"></div>
      <div class="bar"><div></div></div>
    </div>
    <div class="fstate">waiting…</div>`;
  el.querySelector('.fname').textContent = file.name;
  el.querySelector('.fsize').textContent = fmtSize(file.size);
  if (isImage) {
    const img = el.querySelector('.fthumb');
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
  }
  document.getElementById('fileList').appendChild(el);
  return { file, upload, el, bar: el.querySelector('.bar > div'), state: el.querySelector('.fstate') };
}

function putWithProgress(row) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', row.upload.url);
    for (const [k, v] of Object.entries(row.upload.headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      row.bar.style.width = `${pct}%`;
      row.state.textContent = `${pct}%`;
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(row.file);
  });
}

async function uploadOne(row, attemptsLeft, rows) {
  row.state.className = 'fstate';
  row.state.textContent = 'uploading…';
  try {
    await putWithProgress(row);
    await fetch('/api/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: row.upload.key }),
    });
    row.bar.style.width = '100%';
    row.state.className = 'fstate ok';
    row.state.textContent = '✓';
    row.done = true;
    updateCount(rows);
  } catch {
    if (attemptsLeft > 1) return uploadOne(row, attemptsLeft - 1, rows);
    row.state.className = 'fstate err';
    row.state.textContent = 'failed — tap to retry';
    row.state.onclick = async () => {
      row.state.onclick = null;
      await uploadOne(row, 2, rows);
      checkAllDone(rows);
    };
  }
}
