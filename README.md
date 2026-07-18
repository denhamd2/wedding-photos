# John & Katie's Wedding Photo Wall 📸

Guests scan the QR code on their table, tap one big button, and their photos
upload straight from their phone — no app, no account, no sign-up. Everything
lands in one shared gallery (tagged by table) and is **permanently stored** in
Cloudflare R2, so nothing disappears after 12 months like the commercial
services.

## How it works

- Each table card's QR code opens `/t/<table-number>` — a mobile page with an
  "Add your photos" button that opens the phone's own photo picker.
- Uploads go **directly from the guest's phone to the R2 bucket** via presigned
  URLs, so a burst of uploads during dinner never overloads the app server.
- Object keys are the database: `photos/table-05/<timestamp>_<id>_<name>.jpg`.
  No SQL, no migrations — the gallery is a bucket listing.
- `/gallery` shows every photo, filterable by table, with a "Table 3 is in the
  lead" counter. `/admin` (password-protected) can delete anything
  inappropriate and download every original as one zip.

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
3. On the bucket → **Settings → CORS policy**, add (replace the origin with
   your real app URL once you have it):

   ```json
   [
     {
       "AllowedOrigins": ["https://YOUR-APP.up.railway.app"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["Content-Type"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

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
   | `COUPLE_NAMES` | `John & Katie` (default) |
   | `TABLE_COUNT` | number of tables, e.g. `14` |
   | `MAX_UPLOAD_MB` | optional, default `500` |

3. Deploy, note the public URL, and put it in the R2 CORS rule above.

### 3. Print the table cards

```bash
npm install
npm run qr -- --tables 14 --url https://YOUR-APP.up.railway.app
```

Open `out/table-cards.html` in a browser and print — one elegant A6 card per
table, high-error-correction QR (survives a bit of spilled wine). Individual
PNGs land in `out/` too if you'd rather design your own cards in Canva.

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

- iPhones convert HEIC to JPEG on upload in almost all cases; if a rare
  original HEIC arrives, it's stored safely but shows as a placeholder tile in
  the gallery (the original is intact for the couple).
- Videos upload fine (500MB cap) and play in the gallery lightbox; they show a
  🎬 tile instead of a thumbnail.
- The gallery URL is unlisted but public — anyone with the link can view.
  Keep the link to wedding guests, or put the app behind a password if the
  guest list is nosy.
