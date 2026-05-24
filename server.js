require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const app = express();
const port = Number(process.env.PORT || 3000);
const httpsEnabled = String(process.env.HTTPS_ENABLED || 'false').toLowerCase() === 'true';
const baseProtocol = httpsEnabled ? 'https' : 'http';
const baseUrl = process.env.APP_BASE_URL || `${baseProtocol}://localhost:${port}`;
const syncIntervalMs = Math.max(30, Number(process.env.SYNC_INTERVAL_SECONDS || 120)) * 1000;
const youtubeMaxItemsPerRunRaw = Number(process.env.YOUTUBE_MAX_ITEMS_PER_RUN || 50);
const youtubeMaxItemsPerRun = Number.isFinite(youtubeMaxItemsPerRunRaw) && youtubeMaxItemsPerRunRaw > 0
  ? Math.min(50, Math.floor(youtubeMaxItemsPerRunRaw))
  : 50;
const syncProcessLimitRaw = Number(process.env.SYNC_PROCESS_LIMIT || 0);
const syncProcessLimit = Number.isFinite(syncProcessLimitRaw) && syncProcessLimitRaw > 0
  ? Math.floor(syncProcessLimitRaw)
  : null;
const spotifyMaxTracksPerRunRaw = Number(process.env.SPOTIFY_MAX_TRACKS_PER_RUN || 50);
const spotifyMaxTracksPerRun = Number.isFinite(spotifyMaxTracksPerRunRaw) && spotifyMaxTracksPerRunRaw > 0
  ? Math.min(50, Math.floor(spotifyMaxTracksPerRunRaw))
  : 50;
const defaultPreviewLimit = Math.max(10, Number(process.env.SYNC_PREVIEW_LIMIT || 150));
const apiRetryLimit = Math.max(1, Number(process.env.API_RETRY_LIMIT || 6));
const apiRetryBaseDelayMs = Math.max(200, Number(process.env.API_RETRY_BASE_DELAY_MS || 1000));
const apiRetryCapMs = Math.max(1000, Number(process.env.API_RETRY_CAP_MS || 30000));
const spotifyApiMinIntervalMs = Math.max(0, Number(process.env.SPOTIFY_API_MIN_INTERVAL_MS || 350));
const spotifySearchExtraDelayMs = Math.max(0, Number(process.env.SPOTIFY_SEARCH_EXTRA_DELAY_MS || 250));

app.use(express.json());
app.use(cookieParser(process.env.SESSION_SECRET || 'dev-secret'));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const syncTimers = new Map();
const dataDir = path.join(__dirname, 'data');
const sessionsFilePath = path.join(dataDir, 'sessions.json');
let persistScheduled = false;

function defaultSyncOptions() {
  return {
    destination: 'library',
    order: 'newest',
    playlistMode: 'new',
    playlistId: '',
    playlistName: 'Bridgebeat Sync',
    playlistPublic: false,
    playlistDateSort: false,
    activePlaylistId: '',
  };
}

function buildDefaultSession() {
  return {
    youtube: null,
    spotify: null,
    importedVideoIds: new Set(),
    failedVideoIds: new Set(),
    skippedVideoIds: new Set(),
    trackEvents: {},
    lastRun: null,
    lastRunResult: null,
    syncProgress: null,
    syncOptions: defaultSyncOptions(),
    autoSyncOptions: defaultSyncOptions(),
    preview: null,
  };
}

function normalizeSyncOptions(raw, existing = defaultSyncOptions()) {
  const merged = { ...existing, ...(raw || {}) };
  const destination = merged.destination === 'playlist' ? 'playlist' : 'library';
  const order = merged.order === 'oldest' ? 'oldest' : 'newest';
  const playlistMode = merged.playlistMode === 'existing' ? 'existing' : 'new';
  const playlistId = String(merged.playlistId || '').trim();
  const playlistName = String(merged.playlistName || '').trim();
  const activePlaylistId = String(merged.activePlaylistId || '').trim();

  return {
    destination,
    order,
    playlistMode,
    playlistId,
    playlistName: playlistName || 'Bridgebeat Sync',
    playlistPublic: Boolean(merged.playlistPublic),
    playlistDateSort: Boolean(merged.playlistDateSort),
    activePlaylistId,
  };
}

