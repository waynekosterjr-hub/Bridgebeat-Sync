const statusEl = document.getElementById('status');
const liveTransferTitleEl = document.getElementById('liveTransferTitle');
const liveTransferMetaEl = document.getElementById('liveTransferMeta');
const autoSyncStateEl = document.getElementById('autoSyncState');
const destinationSelectEl = document.getElementById('destinationSelect');
const orderSelectEl = document.getElementById('orderSelect');
const playlistSettingsEl = document.getElementById('playlistSettings');
const existingPlaylistGroupEl = document.getElementById('existingPlaylistGroup');
const newPlaylistGroupEl = document.getElementById('newPlaylistGroup');
const playlistSelectEl = document.getElementById('playlistSelect');
const newPlaylistNameEl = document.getElementById('newPlaylistName');
const newPlaylistPublicEl = document.getElementById('newPlaylistPublic');
const playlistDateSortEl = document.getElementById('playlistDateSort');
const previewMetaEl = document.getElementById('previewMeta');
const previewListEl = document.getElementById('previewList');
const statusFeedWrapEl = document.getElementById('statusFeedWrap');
const toggleStatusFeedEl = document.getElementById('toggleStatusFeed');
const connectYoutubeBtnEl = document.getElementById('connectYoutube');
const connectSpotifyBtnEl = document.getElementById('connectSpotify');
const youtubeStatusBadgeEl = document.getElementById('youtubeStatusBadge');
const spotifyStatusBadgeEl = document.getElementById('spotifyStatusBadge');
const logoutYoutubeBtnEl = document.getElementById('logoutYoutube');
const logoutSpotifyBtnEl = document.getElementById('logoutSpotify');
const logoutAllBtnEl = document.getElementById('logoutAll');
const settingsPanelEl = document.getElementById('settingsPanel');
const toggleSettingsPanelEl = document.getElementById('toggleSettingsPanel');
const closeSettingsPanelEl = document.getElementById('closeSettingsPanel');

let statusPollHandle = null;
let pollIntervalMs = 5000;
let statusInitialized = false;
let playlistsLoaded = false;
const inflightActions = new Set();

function getPlaylistMode() {
  const selected = document.querySelector('input[name="playlistMode"]:checked');
  return selected ? selected.value : 'existing';
}

function applySettingsVisibility() {
  const destination = destinationSelectEl.value;
  const playlistMode = getPlaylistMode();
  const isPlaylist = destination === 'playlist';
  playlistSettingsEl.hidden = !isPlaylist;
  existingPlaylistGroupEl.hidden = !isPlaylist || playlistMode !== 'existing';
  newPlaylistGroupEl.hidden = !isPlaylist || playlistMode !== 'new';
}

function getSyncOptions() {
  const destination = destinationSelectEl.value;
  const options = {
    destination,
    order: orderSelectEl.value,
  };

  if (destination === 'playlist') {
    const mode = getPlaylistMode();
    options.playlistMode = mode;
    options.playlistDateSort = playlistDateSortEl.checked;
    if (mode === 'existing') {
      options.playlistId = playlistSelectEl.value;
      options.playlistName = playlistSelectEl.options[playlistSelectEl.selectedIndex]?.text || '';
    } else {
      options.playlistName = (newPlaylistNameEl.value || '').trim() || 'Bridgebeat Sync';
      options.playlistPublic = newPlaylistPublicEl.checked;
    }
  }

  return options;
}

