// Beam updater UI — auto-checks on launch, shows version badge.
import { state } from './state.js';
import { $, el, toast } from './util.js';

let updateInfo = null;
let downloading = false;

export function init() {
  showVersionBadge();
  // Auto-check on launch (don't block UI)
  setTimeout(checkForUpdate, 1500);
}

async function checkForUpdate() {
  if (downloading) return;
  try {
    const result = await window.beam.checkUpdate();
    if (result.error) {
      console.warn('[updater]', result.error);
      return;
    }
    updateInfo = result;
    updateBadge(result);
  } catch (err) {
    console.warn('[updater] check failed', err);
  }
}

function updateBadge(result) {
  const badges = document.querySelectorAll('.version-badge');
  badges.forEach((badge) => {
    if (result.hasUpdate) {
      badge.classList.add('has-update');
      badge.title = 'Update available: v' + (result.latestVersion || '?') + ' — click to update';
    } else {
      badge.classList.remove('has-update');
      badge.title = 'Beam v' + (result.currentVersion || '?') + ' (up to date)';
    }
  });
}

function showVersionBadge() {
  // Home view: insert badge if not exists
  const home = document.getElementById('view-home');
  if (home && !home.querySelector('.version-badge')) {
    const badge = el('div', { class: 'version-badge' }, '');
    badge.addEventListener('click', onBadgeClick);
    home.appendChild(badge);
  }
  // Room view: insert badge if not exists
  const room = document.getElementById('view-room');
  if (room && !room.querySelector('.version-badge')) {
    const badge = el('div', { class: 'version-badge' }, '');
    badge.addEventListener('click', onBadgeClick);
    room.querySelector('.room-shell')?.appendChild(badge);
  }
  // Populate text
  const ver = state.appInfo?.version || '?';
  document.querySelectorAll('.version-badge').forEach((b) => { b.textContent = 'v' + ver; });
}

async function onBadgeClick() {
  if (downloading) return;

  if (!updateInfo) {
    toast('Checking for updates...', 'info');
    await checkForUpdate();
  }

  if (!updateInfo || !updateInfo.hasUpdate) {
    toast('You are on the latest version', 'success');
    return;
  }

  showUpdateModal(updateInfo);
}

function showUpdateModal(info) {
  const old = document.getElementById('update-modal');
  if (old) old.remove();

  const modal = el('div', { id: 'update-modal', class: 'update-modal' },
    el('div', { class: 'update-modal-card' },
      el('h3', {}, 'Update Available'),
      el('p', { class: 'update-version' },
        'v' + (info.latestVersion || '?') + ' (you have v' + (info.currentVersion || '?') + ')'),
      info.changelog ? el('pre', { class: 'update-changelog' }, info.changelog) : null,
      el('div', { class: 'update-actions' },
        el('button', { class: 'btn primary', id: 'update-dl-btn' }, 'Download & Restart'),
        el('button', { class: 'btn', id: 'update-later-btn' }, 'Later')),
      el('div', { class: 'update-progress hidden', id: 'update-progress' },
        el('div', { class: 'meter' }, el('div', { class: 'meter-fill', id: 'update-progress-fill' }))),
      el('p', { class: 'update-status hidden', id: 'update-status' }))
  );

  document.body.appendChild(modal);

  document.getElementById('update-later-btn').addEventListener('click', () => modal.remove());
  document.getElementById('update-dl-btn').addEventListener('click', () => doUpdate(info, modal));
}

async function doUpdate(info, modal) {
  if (!info.downloadUrl) {
    toast('No download URL found', 'error');
    return;
  }
  downloading = true;

  const dlBtn = document.getElementById('update-dl-btn');
  const laterBtn = document.getElementById('update-later-btn');
  const progress = document.getElementById('update-progress');
  const fill = document.getElementById('update-progress-fill');
  const status = document.getElementById('update-status');

  if (dlBtn) dlBtn.disabled = true;
  if (laterBtn) laterBtn.style.display = 'none';
  if (progress) progress.classList.remove('hidden');
  if (status) { status.classList.remove('hidden'); status.textContent = 'Downloading...'; }

  window.beam.onUpdateProgress((data) => {
    if (fill) fill.style.width = data.pct + '%';
    if (status) status.textContent = 'Downloading... ' + data.pct + '%';
  });

  try {
    const result = await window.beam.downloadUpdate(info.downloadUrl);

    if (result.error) {
      if (status) status.textContent = 'Download failed: ' + result.error;
      toast('Download failed: ' + result.error, 'error');
      downloading = false;
      return;
    }

    if (status) status.textContent = 'Download complete! Restarting...';
    toast('Restarting with new version...', 'success');

    // Let main process spawn the new exe and quit
    await window.beam.applyUpdate(result.exePath);
  } catch (err) {
    if (status) status.textContent = 'Failed: ' + err.message;
    toast('Update failed', 'error');
    downloading = false;
  }
}