function sessionToPersistable(session) {
  return {
    youtube: session.youtube || null,
    spotify: session.spotify || null,
    importedVideoIds: Array.from(session.importedVideoIds || []),
    failedVideoIds: Array.from(session.failedVideoIds || []),
    skippedVideoIds: Array.from(session.skippedVideoIds || []),
    trackEvents: session.trackEvents || {},
    lastRun: session.lastRun || null,
    lastRunResult: session.lastRunResult || null,
    syncOptions: normalizeSyncOptions(session.syncOptions, defaultSyncOptions()),
    autoSyncOptions: normalizeSyncOptions(session.autoSyncOptions, defaultSyncOptions()),
    preview: session.preview || null,
  };
}

function sessionFromPersisted(record) {
  const base = buildDefaultSession();
  if (!record || typeof record !== 'object') return base;
  return {
    ...base,
    youtube: record.youtube || null,
    spotify: record.spotify || null,
    importedVideoIds: new Set(Array.isArray(record.importedVideoIds) ? record.importedVideoIds : []),
    failedVideoIds: new Set(Array.isArray(record.failedVideoIds) ? record.failedVideoIds : []),
    skippedVideoIds: new Set(Array.isArray(record.skippedVideoIds) ? record.skippedVideoIds : []),
    trackEvents: record.trackEvents && typeof record.trackEvents === 'object' ? record.trackEvents : {},
    lastRun: record.lastRun || null,
    lastRunResult: record.lastRunResult || null,
    syncOptions: normalizeSyncOptions(record.syncOptions, base.syncOptions),
    autoSyncOptions: normalizeSyncOptions(record.autoSyncOptions, base.autoSyncOptions),
    preview: record.preview || null,
  };
}

function persistSessionsNow() {
  fs.mkdirSync(dataDir, { recursive: true });
  const all = {};
  for (const [sid, session] of sessions.entries()) {
    all[sid] = sessionToPersistable(session);
  }
  const tempPath = `${sessionsFilePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(all, null, 2), 'utf8');
  fs.renameSync(tempPath, sessionsFilePath);
}

function schedulePersistSessions() {
  if (persistScheduled) return;
  persistScheduled = true;
  setTimeout(() => {
    persistScheduled = false;
    try {
      persistSessionsNow();
    } catch (err) {
      console.error('Session persistence failed:', err.message);
    }
  }, 150);
}

function loadPersistedSessions() {
  try {
    if (!fs.existsSync(sessionsFilePath)) return;
    const raw = fs.readFileSync(sessionsFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    for (const [sid, record] of Object.entries(parsed)) {
      if (!sid) continue;
      sessions.set(sid, sessionFromPersisted(record));
    }
  } catch (err) {
    console.error('Failed to load persisted sessions:', err.message);
  }
}

process.on('exit', () => {
  try {
    persistSessionsNow();
  } catch (_) {}
});

function getOrCreateSession(req, res) {
  let sid = req.signedCookies.sid;
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomUUID();
    while (sessions.has(sid)) sid = crypto.randomUUID();
    sessions.set(sid, buildDefaultSession());
    schedulePersistSessions();
    res.cookie('sid', sid, { httpOnly: true, signed: true, sameSite: 'lax' });
  }
  return { sid, session: sessions.get(sid) };
}

function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeState(state) {
  return JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
}

function renderPopupResponse({ provider, ok, message }) {
  const payload = JSON.stringify({ type: 'oauth_result', provider, ok, message });
  const title = ok ? 'Authentication completed' : 'Authentication failed';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body style="font-family: Segoe UI, sans-serif; padding: 16px;">
    <p>${message}</p>
    <p>You can close this window.</p>
    <script>
      (function () {
        const payload = ${payload};
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, window.location.origin);
          }
        } catch (e) {}
        window.close();
      })();
    </script>
  </body>
</html>`;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// Cache for API responses (TTL: 15 minutes)
const apiCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;
let spotifyApiLane = Promise.resolve();
let spotifyLastRequestAt = 0;

function getCacheKey(url, opts = {}) {
  const method = opts.method || 'GET';
  return `${method}:${url}`;
}

function getCachedResponse(url, opts = {}) {
  const key = getCacheKey(url, opts);
  const cached = apiCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    console.log(`[cache] HIT: ${url}`);
    return cached.data;
  }
  if (cached) apiCache.delete(key);
  return null;
}

function setCachedResponse(url, opts = {}, data) {
  const key = getCacheKey(url, opts);
  apiCache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  console.log(`[cache] SET: ${url} (expires in 15 min)`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    // Retry-After is typically seconds, but some providers/middlewares return ms.
    // Interpret very large numeric values as already-ms to avoid accidental multi-hour delays.
    return numeric > 1000 ? numeric : numeric * 1000;
  }
  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return null;
  const delta = asDate - Date.now();
  return delta > 0 ? delta : 0;
}

