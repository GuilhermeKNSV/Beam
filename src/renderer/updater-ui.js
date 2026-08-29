// Beam in-app update checker UI.
import { state } from './state.js';
import { $, el, toast } from './util.js';

let checking = false;
let downloading = false;

export function init() {
  const btnHome = document.getElementById('btn-update-home');
  const btnRoom = document.getElementById('btn-update-room');
  if (btnHome) btnHome.addEventListener('click', checkAndPrompt);
  if (btnRoom) btnRoom.addEventListener('click', checkAndPrompt);
}

async function checkAndPrompt() {
  if (checking || downloading) return;
  checking = true;
  toast('Checking for updates...', 'info');

  try {
    const result = await window.beam.checkUpdate();
    checking = false;

    if (result.error) {
      toast('Update check failed: ' + result.error, 'error');
      return;
    }

    if (!result.hasUpdate) {
      toast('You are on the latest version (' + (result.latestVersion || state.appInfo?.version || '?') + ')', 'success');
      return;
    }

    showUpdateModal(result);
  } catch (err) {
    checking = false;
    toast('Update check failed', 'error');
  }
}

function showUpdateModal(info) {
  const old = document.getElementById('update-modal');
  if (old) old.remove();

  const items = [
    el('h3', {}, 'Update Available'),
    el('p', { class: 'update-version' },
      'v' + (info.latestVersion || '?') + ' (you have v' + (info.currentVersion || '?') + ')'),
  ];

  if (info.changelog) {
    items.push(el('pre', { class: 'update-changelog' }, info.changelog));
  }

  items.push(
    el('div', { class: 'update-actions' },
      el('button', { class: 'btn primary', id: 'update-download-btn' }, 'Download & Restart'),
      el('button', { class: 'btn', id: 'update-later-btn' }, 'Later')),
    el('div', { class: 'update-progress hidden', id: 'update-progress' },
      el('div', { class: 'meter' }, el('div', { class: 'meter-fill', id: 'update-progress-fill' }))),
    el('p', { class: 'update-status hidden', id: 'update-status' })
  );

  const modal = el('div', { id: 'update-modal', class: 'update-modal' },
    el('div', { class: 'update-modal-card' }, ...items));

  document.body.appendChild(modal);

  document.getElementById('update-later-btn').addEventListener('click', () => modal.remove());
  document.getElementById('update-download-btn').addEventListener('click', () => {
    doUpdate(info.downloadUrl, modal);
  });
}

async function doUpdate(downloadUrl, modal) {
  if (!downloadUrl) {
    toast('No download URL found', 'error');
    return;
  }
  downloading = true;
  const dlBtn = document.getElementById('update-download-btn');
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
    const result = await window.beam.downloadUpdate(downloadUrl);

    if (result.error) {
      if (status) status.textContent = 'Download failed: ' + result.error;
      toast('Download failed: ' + result.error, 'error');
      downloading = false;
      return;
    }

    if (status) status.textContent = 'Download complete! Restarting...';
    toast('Update downloaded. Restarting...', 'success');

    const { spawn } = await import('child_process');
    spawn(result.exePath, [], { detached: true, stdio: 'ignore' }).unref();
    window.close();
  } catch (err) {
    if (status) status.textContent = 'Failed: ' + err.message;
    toast('Update failed', 'error');
    downloading = false;
  }
}
