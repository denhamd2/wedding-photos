# John & Kate's Wedding Photo Wall 📸

Guests scan the QR code on their table, tap one big button, and their photos
upload straight from their phone — no app, no account, no sign-up. One shared
QR code for the whole wedding; everything lands in one shared gallery and is
**permanently stored** in Cloudflare R2, so nothing disappears after 12 months
like the commercial services.

## How it works

- The QR code opens the app's front page — "Upload photos" opens the phone's
  photo picker, "Take a photo" opens the camera. Every table gets the same card.
- Uploads go through the app server (same origin — no bucket CORS setup
  needed), which **compresses every image in-flight**: max 3840px (~4K) JPEG
  plus a gallery thumbnail. The uploaded original is never stored, keeping the
  bucket small. HEIC from iPhones is decoded server-side, so every photo gets
  a thumbnail. Videos stream straight to the bucket unchanged.
- **Exact duplicates are skipped:** each stored image is fingerprinted
  (SHA-256 of the processed JPEG) and recorded as a tiny `index/<hash>` marker in
  the bucket; if the same photo is uploaded again (a guest re-taps, or two guests
  share the same forwarded photo) it's detected and not stored twice. On first
  boot a one-time backfill fingerprints any photos uploaded before dedup existed
  and removes pre-existing byte-identical duplicates (keeping the earliest),
  gated by an `index/.backfilled` sentinel. Set `DEDUPE=0` (or `DEDUPE_BACKFILL=0`)
  to disable. Byte-exact only — it won't catch re-encoded or visually-similar
  variants.
- Object keys are the database: `photos/<timestamp>_<id>_<name>.jpg`.
  No SQL, no migrations — the gallery is a bucket listing.
- `/gallery` shows every photo, newest first, and **updates itself live** —
  it polls in the background and slides new guest uploads in at the top without
  a reload (a "↑ new photos" pill appears if you're scrolled down). Polling is
  cheap: the API returns an empty `304 Not Modified` via ETag when nothing has
  changed, so many guests watching at once barely touch the server.
  `/admin` (password-protected) can delete anything inappropriate and download
  everything as one zip.

## One-time setup

### 1. Cloudflare R2 (the permanent photo store)

1. Create a free Cloudflare account → **R2 Object Storage** → create bucket
   `johnkatiewedding` (free under 10GB; a whole wedding is typically 5–20GB,
   so worst case ≈ $0.15/month after). ✅ Done — David's bucket lives in the
   **EU jurisdiction**, so its S3 endpoint is
   `https://460c4bcf1a747dca96bc6bed6305d975.eu.r2.cloudflarestorage.com`
   (note the `.eu.`) — that's why `R2_ENDPOINT` must be set below.
2. **R2 → Manage API Tokens → Create API Token** with *Object Read & Write*
   on that bucket. Note the Access Key ID and Secret Access Key — they go
   straight into Railway's Variables panel in the next step, never into this
   repo. (Tip: if you only saved the `cfat_…` token value, the S3 credentials
   are derivable — the Access Key ID is shown on the token's detail page, and
   the Secret Access Key is the SHA-256 hex of the token value.)
No CORS configuration is needed — uploads are proxied through the app itself.

### 2. Railway (the app server)

1. New project → **Deploy from GitHub repo** → pick `denhamd2/wedding-photos`
   (branch `main`, no other settings needed — the app is the repo root).
2. Set these variables (Service → Variables):

   | Variable | Value |
   |---|---|
   | `R2_ACCOUNT_ID` | `460c4bcf1a747dca96bc6bed6305d975` |
   | `R2_ENDPOINT` | `https://460c4bcf1a747dca96bc6bed6305d975.eu.r2.cloudflarestorage.com` |
   | `R2_ACCESS_KEY_ID` | from the API token |
   | `R2_SECRET_ACCESS_KEY` | from the API token |
   | `R2_BUCKET` | `johnkatiewedding` |
   | `ADMIN_PASSWORD` | pick something strong |
   | `COUPLE_NAMES` | `John & Kate` (default) |
   | `MAX_UPLOAD_MB` | optional, default `500` |
   | `MAX_IMAGE_DIM` | optional, default `3840` (longest edge photos are resized to) |

3. Deploy and note the public URL.

### 3. Print the table cards

```bash
npm install
npm run qr -- --url https://YOUR-APP.up.railway.app --copies 14
```

Open `out/table-cards.html` in a browser and print — identical elegant A6
cards (one per table), high-error-correction QR (survives a bit of spilled
wine). `out/qr-code.png` is the bare code if you'd rather design your own
cards in Canva.

**Do a dress rehearsal:** print one card, scan it with a couple of different
phones, upload a photo, check it appears in the gallery.

## Running locally (no Cloudflare needed)

```bash
npm install
npm run dev        # STORAGE_DRIVER=local — files go to ./data/
npm test           # unit + API tests
```

## After the wedding

Photos live in R2 independently of the app — you can shut the Railway service
down whenever you like (stops the ~$5/month) and the photos stay put for
pennies. For a second permanent copy:

```bash
# one-time rclone config for R2 (rclone.org), then:
rclone sync r2:johnkatiewedding/photos ~/wedding-photos-backup
```

Or log into `/admin` and use **Download every original (zip)** while the app
is still running.

## Notes & limits

- Photos are stored as size-capped (~4K) JPEGs, not the phone originals —
  that's deliberate, to keep R2 storage small. 4K is plenty for prints up to
  poster size. Raise `MAX_IMAGE_DIM` before the wedding if you want more.
- HEIC/HEIF (iPhone originals) are decoded server-side, so every photo gets a
  proper thumbnail and a browser-viewable JPEG.
- Videos upload fine (500MB cap). After upload they're **transcoded in the
  background to 1080p H.264 MP4** (config `MAX_VIDEO_HEIGHT`, `VIDEO_CRF`) so
  they play everywhere — crucially, iPhone HEVC `.mov` clips that otherwise
  won't play in Chrome/Android — and a poster frame becomes the gallery tile.
  The guest sees "done" instantly; conversion happens after, one at a time.
  If the app restarts mid-transcode, a startup reconciler finishes the job.
  Requires `ffmpeg` (installed in the Docker image; `FFMPEG_PATH`/`FFPROBE_PATH`
  override the binaries if needed).
- The gallery URL is unlisted but public — anyone with the link can view.
  Keep the link to wedding guests, or put the app behind a password if the
  guest list is nosy.