function jitterMs(rangeMs = 300) {
  return Math.floor(Math.random() * Math.max(1, rangeMs));
}

async function withSpotifyRateLimit(url, fn) {
  const parsed = (() => {
    try {
      return new URL(url);
    } catch (_) {
      return null;
    }
  })();
  const isSpotifyApi = parsed?.hostname === 'api.spotify.com';
  if (!isSpotifyApi) return fn();

  const pathname = parsed?.pathname || '';
  const extraDelay = pathname === '/v1/search' ? spotifySearchExtraDelayMs : 0;

  const task = spotifyApiLane.then(async () => {
    const now = Date.now();
    const earliestNext = spotifyLastRequestAt + spotifyApiMinIntervalMs + extraDelay;
    if (earliestNext > now) {
      await sleep(earliestNext - now);
    }
    spotifyLastRequestAt = Date.now();
    return fn();
  });

  spotifyApiLane = task.catch(() => {});
  return task;
}

async function httpRequest(url, opts = {}) {
  // Only cache GET requests from Spotify API
  const isCacheable = (opts.method || 'GET') === 'GET' && url.includes('spotify.com');

  if (isCacheable) {
    const cached = getCachedResponse(url, opts);
    if (cached) return cached;
  }

  let attempt = 0;
  while (attempt <= apiRetryLimit) {
    const r = await withSpotifyRateLimit(url, () => fetch(url, opts));
    if (r.ok) {
      const ct = r.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await r.json() : await r.text();

      if (isCacheable) {
        setCachedResponse(url, opts, data);
      }

      return data;
    }

    const body = await r.text();
    const canRetry = r.status === 429 || (r.status >= 500 && r.status <= 599);
    if (!canRetry || attempt >= apiRetryLimit) {
      throw new Error(`${r.status} ${r.statusText}: ${body}`);
    }

    const retryAfterMs = parseRetryAfterMs(r.headers.get('retry-after'));
    const expDelay = Math.min(apiRetryCapMs, apiRetryBaseDelayMs * (2 ** attempt));
    const requestedDelay = Math.max(retryAfterMs || 0, expDelay);
    const delayMs = Math.min(apiRetryCapMs, requestedDelay) + jitterMs();
    const endpoint = (() => {
      try {
        return new URL(url).pathname;
      } catch (_) {
        return url;
      }
    })();
    console.warn(`[rate-limit] ${r.status} on ${endpoint}; retry ${attempt + 1}/${apiRetryLimit} in ${delayMs}ms`);
    await sleep(delayMs);
    attempt += 1;
  }

  throw new Error('Request retry loop exited unexpectedly.');
}

function youtubeRedirectUri() {
  return `${baseUrl}/auth/youtube/callback`;
}

function spotifyRedirectUri() {
  return `${baseUrl}/auth/spotify/callback`;
}

loadPersistedSessions();

async function bestEffortRevokeGoogleToken(token) {
  if (!token) return;
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch (_) {}
}

app.get('/auth/youtube/start', (req, res) => {
  const { sid } = getOrCreateSession(req, res);
  const popup = req.query.popup === '1';
  const state = encodeState({ sid, popup, nonce: crypto.randomUUID() });
  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID,
    redirect_uri: youtubeRedirectUri(),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/auth/youtube/callback', async (req, res) => {
  let popup = false;
  try {
    const state = decodeState(String(req.query.state || ''));
    const sid = state.sid;
    popup = Boolean(state.popup);
    if (!sessions.has(sid)) throw new Error('Invalid session state');
    if (req.query.error) throw new Error(`OAuth error: ${req.query.error}`);

    const token = await httpRequest('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: process.env.YOUTUBE_CLIENT_ID,
        client_secret: process.env.YOUTUBE_CLIENT_SECRET,
        redirect_uri: youtubeRedirectUri(),
        grant_type: 'authorization_code',
      }),
    });

    sessions.get(sid).youtube = token;
    schedulePersistSessions();
    res.cookie('sid', sid, { httpOnly: true, signed: true, sameSite: 'lax' });

    if (popup) {
      res.type('html').send(renderPopupResponse({
        provider: 'youtube',
        ok: true,
        message: 'YouTube connected successfully.',
      }));
      return;
    }
    res.redirect('/');
  } catch (err) {
    if (popup) {
      res.status(400).type('html').send(renderPopupResponse({
        provider: 'youtube',
        ok: false,
        message: `YouTube auth failed: ${err.message}`,
      }));
      return;
    }
    res.status(400).send(`YouTube auth failed: ${err.message}`);
  }
});

