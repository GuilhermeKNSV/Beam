// Beam renderer utilities — DOM helpers, toasts, context menus, formatting.

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (value !== false && value != null) {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

let uidCounter = 0;
export function uid(prefix = 'id') {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

export function debounce(fn, ms = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

let toastContainer = null;
function ensureToastContainer() {
  if (!toastContainer) {
    toastContainer = document.getElementById('toasts') || el('div', { id: 'toasts', class: 'toasts' });
    if (!document.body.contains(toastContainer)) document.body.append(toastContainer);
  }
  return toastContainer;
}

export function toast(message, kind = 'info', duration = 4000) {
  const container = ensureToastContainer();
  const node = el('div', { class: `toast toast-${kind}`, role: 'status' }, message);
  container.append(node);
  setTimeout(() => {
    node.classList.add('toast-leave');
    setTimeout(() => node.remove(), 300);
  }, duration);
  return node;
}

let contextMenuEl = null;
export function closeContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

/**
 * Show a context menu at (x, y). Items:
 *   { type:'item', label, action, disabled }
 *   { type:'separator' }
 *   { type:'slider', label, min, max, step, value, oninput, suffix }
 *   { type:'toggle', label, checked, action }
 */
export function showContextMenu(x, y, items) {
  closeContextMenu();
  contextMenuEl = el('div', { class: 'context-menu' });
  for (const item of items) {
    if (item.type === 'separator') {
      contextMenuEl.append(el('div', { class: 'context-sep' }));
      continue;
    }
    if (item.type === 'slider') {
      const row = el('div', { class: 'context-slider' });
      const label = el('span', { class: 'context-slider-label' }, item.label);
      const input = el('input', {
        type: 'range',
        min: item.min,
        max: item.max,
        step: item.step || 1,
        value: item.value,
      });
      input.addEventListener('input', () => {
        item.oninput && item.oninput(Number(input.value));
      });
      row.append(label, input);
      contextMenuEl.append(row);
      continue;
    }
    const isToggle = item.type === 'toggle';
    const row = el(
      'div',
      {
        class: `context-item${item.disabled ? ' disabled' : ''}`,
        onclick: item.disabled ? undefined : () => {
          closeContextMenu();
          item.action && item.action();
        },
      },
      el('span', { class: 'context-label' }, item.label),
      isToggle
        ? el('span', { class: 'context-check' }, item.checked ? '✓' : '')
        : null
    );
    contextMenuEl.append(row);
  }

  // Keep within viewport.
  contextMenuEl.style.left = '0px';
  contextMenuEl.style.top = '0px';
  document.body.append(contextMenuEl);
  const rect = contextMenuEl.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  contextMenuEl.style.left = `${Math.max(8, left)}px`;
  contextMenuEl.style.top = `${Math.max(8, top)}px`;

  const onDocDown = (e) => {
    if (!contextMenuEl || !contextMenuEl.contains(e.target)) closeContextMenu();
  };
  document.addEventListener('mousedown', onDocDown, { once: true, capture: true });
  return contextMenuEl;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
