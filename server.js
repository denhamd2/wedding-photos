'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const storageMod = require('./lib/storage');
const { makeKey, parseKey, thumbKeyFor, extFor, sanitizeName, VIDEO_EXTS } = require('./lib/keys');
const { generateThumb } = require('./lib/thumbs');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  coupleNames: process.env.COUPLE_NAMES || 'John & Katie',
  tableCount: parseInt(process.env.TABLE_COUNT || '20', 10),
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '500', 10),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  listCacheMs: parseInt(process.env.LIST_CACHE_MS || '20000', 10),
};

function createApp(storage, cfg = config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const adminSecret = crypto.createHmac('sha256', cfg.adminPassword || crypto.randomBytes(16).toString('hex'))
    .update('wedding-admin-session').digest('hex');

  // ---- listing cache (the bucket is the database; avoid re-listing on every request)
  let listCache = { at: 0, photos: null };
  function invalidateListing() { listCache = { at: 0, photos: null }; }

  async function listPhotos() {
    if (listCache.photos && Date.now() - listCache.at < cfg.listCacheMs) return listCache.photos;
    const [originals, thumbs] = await Promise.all([storage.listAll('photos/'), storage.listAll('thumbs/')]);
    const thumbKeys = new Set(thumbs.map((t) => t.key));
    const photos = originals
      .map((o) => ({ ...parseKey(o.key), size: o.size }))
      .filter((p) => p.key)
      .map((p) => ({
        key: p.key,
        table: p.table,
        ts: p.ts,
        name: p.name,
        isVideo: p.isVideo,
        size: p.size,
        thumb: thumbKeys.has(thumbKeyFor(p.key)) ? `/img/${thumbKeyFor(p.key)}` : null,
        full: `/img/${p.key}`,
      }))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1));
    listCache = { at: Date.now(), photos };
    return photos;
  }

  // ---- health & pages
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/', (req, res) => res.redirect('/gallery'));

  app.get('/t/:table', (req, res) => {
    const table = parseInt(req.params.table, 10);
    if (!Number.isInteger(table) || table < 1 || table > cfg.tableCount) {
      return res.status(404).sendFile(path.join(__dirname, 'public', 'not-found.html'));
    }
    res.sendFile(path.join(__dirname, 'public', 'upload.html'));
  });

  app.get('/gallery', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gallery.html')));
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
  app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1h' }));

  app.get('/api/config', (req, res) => {
    res.json({ coupleNames: cfg.coupleNames, tableCount: cfg.tableCount, maxUploadMb: cfg.maxUploadMb });
  });

  // ---- upload flow: presign → client PUTs to storage → confirm (thumbnails)
  app.post('/api/presign', async (req, res) => {
    try {
      const { table, files, uploaderName } = req.body || {};
      const t = parseInt(table, 10);
      if (!Number.isInteger(t) || t < 1 || t > cfg.tableCount) {
        return res.status(400).json({ error: 'Unknown table' });
      }
      if (!Array.isArray(files) || files.length < 1 || files.length > 50) {
        return res.status(400).json({ error: 'Select between 1 and 50 files' });
      }
      const uploads = [];
      for (const f of files) {
        const ext = extFor(f.type, f.name);
        if (!ext) return res.status(400).json({ error: `"${f.name}" is not a photo or video we can accept` });
        if (!Number.isFinite(f.size) || f.size <= 0 || f.size > cfg.maxUploadMb * 1024 * 1024) {
          return res.status(400).json({ error: `"${f.name}" is too large (max ${cfg.maxUploadMb}MB)` });
        }
        const contentType = f.type || 'application/octet-stream';
        const key = makeKey(t, ext, sanitizeName(uploaderName));
        const { url, headers } = await storage.presignPut(key, contentType);
        uploads.push({ key, url, headers, clientName: f.name });
      }
      res.json({ uploads });
    } catch (err) {
      console.error('presign failed:', err);
      res.status(500).json({ error: 'Could not prepare the upload. Please try again.' });
    }
  });

  // Dev-only stand-in for a presigned bucket PUT (local storage driver).
  app.put('/api/dev-upload', express.raw({ type: () => true, limit: `${cfg.maxUploadMb}mb` }), async (req, res) => {
    const key = String(req.query.key || '');
    if (!parseKey(key)) return res.status(400).json({ error: 'bad key' });
    await storage.putObject(key, req.body, req.headers['content-type']);
    res.json({ ok: true });
  });

  app.post('/api/confirm', async (req, res) => {
    const { key } = req.body || {};
    const parsed = parseKey(String(key || ''));
    if (!parsed) return res.status(400).json({ error: 'bad key' });
    try {
      await storage.headObject(parsed.key);
    } catch {
      return res.status(404).json({ error: 'upload not found' });
    }
    const result = await generateThumb(storage, parsed.key);
    invalidateListing();
    res.json({ ok: true, thumbed: result.thumbed });
  });

  // ---- gallery
  app.get('/api/photos', async (req, res) => {
    try {
      const all = await listPhotos();
      const table = req.query.table ? parseInt(req.query.table, 10) : null;
      const photos = table ? all.filter((p) => p.table === table) : all;
      const counts = {};
      for (let i = 1; i <= cfg.tableCount; i++) counts[i] = 0;
      for (const p of all) counts[p.table] = (counts[p.table] || 0) + 1;
      res.json({ coupleNames: cfg.coupleNames, tableCount: cfg.tableCount, total: all.length, counts, photos });
    } catch (err) {
      console.error('listing failed:', err);
      res.status(500).json({ error: 'Could not load photos' });
    }
  });

  app.get(/^\/img\/(photos|thumbs)\/(.+)$/, async (req, res) => {
    const key = `${req.params[0]}/${req.params[1]}`;
    if (key.includes('..')) return res.status(400).end();
    try {
      const { body, contentType, contentLength } = await storage.getObject(key);
      res.set('Content-Type', contentType || 'application/octet-stream');
      if (contentLength) res.set('Content-Length', String(contentLength));
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      body.pipe(res);
    } catch {
      res.status(404).end();
    }
  });

  // ---- admin
  function isAdmin(req) {
    const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('admin='));
    return Boolean(cfg.adminPassword) && cookie && cookie.slice('admin='.length) === adminSecret;
  }

  app.post('/api/admin/login', (req, res) => {
    if (!cfg.adminPassword) return res.status(500).json({ error: 'ADMIN_PASSWORD is not configured' });
    const ok = crypto.timingSafeEqual(
      crypto.createHash('sha256').update(String(req.body?.password || '')).digest(),
      crypto.createHash('sha256').update(cfg.adminPassword).digest(),
    );
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    res.set('Set-Cookie', `admin=${adminSecret}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));

  app.post('/api/admin/delete', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Not logged in' });
    const parsed = parseKey(String(req.body?.key || ''));
    if (!parsed) return res.status(400).json({ error: 'bad key' });
    await storage.deleteObject(parsed.key);
    await storage.deleteObject(thumbKeyFor(parsed.key)).catch(() => {});
    invalidateListing();
    res.json({ ok: true });
  });

  // Streams every original as an uncompressed zip (photos are already compressed).
  app.get('/api/admin/download-all', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).send('Not logged in');
    const archiver = require('archiver');
    const originals = (await storage.listAll('photos/')).filter((o) => parseKey(o.key));
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="wedding-photos.zip"');
    const archive = archiver('zip', { store: true });
    archive.on('error', () => res.end());
    archive.pipe(res);
    for (const o of originals) {
      const { body } = await storage.getObject(o.key);
      const done = new Promise((resolve) => archive.once('entry', resolve));
      archive.append(body, { name: o.key.replace(/^photos\//, '') });
      await done; // one open storage stream at a time
    }
    archive.finalize();
  });

  return app;
}

if (require.main === module) {
  const storage = storageMod.create();
  const app = createApp(storage, config);
  app.listen(config.port, () => {
    console.log(`wedding-photos listening on :${config.port} (storage: ${storage.driver}, tables: ${config.tableCount})`);
  });
}

module.exports = { createApp, config };