app.get('/auth/spotify/start', (req, res) => {
  const { sid } = getOrCreateSession(req, res);
  const popup = req.query.popup === '1';
  const state = encodeState({ sid, popup, nonce: crypto.randomUUID() });
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: spotifyRedirectUri(),
    scope: 'user-library-read user-library-modify playlist-read-private playlist-modify-public playlist-modify-private',
    state,
    show_dialog: 'true',
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/auth/spotify/callback', async (req, res) => {
  let popup = false;
  try {
    const state = decodeState(String(req.query.state || ''));
    const sid = state.sid;
    popup = Boolean(state.popup);
    if (!sessions.has(sid)) throw new Error('Invalid session state');
    if (req.query.error) throw new Error(`OAuth error: ${req.query.error}`);

    const token = await httpRequest('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        redirect_uri: spotifyRedirectUri(),
        grant_type: 'authorization_code',
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET,
      }),
    });

    sessions.get(sid).spotify = token;
    schedulePersistSessions();
    res.cookie('sid', sid, { httpOnly: true, signed: true, sameSite: 'lax' });

    if (popup) {
      res.type('html').send(renderPopupResponse({
        provider: 'spotify',
        ok: true,
        message: 'Spotify connected successfully.',
      }));
      return;
    }
    res.redirect('/');
  } catch (err) {
    if (popup) {
      res.status(400).type('html').send(renderPopupResponse({
        provider: 'spotify',
        ok: false,
        message: `Spotify auth failed: ${err.message}`,
      }));
      return;
    }
    res.status(400).send(`Spotify auth failed: ${err.message}`);
  }
});

app.post('/auth/logout/youtube', async (req, res) => {
  const { sid, session } = getOrCreateSession(req, res);
  try {
    await bestEffortRevokeGoogleToken(session.youtube?.refresh_token || session.youtube?.access_token);
  } catch (_) {}
  session.youtube = null;
  const timer = syncTimers.get(sid);
  if (timer) {
    clearInterval(timer);
    syncTimers.delete(sid);
  }
  schedulePersistSessions();
  res.json({ ok: true, youtubeConnected: false });
});

app.post('/auth/logout/spotify', async (req, res) => {
  const { sid, session } = getOrCreateSession(req, res);
  session.spotify = null;
  const timer = syncTimers.get(sid);
  if (timer) {
    clearInterval(timer);
    syncTimers.delete(sid);
  }
  schedulePersistSessions();
  res.json({ ok: true, spotifyConnected: false });
});

app.post('/auth/logout/all', async (req, res) => {
  const { sid, session } = getOrCreateSession(req, res);
  try {
    await bestEffortRevokeGoogleToken(session.youtube?.refresh_token || session.youtube?.access_token);
  } catch (_) {}
  session.youtube = null;
  session.spotify = null;
  const timer = syncTimers.get(sid);
  if (timer) {
    clearInterval(timer);
    syncTimers.delete(sid);
  }
  schedulePersistSessions();
  res.json({ ok: true, youtubeConnected: false, spotifyConnected: false });
});

async function refreshYouTubeIfNeeded(session) {
  if (!session.youtube) throw new Error('YouTube not connected');
  if (!session.youtube.refresh_token) return;
  const refreshed = await httpRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID,
      client_secret: process.env.YOUTUBE_CLIENT_SECRET,
      refresh_token: session.youtube.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  session.youtube = { ...session.youtube, ...refreshed, refresh_token: session.youtube.refresh_token };
  schedulePersistSessions();
}

async function refreshSpotifyIfNeeded(session) {
  if (!session.spotify) throw new Error('Spotify not connected');
  const refreshed = await httpRequest('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.spotify.refresh_token,
      client_id: process.env.SPOTIFY_CLIENT_ID,
      client_secret: process.env.SPOTIFY_CLIENT_SECRET,
    }),
  });
  session.spotify = { ...session.spotify, ...refreshed, refresh_token: session.spotify.refresh_token };
  schedulePersistSessions();
}

