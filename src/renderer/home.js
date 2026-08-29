// Beam home / host / enter screens.

import { state } from './state.js';
import { $, showView, toast } from './util.js';

let handlers = null;

function copy(text, label) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast(`${label} copied`, 'success'))
    .catch(() => toast('Copy failed', 'error'));
}

export function init(h) {
  handlers = h;
  $('#btn-host').addEventListener('click', showHostForm);
  $('#btn-enter').addEventListener('click', showEnterForm);
  $('#btn-settings-home').addEventListener('click', () => handlers.openSettings());
  $('#host-back').addEventListener('click', () => showView('home'));
  $('#enter-back').addEventListener('click', () => showView('home'));

  $('#host-start').addEventListener('click', async () => {
    const name = $('#host-name').value.trim() || 'Host';
    const roomName = $('#host-room').value.trim() || 'Beam Room';
    const password = $('#host-password').value;
    const port = Number($('#host-port').value) || 0;
    if (port !== 0 && (port < 1024 || port > 65535)) {
      toast('Port must be 1024–65535 (or 0 for automatic)', 'error');
      return;
    }
    $('#host-start').disabled = true;
    try {
      await handlers.onHost({ name, roomName, password, port });
    } catch (err) {
      toast(`Failed to start room: ${err.message}`, 'error');
    } finally {
      $('#host-start').disabled = false;
    }
  });

  $('#enter-join').addEventListener('click', async () => {
    const name = $('#enter-name').value.trim() || 'Guest';
    const address = $('#enter-address').value.trim();
    const roomCode = $('#enter-code').value.trim().toUpperCase();
    const password = $('#enter-password').value;
    if (!address) {
      toast('Enter a server address (host:port)', 'error');
      return;
    }
    if (!roomCode) {
      toast('Enter the room code', 'error');
      return;
    }
    $('#enter-join').disabled = true;
    try {
      await handlers.onEnter({ name, address, roomCode, password });
    } catch (err) {
      toast(`Could not join: ${err.message}`, 'error');
    } finally {
      $('#enter-join').disabled = false;
    }
  });
}

export function showHostForm() {
  $('#host-name').value = state.config?.displayName || state.selfName || '';
  $('#host-room').value = '';
  $('#host-password').value = '';
  $('#host-port').value = '5310';
  showView('host');
}

export function showEnterForm() {
  $('#enter-name').value = state.config?.displayName || state.selfName || '';
  $('#enter-address').value = '';
  $('#enter-code').value = '';
  $('#enter-password').value = '';
  showView('enter');
}
