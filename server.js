'use strict';

const crypto = require('crypto');
const path = require('path');
const { Transform } = require('stream');
const express = require('express');

const storageMod = require('./lib/storage');
const { makeKey, parseKey, thumbKeyFor, extFor, sanitizeName, VIDEO_EXTS } = require('./lib/keys');
const { processImage } = require('./lib/process');
const { createVideoQueue } = require('./lib/videoqueue');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  coupleNames: process.env.COUPLE_NAMES || 'John & Katie',
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '500', 10),
  maxImageDim: parseInt(process.env.MAX_IMAGE_DIM || '3840', 10),
  maxVideoHeight: parseInt(process.env.MAX_VIDEO_HEIGHT || '1080', 10),
  videoCrf: parseInt(process.env.VIDEO_CRF || '26', 10),
  dedupe: process.env.DEDUPE !== '0',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  listCacheMs: parseInt(process.env.LIST_CACHE_MS || '10000', 10),
};

function createApp(storage, cfg = config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // request log for API traffic so platform logs can answer "what failed?"
  app.use('/api', (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} in ${Date.now() - start}ms (${req.headers['content-length'] || 0} bytes in)`);
    });
    next();
  });

  const adminSecret = crypto.createHmac('sha256', cfg.adminPassword || crypto.randomBytes(16).toString('hex'))
    .update('wedding-admin-session').digest('hex');

  // ---- listing cache (the bucket is the database; avoid re-listing on every request)
  let listCache = { at: 0, photos: null };
  function invalidateListing() { listCache = { at: 0, photos: null }; }

  // ---- exact-duplicate dedup. The bucket is the index: a marker object
  // `index/<sha256-of-original>` records that a file's bytes were already seen.
  // `inflight` guards against the same file double-tapped before its marker lands.
  const inflight = new Set();
  const indexKeyFor = (hash) => `index/${hash}`;

  async function isDuplicate(hash) {
    if (inflight.has(hash)) return true;
    try {
      await storage.headObject(indexKeyFor(hash));
      return true;
    } catch {
      return false;
    }
  }
  async function markSeen(hash, photoKey) {
    await storage.putObject(indexKeyFor(hash), Buffer.from(photoKey), 'text/plain');
  }

  // background video transcoding (HEVC .mov → H.264 mp4 + poster)
  const videoQueue = createVideoQueue({
    storage,
    onListingChange: invalidateListing,
    maxHeight: cfg.maxVideoHeight,
    crf: cfg.videoCrf,
  });
  app.locals.videoQueue = videoQueue;

  async function listPhotos() {
    if (listCache.photos && Date.now() - listCache.at < cfg.listCacheMs) return listCache.photos;
    const [originals, thumbs] = await Promise.all([storage.listAll('photos/'), storage.listAll('thumbs/')]);
    const thumbKeys = new Set(thumbs.map((t) => t.key));
    const photos = originals
      .map((o) => ({ ...parseKey(o.key), size: o.size }))
      .filter((p) => p.key)
      .map((p) => ({
        key: p.key,
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

  // ---- health & pages: one QR for everyone, so the upload page IS the front page
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'upload.html')));
  app.get('/t/:table', (req, res) => res.redirect('/')); // old per-table links
  app.get('/gallery', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gallery.html')));
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
  app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1h' }));

  app.get('/api/config', (req, res) => {
    res.json({ coupleNames: cfg.coupleNames, maxUploadMb: cfg.maxUploadMb });
  });

  // ---- upload flow: one same-origin PUT per file (no bucket CORS involved).
  // Images are re-encoded in-flight (max ~4K JPEG + thumb) and the original is
  // never stored; videos stream straight through to the bucket unchanged.
  app.put('/api/upload', async (req, res) => {
    const filename = String(req.query.filename || '');
    const uploader = sanitizeName(String(req.query.uploader || ''));
    const contentType = (req.headers['content-type'] || '').split(';')[0];
    const ext = extFor(contentType, filename);
    if (!ext) {
      req.resume();
      return res.status(400).json({ error: `"${filename || 'this file'}" is not a photo or video we can accept` });
    }
    const declaredLen = parseInt(req.headers['content-length'] || '0', 10);
    const maxBytes = cfg.maxUploadMb * 1024 * 1024;
    if (!declaredLen || declaredLen > maxBytes) {
      req.resume();
      return res.status(413).json({ error: `File is too large (max ${cfg.maxUploadMb}MB)` });
    }

    try {
      if (VIDEO_EXTS.has(ext)) {
        // hash the original bytes as they stream to storage (no buffering)
        const hasher = crypto.createHash('sha256');
        const tap = new Transform({
          transform(chunk, _enc, cb) { hasher.update(chunk); cb(null, chunk); },
        });
        const key = makeKey(ext, uploader);
        req.pipe(tap);
        await storage.putObject(key, tap, contentType || 'application/octet-stream', declaredLen);
        const hash = hasher.digest('hex');

        if (cfg.dedupe && await isDuplicate(hash)) {
          await storage.deleteObject(key).catch(() => {});
          return res.json({ ok: true, duplicate: true });
        }
        if (cfg.dedupe) { inflight.add(hash); await markSeen(hash, key).finally(() => inflight.delete(hash)); }
        invalidateListing();
        res.json({ ok: true, key });
        videoQueue.enqueue(key); // convert to compatible MP4 + poster in the background
        return;
      }

      // image: buffer (bounded by the size check above), then hash + compress
      const chunks = [];
      let received = 0;
      for await (const chunk of req) {
        received += chunk.length;
        if (received > maxBytes) throw Object.assign(new Error('too large'), { status: 413 });
        chunks.push(chunk);
      }
      const original = Buffer.concat(chunks);
      const hash = crypto.createHash('sha256').update(original).digest('hex');
      if (cfg.dedupe && await isDuplicate(hash)) {
        return res.json({ ok: true, duplicate: true });
      }
      if (cfg.dedupe) inflight.add(hash);
      try {
        const { full, thumb } = await processImage(original, ext, cfg.maxImageDim);
        const key = makeKey('jpg', uploader);
        await storage.putObject(key, full, 'image/jpeg');
        await storage.putObject(thumbKeyFor(key), thumb, 'image/webp');
        if (cfg.dedupe) await markSeen(hash, key);
        invalidateListing();
        res.json({ ok: true, key });
      } finally {
        inflight.delete(hash);
      }
    } catch (err) {
      console.error('upload failed:', err.message);
      const status = err.status || 500;
      res.status(status).json({
        error: status === 413 ? `File is too large (max ${cfg.maxUploadMb}MB)` : 'We could not read that photo — please try again.',
      });
    }
  });

  // ---- gallery. The gallery page polls this to stay live; an ETag lets the
  // common "nothing changed since last poll" case return an empty 304, so many
  // guests polling at once cost almost nothing.
  app.get('/api/photos', async (req, res) => {
    try {
      const photos = await listPhotos();
      // weak validator from what the gallery renders (keys + poster availability)
      const sig = photos.map((p) => `${p.key}:${p.thumb ? 1 : 0}`).join('|');
      const etag = `W/"${crypto.createHash('sha1').update(sig).digest('base64').slice(0, 24)}"`;
      res.set('Cache-Control', 'no-cache');
      res.set('ETag', etag);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.json({ coupleNames: cfg.coupleNames, total: photos.length, photos });
    } catch (err) {
      console.error('listing failed:', err);
      res.status(500).json({ error: 'Could not load photos' });
    }
  });

  app.get(/^\/img\/(photos|thumbs)\/(.+)$/, async (req, res) => {
    const key = `${req.params[0]}/${req.params[1]}`;
    if (key.includes('..')) return res.status(400).end();

    // Parse a single-range "bytes=start-end" request (video seeking on iOS Safari).
    let range;
    const header = req.headers.range;
    if (header) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
      if (m && (m[1] || m[2])) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : Number.MAX_SAFE_INTEGER;
        range = { start, end };
      }
    }

    try {
      const obj = await storage.getObject(key, range);
      res.set('Content-Type', obj.contentType || 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('Accept-Ranges', 'bytes');
      if (range && obj.range && obj.totalLength) {
        res.status(206);
        res.set('Content-Range', `bytes ${obj.range.start}-${obj.range.end}/${obj.totalLength}`);
      }
      if (obj.contentLength != null) res.set('Content-Length', String(obj.contentLength));
      obj.body.pipe(res);
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

  // Streams every stored photo/video as an uncompressed zip (JPEGs are already compressed).
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
  const server = app.listen(config.port, () => {
    console.log(`wedding-photos listening on :${config.port} (storage: ${storage.driver})`);
    // pick up any videos left un-transcoded by a previous run
    app.locals.videoQueue.reconcile();
  });
  // Node's 5s default is shorter than the platform edge proxy's idle timeout,
  // so the proxy reuses sockets we've already closed and the first request on
  // one fails ("works on retry"). Keep sockets open longer than the proxy does.
  server.keepAliveTimeout = 76_000;
  server.headersTimeout = 77_000; // must exceed keepAliveTimeout
  server.requestTimeout = 0; // large uploads on slow venue wifi can exceed the 5-min default
}

module.exports = { createApp, config };