function normalizeTitle(title) {
  return title
    .replace(/\(.*?official.*?\)/ig, '')
    .replace(/\[.*?official.*?\]/ig, '')
    .replace(/\(lyrics?\)/ig, '')
    .replace(/\[lyrics?\]/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function latestIsoTimestamp(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

async function getYouTubeLikedVideos(session) {
  await refreshYouTubeIfNeeded(session);
  const channel = await httpRequest('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true', {
    headers: { Authorization: `Bearer ${session.youtube.access_token}` },
  });

  const likesPlaylistId = channel?.items?.[0]?.contentDetails?.relatedPlaylists?.likes;
  if (!likesPlaylistId) throw new Error('Could not find YouTube liked playlist for this account.');

  const likedVideos = [];
  let nextPageToken = '';

  while (youtubeMaxItemsPerRun === null || likedVideos.length < youtubeMaxItemsPerRun) {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      maxResults: '50',
      playlistId: likesPlaylistId,
    });
    if (nextPageToken) params.set('pageToken', nextPageToken);

    const page = await httpRequest(`https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`, {
      headers: { Authorization: `Bearer ${session.youtube.access_token}` },
    });

    const mapped = (page.items || []).map((item) => ({
      videoId: item?.contentDetails?.videoId,
      title: item?.snippet?.title || '',
      likedAt: item?.snippet?.publishedAt || null,
    })).filter((x) => x.videoId && x.title && x.title !== 'Deleted video' && x.title !== 'Private video');

    likedVideos.push(...mapped);
    nextPageToken = page.nextPageToken || '';
    if (!nextPageToken) break;
  }

  return youtubeMaxItemsPerRun ? likedVideos.slice(0, youtubeMaxItemsPerRun) : likedVideos;
}

function orderByPreference(items, order) {
  if (order === 'oldest') return [...items].reverse();
  return items;
}

async function searchSpotifyTrack(session, query) {
  const params = new URLSearchParams({ q: query, type: 'track', limit: '1' });
  const data = await httpRequest(`https://api.spotify.com/v1/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${session.spotify.access_token}` },
  });
  return data?.tracks?.items?.[0] || null;
}

async function saveSpotifyTracks(session, uris) {
  if (!uris.length) return;
  await httpRequest('https://api.spotify.com/v1/me/library', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${session.spotify.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uris }),
  });
}

async function listSpotifyPlaylists(session) {
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50&offset=0';
  const all = [];
  while (url) {
    const page = await httpRequest(url, {
      headers: { Authorization: `Bearer ${session.spotify.access_token}` },
    });
    all.push(...(page.items || []));
    url = page.next;
  }
  return all;
}

async function createSpotifyPlaylist(session, name, isPublic) {
  return httpRequest('https://api.spotify.com/v1/me/playlists', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.spotify.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      public: Boolean(isPublic),
      description: 'Synced from YouTube Likes by Bridgebeat Sync',
    }),
  });
}

async function addPlaylistItems(session, playlistId, uris, position) {
  if (!uris.length) return;
  await httpRequest(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.spotify.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uris, ...(Number.isInteger(position) ? { position } : {}) }),
  });
}

