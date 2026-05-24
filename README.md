# YouTube Likes -> Spotify Likes Sync

This web app syncs your recently liked YouTube videos into your Spotify library on a short polling interval (near real-time).

## What it does
- Connects to YouTube and Spotify with OAuth.
- Opens OAuth in popup windows so your dashboard stays on `localhost:3000`.
- Lets you preview matched songs before syncing.
- Lets you choose sync destination:
  - Spotify Liked Songs
  - Existing Spotify playlist
  - New Spotify playlist (name selectable)
- Lets you control transfer order (newest first or oldest first).
- Optional playlist date sort mode can reorder a playlist by latest activity date (YouTube like timestamp + Spotify saved-track timestamp), newest first.
- Reads your YouTube liked videos playlist.
- Searches Spotify by cleaned YouTube title.
- Saves matched tracks to your Spotify library.
- Runs one-shot sync or continuous auto-sync.
- Paginates YouTube likes (not just first page) and processes a configurable batch size per run.

## Important limitations
- True instant real-time for YouTube likes is not available through a dedicated likes webhook; this app uses periodic polling.
- Matching is heuristic (video title to track search), so some songs may be unmatched or mismatched.
- Session/token state is persisted locally in `data/sessions.json` so reconnect is usually not needed after restart.

## Setup
1. Create Google Cloud OAuth credentials for a Web app and enable YouTube Data API v3.
2. Create Spotify app credentials.
3. Copy `.env.example` to `.env` and fill values.
4. Choose protocol:
   - HTTP mode: keep `HTTPS_ENABLED=false` and `APP_BASE_URL=http://localhost:3000`
   - HTTPS mode: set:
     - `HTTPS_ENABLED=true`
     - `APP_BASE_URL=https://localhost:3000`
     - Use either:
       - `HTTPS_PFX_PATH=./certs/localhost.pfx` and `HTTPS_PFX_PASSPHRASE=...`
       - or `HTTPS_KEY_PATH=...` + `HTTPS_CERT_PATH=...`
5. Add these redirect URIs in both Google and Spotify (must match your protocol exactly):
   - `http://localhost:3000/auth/youtube/callback` or `https://localhost:3000/auth/youtube/callback`
   - `http://localhost:3000/auth/spotify/callback` or `https://localhost:3000/auth/spotify/callback`
6. If using HTTPS, create local certs.

### Windows PowerShell (.pfx)

```powershell
$pwd = ConvertTo-SecureString 'changeit123!' -AsPlainText -Force
$cert = New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation 'Cert:\CurrentUser\My'
New-Item -ItemType Directory -Force certs | Out-Null
Export-PfxCertificate -Cert $cert -FilePath .\certs\localhost.pfx -Password $pwd
```

Set in `.env`:

```env
HTTPS_ENABLED=true
APP_BASE_URL=https://localhost:3000
HTTPS_PFX_PATH=./certs/localhost.pfx
HTTPS_PFX_PASSPHRASE=changeit123!
```

### mkcert (if installed)

```bash
mkcert -install
mkcert -key-file certs/localhost-key.pem -cert-file certs/localhost.pem localhost 127.0.0.1 ::1
```

Set in `.env`:

```env
HTTPS_ENABLED=true
APP_BASE_URL=https://localhost:3000
HTTPS_KEY_PATH=./certs/localhost-key.pem
HTTPS_CERT_PATH=./certs/localhost.pem
```

7. Install and run:

```bash
npm install
npm start
```

Then open either `http://localhost:3000` or `https://localhost:3000` based on your `.env`.

## Spotify Re-Auth Note
If you previously connected Spotify before playlist features were added, reconnect Spotify so the app receives playlist scopes (`playlist-read-private`, `playlist-modify-public`, `playlist-modify-private`).

## Sync volume tuning
- `YOUTUBE_MAX_ITEMS_PER_RUN` (default `1000`): how many liked videos to fetch each run. Set `0` for unlimited.
- `SYNC_PROCESS_LIMIT` (default `1000`): how many new candidates to attempt matching/saving per run. Set `0` for unlimited.