function applyOptionsToForm(options) {
  if (!options) return;
  destinationSelectEl.value = options.destination || 'library';
  orderSelectEl.value = options.order || 'newest';

  if (options.destination === 'playlist') {
    const mode = options.playlistMode === 'new' ? 'new' : 'existing';
    const radio = document.querySelector(`input[name="playlistMode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    playlistDateSortEl.checked = Boolean(options.playlistDateSort);

    if (options.playlistName) {
      newPlaylistNameEl.value = options.playlistName;
    }
    newPlaylistPublicEl.checked = Boolean(options.playlistPublic);

    if (options.playlistId) {
      const hasOption = Array.from(playlistSelectEl.options).some((opt) => opt.value === options.playlistId);
      if (hasOption) {
        playlistSelectEl.value = options.playlistId;
      }
    }
  }

  if (options.destination !== 'playlist') {
    playlistDateSortEl.checked = false;
  }

  applySettingsVisibility();
}

function renderPreview(preview) {
  if (!preview) {
    previewMetaEl.textContent = 'Run preview to see what will transfer.';
    previewListEl.innerHTML = '';
    return;
  }

  previewMetaEl.textContent = `Destination: ${preview.destinationSummary}. Showing ${preview.previewedCount} of ${preview.syncCandidateCount} candidates. Matched ${preview.matchedCount}, unmatched ${preview.unmatchedCount}.`;
  previewListEl.innerHTML = '';

  for (const item of preview.items) {
    const li = document.createElement('li');
    li.className = `preview-item ${item.matched ? 'matched' : 'unmatched'}`;

    const yt = document.createElement('div');
    yt.className = 'yt';
    yt.textContent = item.youtubeTitle;
    li.appendChild(yt);

    const sp = document.createElement('div');
    sp.className = 'sp';
    if (item.matched && item.spotify) {
      sp.textContent = `Will transfer as: ${item.spotify.name} - ${item.spotify.artists.join(', ')}`;
    } else {
      sp.textContent = 'No Spotify match yet';
    }
    li.appendChild(sp);

    previewListEl.appendChild(li);
  }
}

function updateConnectionUi(data) {
  const ytConnected = Boolean(data.youtubeConnected);
  const spConnected = Boolean(data.spotifyConnected);

  connectYoutubeBtnEl.classList.toggle('connected', ytConnected);
  connectSpotifyBtnEl.classList.toggle('connected', spConnected);

  connectYoutubeBtnEl.textContent = ytConnected ? 'YouTube Connected ✓' : 'Connect YouTube';
  connectSpotifyBtnEl.textContent = spConnected ? 'Spotify Connected ✓' : 'Connect Spotify';

  youtubeStatusBadgeEl.textContent = ytConnected ? 'YouTube: Connected' : 'YouTube: Not connected';
  spotifyStatusBadgeEl.textContent = spConnected ? 'Spotify: Connected' : 'Spotify: Not connected';

  youtubeStatusBadgeEl.classList.toggle('connected', ytConnected);
  spotifyStatusBadgeEl.classList.toggle('connected', spConnected);

  logoutYoutubeBtnEl.disabled = !ytConnected;
  logoutSpotifyBtnEl.disabled = !spConnected;
  logoutAllBtnEl.disabled = !ytConnected && !spConnected;
}

function setSettingsPanelOpen(open) {
  settingsPanelEl.classList.toggle('open', open);
  settingsPanelEl.setAttribute('aria-hidden', open ? 'false' : 'true');
  toggleSettingsPanelEl.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function updateLiveFooter(data) {
  const progress = data.syncProgress;
  if (!progress) {
    liveTransferTitleEl.textContent = 'Live transfer: idle';
    liveTransferMetaEl.textContent = 'Waiting for sync run.';
    return;
  }

  if (progress.inProgress) {
    const current = progress.currentYoutubeTitle || 'Preparing transfer';
    const spotify = progress.currentSpotifyTrack ? ` -> ${progress.currentSpotifyTrack}` : '';
    liveTransferTitleEl.textContent = `Live transfer: ${current}${spotify}`;
    liveTransferMetaEl.textContent = `${progress.lastAction}. Processed ${progress.processed}/${progress.total}. Remaining ${progress.remaining}. Added ${progress.addedCount}. Unmatched ${progress.unmatchedCount}.`;
    return;
  }

  if (progress.error) {
    liveTransferTitleEl.textContent = 'Live transfer: failed';
    liveTransferMetaEl.textContent = `${progress.error}`;
    return;
  }

  liveTransferTitleEl.textContent = 'Live transfer: completed';
  liveTransferMetaEl.textContent = `Processed ${progress.processed}/${progress.total}. Added ${progress.addedCount}. Unmatched ${progress.unmatchedCount}.`;
}

function setStatusFeedExpanded(expanded) {
  statusFeedWrapEl.classList.toggle('collapsed', !expanded);
  toggleStatusFeedEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  const label = toggleStatusFeedEl.querySelector('span:last-child');
  if (label) label.textContent = expanded ? 'Hide' : 'Show';
}

function setPollingInterval(ms) {
  if (pollIntervalMs === ms && statusPollHandle) return;
  pollIntervalMs = ms;
  if (statusPollHandle) clearInterval(statusPollHandle);
  statusPollHandle = setInterval(refreshStatus, pollIntervalMs);
}

async function withButtonLoading(button, action) {
  if (button) {
    button.classList.add('loading');
    button.disabled = true;
  }
  try {
    return await action();
  } finally {
    if (button) {
      button.classList.remove('loading');
      button.disabled = false;
    }
  }
}

async function runAction(key, button, action) {
  if (inflightActions.has(key)) return;
  inflightActions.add(key);
  try {
    await withButtonLoading(button, action);
  } finally {
    inflightActions.delete(key);
  }
}

async function fetchJson(path, init = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

async function refreshStatus() {
  try {
    const data = await fetch('/status').then((r) => r.json());
    statusEl.textContent = JSON.stringify(data, null, 2);
    updateConnectionUi(data);
    updateLiveFooter(data);
    autoSyncStateEl.textContent = data.syncRunning ? 'Auto-sync: ON' : 'Auto-sync: OFF';
    setPollingInterval(data?.syncProgress?.inProgress ? 1000 : 5000);

    if (!statusInitialized && data.syncOptions) {
      applyOptionsToForm(data.syncOptions);
      statusInitialized = true;
    }

    if (data.preview) {
      renderPreview(data.preview);
    }

    if (data.spotifyConnected && !playlistsLoaded) {
      await loadPlaylists();
    }
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

function openAuthPopup(path) {
  const width = 560;
  const height = 700;
  const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
  const features = `width=${width},height=${height},left=${Math.floor(left)},top=${Math.floor(top)},resizable=yes,scrollbars=yes`;
  const popup = window.open(`${path}?popup=1`, 'oauth_popup', features);
  if (!popup) {
    alert('Popup was blocked. Please allow popups and try again.');
  }
}

async function postAction(path, payload) {
  try {
    await fetchJson(path, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
    await refreshStatus();
  } catch (error) {
    alert(error.message);
  }
}

async function loadPlaylists() {
  try {
    const currentSelected = playlistSelectEl.value;
    const data = await fetchJson('/spotify/playlists');
    playlistSelectEl.innerHTML = '';

    for (const p of data.items) {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = `${p.name} (${p.tracksTotal})`;
      playlistSelectEl.appendChild(option);
    }

    if (currentSelected && Array.from(playlistSelectEl.options).some((x) => x.value === currentSelected)) {
      playlistSelectEl.value = currentSelected;
    }

    playlistsLoaded = true;
  } catch (error) {
    playlistsLoaded = false;
    playlistSelectEl.innerHTML = '';
    alert(error.message);
  }
}

async function runPreview() {
  try {
    const data = await fetchJson('/sync/preview', {
      method: 'POST',
      body: JSON.stringify({ options: getSyncOptions() }),
    });
    renderPreview(data.preview);
    await refreshStatus();
  } catch (error) {
    alert(error.message);
  }
}

window.addEventListener('message', async (event) => {
  if (event.origin !== window.location.origin) return;
  const msg = event.data || {};
  if (msg.type !== 'oauth_result') return;
  const providerLabel = msg.provider === 'youtube' ? 'YouTube' : 'Spotify';
  alert(msg.ok ? `${providerLabel} connected.` : msg.message || `${providerLabel} authentication failed.`);
  if (msg.ok && msg.provider === 'spotify') {
    await loadPlaylists();
  }
  await refreshStatus();
});

destinationSelectEl.addEventListener('change', applySettingsVisibility);
Array.from(document.querySelectorAll('input[name="playlistMode"]')).forEach((el) => {
  el.addEventListener('change', applySettingsVisibility);
});

document.getElementById('refreshPlaylists').addEventListener('click', (event) =>
  runAction('refreshPlaylists', event.currentTarget, loadPlaylists)
);
document.getElementById('connectYoutube').addEventListener('click', (event) =>
  runAction('connectYoutube', event.currentTarget, async () => {
    openAuthPopup('/auth/youtube/start');
    await new Promise((resolve) => setTimeout(resolve, 500));
  })
);
document.getElementById('connectSpotify').addEventListener('click', (event) =>
  runAction('connectSpotify', event.currentTarget, async () => {
    openAuthPopup('/auth/spotify/start');
    await new Promise((resolve) => setTimeout(resolve, 500));
  })
);
document.getElementById('previewSync').addEventListener('click', (event) =>
  runAction('previewSync', event.currentTarget, runPreview)
);
document.getElementById('runOnce').addEventListener('click', (event) =>
  runAction('runOnce', event.currentTarget, () => postAction('/sync/run', { options: getSyncOptions() }))
);
document.getElementById('start').addEventListener('click', (event) =>
  runAction('startSync', event.currentTarget, () => postAction('/sync/start', { options: getSyncOptions() }))
);
document.getElementById('stop').addEventListener('click', (event) =>
  runAction('stopSync', event.currentTarget, () => postAction('/sync/stop', {}))
);
logoutYoutubeBtnEl.addEventListener('click', async () => {
  await runAction('logoutYoutube', logoutYoutubeBtnEl, async () => {
    await postAction('/auth/logout/youtube', {});
    playlistsLoaded = false;
  });
});
logoutSpotifyBtnEl.addEventListener('click', async () => {
  await runAction('logoutSpotify', logoutSpotifyBtnEl, async () => {
    await postAction('/auth/logout/spotify', {});
    playlistsLoaded = false;
    playlistSelectEl.innerHTML = '';
  });
});
logoutAllBtnEl.addEventListener('click', async () => {
  await runAction('logoutAll', logoutAllBtnEl, async () => {
    await postAction('/auth/logout/all', {});
    playlistsLoaded = false;
    playlistSelectEl.innerHTML = '';
  });
});
toggleStatusFeedEl.addEventListener('click', () => {
  const expanded = toggleStatusFeedEl.getAttribute('aria-expanded') === 'true';
  setStatusFeedExpanded(!expanded);
});
toggleSettingsPanelEl.addEventListener('click', () => {
  const expanded = toggleSettingsPanelEl.getAttribute('aria-expanded') === 'true';
  setSettingsPanelOpen(!expanded);
});
closeSettingsPanelEl.addEventListener('click', () => setSettingsPanelOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setSettingsPanelOpen(false);
});

applySettingsVisibility();
setStatusFeedExpanded(false);
setSettingsPanelOpen(false);
refreshStatus();
setPollingInterval(5000);