async function getPlaylistItems(session, playlistId) {
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&offset=0`;
  const items = [];
  while (url) {
    const page = await httpRequest(url, {
      headers: { Authorization: `Bearer ${session.spotify.access_token}` },
    });
    for (const row of page.items || []) {
      const track = row.track || row.item;
      const uri = track?.uri;
      if (uri && uri.startsWith('spotify:track:')) {
        items.push({
          uri,
          name: track?.name || '',
          playlistAddedAt: row?.added_at || null,
        });
      }
    }
    url = page.next;
  }
  return items;
}

async function getSpotifySavedTrackAddedAtMap(session, wantedUris = null) {
  let offset = 0;
  const found = {};
  const targetCount = wantedUris ? wantedUris.size : null;

  while (true) {
    const page = await httpRequest(`https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset}`, {
      headers: { Authorization: `Bearer ${session.spotify.access_token}` },
    });

    for (const item of page.items || []) {
      const uri = item?.track?.uri;
      const addedAt = item?.added_at || null;
      if (!uri || !addedAt) continue;
      if (wantedUris && !wantedUris.has(uri)) continue;
      found[uri] = latestIsoTimestamp(found[uri], addedAt);
    }

    if (!page.next) break;
    if (targetCount && Object.keys(found).length >= targetCount) break;
    offset += page.limit || 50;
  }

  return found;
}

async function replacePlaylistInChunks(session, playlistId, orderedUris) {
  const chunks = chunk(orderedUris, 100);
  if (!chunks.length) {
    await httpRequest(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${session.spotify.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: [] }),
    });
    return;
  }

  await httpRequest(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${session.spotify.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uris: chunks[0] }),
  });

  for (const extra of chunks.slice(1)) {
    await addPlaylistItems(session, playlistId, extra);
  }
}

async function reorderPlaylistByUnifiedDate(session, playlistId) {
  const playlistItems = await getPlaylistItems(session, playlistId);
  if (!playlistItems.length) return { changed: false, reason: 'Playlist is empty' };

  const uriSet = new Set(playlistItems.map((x) => x.uri));
  const spotifySavedMap = await getSpotifySavedTrackAddedAtMap(session, uriSet);
  const originalOrderUris = playlistItems.map((x) => x.uri);

  const ranked = playlistItems.map((item, index) => {
    const ytEventAt = session.trackEvents?.[item.uri] || null;
    const spSavedAt = spotifySavedMap[item.uri] || null;
    const activityAt = latestIsoTimestamp(ytEventAt, spSavedAt);
    return {
      ...item,
      index,
      activityAt,
    };
  });

  ranked.sort((a, b) => {
    const ta = a.activityAt ? Date.parse(a.activityAt) : Number.NEGATIVE_INFINITY;
    const tb = b.activityAt ? Date.parse(b.activityAt) : Number.NEGATIVE_INFINITY;
    if (tb !== ta) return tb - ta;
    return a.index - b.index;
  });

  const orderedUris = ranked.map((x) => x.uri);
  const changed = orderedUris.some((uri, i) => uri !== originalOrderUris[i]);
  if (!changed) return { changed: false, reason: 'Order already current' };

  await replacePlaylistInChunks(session, playlistId, orderedUris);
  return { changed: true, total: orderedUris.length };
}

async function getOrCreateTargetPlaylist(session, options) {
  if (options.playlistMode === 'existing') {
    if (!options.playlistId) throw new Error('Select an existing playlist first.');
    return { id: options.playlistId, name: options.playlistName || 'Existing playlist', created: false };
  }

  if (options.activePlaylistId) {
    return { id: options.activePlaylistId, name: options.playlistName, created: false };
  }

  const created = await createSpotifyPlaylist(session, options.playlistName, options.playlistPublic);
  return { id: created.id, name: created.name, created: true };
}

async function buildSyncCandidates(session, options) {
  const likedVideos = await getYouTubeLikedVideos(session);
  const pending = likedVideos.filter((v) => !session.importedVideoIds.has(v.videoId) && !session.skippedVideoIds.has(v.videoId));
  const orderedPending = orderByPreference(pending, options.order);
  const effectiveLimit = syncProcessLimit ? Math.min(syncProcessLimit, spotifyMaxTracksPerRun) : spotifyMaxTracksPerRun;
  const candidates = orderedPending.slice(0, effectiveLimit);
  return { likedVideos, pending, candidates };
}

async function buildPreview(session, options, limit) {
  await refreshSpotifyIfNeeded(session);
  const { likedVideos, pending, candidates } = await buildSyncCandidates(session, options);
  const previewCount = Math.max(1, Number(limit || defaultPreviewLimit));
  const previewCandidates = candidates.slice(0, previewCount);

  const items = [];
  for (const v of previewCandidates) {
    const query = normalizeTitle(v.title);
    const track = await searchSpotifyTrack(session, query);
    items.push({
      videoId: v.videoId,
      youtubeTitle: v.title,
      youtubeLikedAt: v.likedAt || null,
      query,
      matched: Boolean(track),
      spotify: track
        ? {
          uri: track.uri,
          name: track.name,
          artists: track.artists.map((a) => a.name),
        }
        : null,
    });
  }

  const matchedCount = items.filter((x) => x.matched).length;

  const destinationSummary = options.destination === 'library'
    ? 'Spotify Liked Songs'
    : `Playlist (${options.playlistMode === 'existing' ? 'existing' : 'new'}): ${options.playlistMode === 'existing' ? (options.playlistId || 'unselected') : options.playlistName}`;

  return {
    destinationSummary,
    order: options.order,
    likedFetched: likedVideos.length,
    pendingCount: pending.length,
    syncCandidateCount: candidates.length,
    previewedCount: items.length,
    previewLimit: previewCount,
    matchedCount,
    unmatchedCount: items.length - matchedCount,
    hasMore: candidates.length > items.length,
    items,
  };
}

async function runSync(session, requestedOptions) {
  if (session.syncProgress?.inProgress) {
    throw new Error('A sync run is already in progress.');
  }

  const options = normalizeSyncOptions(requestedOptions, session.syncOptions);
  session.syncOptions = options;
  schedulePersistSessions();

  await refreshSpotifyIfNeeded(session);

  const { likedVideos, pending, candidates } = await buildSyncCandidates(session, options);
  const startedAt = new Date().toISOString();

  const matched = [];
  const unmatched = [];
  let destinationInfo = null;
  let playlistReorderResult = null;

  session.syncProgress = {
    inProgress: true,
    startedAt,
    finishedAt: null,
    total: candidates.length,
    processed: 0,
    remaining: candidates.length,
    addedCount: 0,
    unmatchedCount: 0,
    currentYoutubeTitle: null,
    currentSpotifyTrack: null,
    destination: options.destination,
    order: options.order,
    lastAction: 'Preparing batch',
    error: null,
  };

  try {
    if (options.destination === 'playlist') {
      destinationInfo = await getOrCreateTargetPlaylist(session, options);
      if (options.playlistMode === 'new' && destinationInfo.created) {
        session.syncOptions.activePlaylistId = destinationInfo.id;
        schedulePersistSessions();
      }
    }

    for (const v of candidates) {
      session.syncProgress.currentYoutubeTitle = v.title;
      session.syncProgress.currentSpotifyTrack = null;
      session.syncProgress.lastAction = 'Searching Spotify';

      const query = normalizeTitle(v.title);
      const track = await searchSpotifyTrack(session, query);
      if (!track) {
        unmatched.push(v.title);
        if (session.failedVideoIds.has(v.videoId)) {
          session.failedVideoIds.delete(v.videoId);
          session.skippedVideoIds.add(v.videoId);
        } else if (!session.skippedVideoIds.has(v.videoId)) {
          session.failedVideoIds.add(v.videoId);
        }
        session.syncProgress.processed += 1;
        session.syncProgress.remaining = Math.max(0, candidates.length - session.syncProgress.processed);
        session.syncProgress.unmatchedCount = unmatched.length;
        session.syncProgress.lastAction = 'No Spotify match found';
        continue;
      }

      session.failedVideoIds.delete(v.videoId);
      session.skippedVideoIds.delete(v.videoId);
      const spotifyLabel = `${track.name} - ${track.artists.map((a) => a.name).join(', ')}`;
      session.syncProgress.currentSpotifyTrack = spotifyLabel;

      if (options.destination === 'library') {
        session.syncProgress.lastAction = 'Saving to Spotify Liked Songs';
        await saveSpotifyTracks(session, [track.uri]);
      } else {
        session.syncProgress.lastAction = `Saving to playlist ${destinationInfo.name}`;
        await addPlaylistItems(session, destinationInfo.id, [track.uri]);
      }

      session.importedVideoIds.add(v.videoId);
      if (v.likedAt) {
        session.trackEvents[track.uri] = latestIsoTimestamp(session.trackEvents[track.uri], v.likedAt);
      }
      matched.push({ youtube: v.title, spotify: spotifyLabel, spotifyUri: track.uri, youtubeLikedAt: v.likedAt || null });

      session.syncProgress.processed += 1;
      session.syncProgress.remaining = Math.max(0, candidates.length - session.syncProgress.processed);
      session.syncProgress.addedCount = matched.length;
      session.syncProgress.lastAction = 'Saved';
    }

    if (options.destination === 'playlist' && options.playlistDateSort && destinationInfo) {
      session.syncProgress.lastAction = `Sorting playlist ${destinationInfo.name} by latest activity`;
      playlistReorderResult = await reorderPlaylistByUnifiedDate(session, destinationInfo.id);
    }

    session.lastRun = new Date().toISOString();
    session.lastRunResult = {
      added: matched,
      unmatched,
      scanned: candidates.length,
      pendingBeforeRun: pending.length,
      likedFetched: likedVideos.length,
      processLimit: syncProcessLimit || 'unlimited',
      destination: options.destination,
      order: options.order,
      playlistDateSort: Boolean(options.playlistDateSort),
      playlist: destinationInfo
        ? {
          id: destinationInfo.id,
          name: destinationInfo.name,
          appendOnly: true,
        }
        : null,
      reorderByDate: playlistReorderResult,
    };
    schedulePersistSessions();

    session.syncProgress.inProgress = false;
    session.syncProgress.finishedAt = session.lastRun;
    session.syncProgress.currentYoutubeTitle = null;
    session.syncProgress.currentSpotifyTrack = null;
    session.syncProgress.lastAction = 'Completed';

    return session.lastRunResult;
  } catch (err) {
    session.lastRun = new Date().toISOString();
    session.lastRunResult = { error: err.message };
    schedulePersistSessions();

    if (session.syncProgress?.inProgress) {
      session.syncProgress.inProgress = false;
      session.syncProgress.finishedAt = session.lastRun;
      session.syncProgress.error = err.message;
      session.syncProgress.lastAction = 'Failed';
      session.syncProgress.currentYoutubeTitle = null;
      session.syncProgress.currentSpotifyTrack = null;
    }
    throw err;
  }
}

app.get('/spotify/playlists', async (req, res) => {
  const { session } = getOrCreateSession(req, res);
  if (!session.spotify) return res.status(400).json({ error: 'Connect Spotify first.' });
  try {
    await refreshSpotifyIfNeeded(session);
    const playlists = await listSpotifyPlaylists(session);
    res.json({
      items: playlists.map((p) => ({
        id: p.id,
        name: p.name,
        tracksTotal: p?.tracks?.total ?? 0,
        owner: p?.owner?.display_name || p?.owner?.id || '',
        isPublic: Boolean(p.public),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sync/preview', async (req, res) => {
  const { session } = getOrCreateSession(req, res);
  if (!session.youtube || !session.spotify) return res.status(400).json({ error: 'Connect YouTube and Spotify first.' });

  try {
    const options = normalizeSyncOptions(req.body?.options, session.syncOptions);
    session.syncOptions = options;
    const preview = await buildPreview(session, options, req.body?.previewLimit);
    session.preview = { createdAt: new Date().toISOString(), ...preview };
    schedulePersistSessions();
    res.json({ ok: true, preview: session.preview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sync/run', async (req, res) => {
  const { session } = getOrCreateSession(req, res);
  if (!session.youtube || !session.spotify) return res.status(400).json({ error: 'Connect YouTube and Spotify first.' });
  try {
    const result = await runSync(session, req.body?.options);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sync/start', (req, res) => {
  const { sid, session } = getOrCreateSession(req, res);
  if (!session.youtube || !session.spotify) return res.status(400).json({ error: 'Connect YouTube and Spotify first.' });
  if (syncTimers.has(sid)) return res.json({ ok: true, running: true });

  const options = normalizeSyncOptions(req.body?.options, session.syncOptions);
  session.autoSyncOptions = options;
  session.syncOptions = options;
  schedulePersistSessions();

  const timer = setInterval(async () => {
    if (session.syncProgress?.inProgress) return;
    try {
      await runSync(session, session.autoSyncOptions);
    } catch (e) {
      session.lastRunResult = { error: e.message };
      session.lastRun = new Date().toISOString();
    }
  }, syncIntervalMs);

  syncTimers.set(sid, timer);
  res.json({ ok: true, running: true, intervalSeconds: syncIntervalMs / 1000 });
});

app.post('/sync/stop', (req, res) => {
  const { sid } = getOrCreateSession(req, res);
  const timer = syncTimers.get(sid);
  if (timer) {
    clearInterval(timer);
    syncTimers.delete(sid);
  }
  res.json({ ok: true, running: false });
});

app.get('/status', (req, res) => {
  const { sid, session } = getOrCreateSession(req, res);
  res.json({
    youtubeConnected: Boolean(session.youtube),
    spotifyConnected: Boolean(session.spotify),
    syncRunning: syncTimers.has(sid),
    intervalSeconds: syncIntervalMs / 1000,
    lastRun: session.lastRun,
    lastRunResult: session.lastRunResult,
    syncProgress: session.syncProgress,
    syncOptions: session.syncOptions,
    preview: session.preview,
  });
});

if (httpsEnabled) {
  const pfxPath = process.env.HTTPS_PFX_PATH;
  const pfxPassphrase = process.env.HTTPS_PFX_PASSPHRASE;
  const keyPath = process.env.HTTPS_KEY_PATH;
  const certPath = process.env.HTTPS_CERT_PATH;
  let tlsOptions;

  if (pfxPath) {
    tlsOptions = {
      pfx: fs.readFileSync(path.resolve(pfxPath)),
      passphrase: pfxPassphrase,
    };
  } else {
    if (!keyPath || !certPath) {
      throw new Error('HTTPS is enabled, but no certificate files were configured. Set HTTPS_PFX_PATH or HTTPS_KEY_PATH/HTTPS_CERT_PATH.');
    }
    tlsOptions = {
      key: fs.readFileSync(path.resolve(keyPath)),
      cert: fs.readFileSync(path.resolve(certPath)),
    };
    if (process.env.HTTPS_CA_PATH) {
      tlsOptions.ca = fs.readFileSync(path.resolve(process.env.HTTPS_CA_PATH));
    }
  }

  https.createServer(tlsOptions, app).listen(port, () => {
    console.log(`YT <-> Spotify sync app on ${baseUrl}`);
  });
} else {
  http.createServer(app).listen(port, () => {
    console.log(`YT <-> Spotify sync app on ${baseUrl}`);
  });
}
