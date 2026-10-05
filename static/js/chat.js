// Chat.js

// Contants and Helpers

const MOBILE_BP = 768;
const LS_KEY = 'tripswarm_sidebar_collapsed';
const isMobile = () => window.innerWidth <= MOBILE_BP;

//  Sidebar Toggle
// Restore saved state immediately (before paint) 
(function () {
  if (!isMobile() && localStorage.getItem(LS_KEY) === '1') {
    document.getElementById('app-shell').classList.add('sidebar-collapsed');
  }
})();

function toggleSidebar() {
  isMobile() ? _toggleMobile() : _toggleDesktop();
}
function _toggleDesktop() {
  const shell = document.getElementById('app-shell');
  const isCollapsing = !shell.classList.contains('sidebar-collapsed');
  shell.classList.toggle('sidebar-collapsed');
  localStorage.setItem(LS_KEY, isCollapsing ? '1' : '0');
  /* Close flyout when expanding */
  if (!isCollapsing) closeFlyout();
}
function _toggleMobile() { document.getElementById('app-shell').classList.toggle('sidebar-open'); }
function closeMobileSidebar() { document.getElementById('app-shell').classList.remove('sidebar-open'); }

window.addEventListener('resize', () => {
  const shell = document.getElementById('app-shell');
  if (isMobile()) {
    shell.classList.remove('sidebar-collapsed');
    closeFlyout();
  } else {
    shell.classList.remove('sidebar-open');
    if (localStorage.getItem(LS_KEY) === '1') shell.classList.add('sidebar-collapsed');
  }
});

/* Logo click in mini = expand sidebar */
document.getElementById('brand-link').addEventListener('click', e => {
  if (!isMobile() && document.getElementById('app-shell').classList.contains('sidebar-collapsed')) {
    e.preventDefault();
    _toggleDesktop();
  }
});

//  Recents Flyout
const flyoutEl = document.getElementById('recents-flyout');
const triggerEl = document.getElementById('mini-recents-trigger');
const closeBtn = document.getElementById('flyout-close-btn');

let flyoutOpen = false;
let closeTimer = null;
let _flyoutPopulated = false;

function openFlyout() {
  if (flyoutOpen) return;
  flyoutOpen = true;
  populateFlyout();
  /* Position: fixed, left = sidebar mini width */
  flyoutEl.style.left = 'var(--sidebar-mini)';
  flyoutEl.classList.add('open');
}

function closeFlyout() {
  if (!flyoutOpen) return;
  flyoutOpen = false;
  flyoutEl.classList.remove('open');
}

function scheduleClose(delay = 120) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(closeFlyout, delay);
}
function cancelClose() { clearTimeout(closeTimer); }

/* Trigger: hover the clock icon */
triggerEl.addEventListener('mouseenter', () => {
  cancelClose();
  if (document.getElementById('app-shell').classList.contains('sidebar-collapsed')) {
    openFlyout();
  }
});
triggerEl.addEventListener('mouseleave', () => scheduleClose(200));

/* Keep open while hovering the flyout itself */
flyoutEl.addEventListener('mouseenter', cancelClose);
flyoutEl.addEventListener('mouseleave', () => scheduleClose(200));

/* Close button */
closeBtn.addEventListener('click', closeFlyout);

/* Click outside closes flyout */
document.addEventListener('click', e => {
  if (flyoutOpen && !flyoutEl.contains(e.target) && !triggerEl.contains(e.target)) {
    closeFlyout();
  }
});

/* ── Build flyout content from the sidebar's thread items ── */
function populateFlyout() {
  const listEl = document.getElementById('flyout-list');
  /* Collect thread items from the main sidebar thread list */
  const items = document.querySelectorAll('#thread-list .thread-item');

  if (!items.length) {
    listEl.innerHTML = `
      <div class="flyout-empty">
        <i class="bi bi-chat-dots"></i>
        <span>No recent chats</span>
      </div>`;
    return;
  }

  listEl.innerHTML = '';
  items.forEach(item => {
    const threadId = item.dataset.threadId || item.dataset.id || '';
    const threadType = item.dataset.type || 'travel';
    const isRag = threadType === 'rag';

    /* Read name from .thread-name or first meaningful text node */
    const nameEl = item.querySelector('.thread-name') || item.querySelector('.thread-title');
    const title = nameEl ? nameEl.textContent.trim() : 'Untitled';

    /* Read time */
    const timeEl = item.querySelector('.thread-time');
    const time = timeEl ? timeEl.textContent.trim() : '';

    const row = document.createElement('div');
    row.className = 'flyout-item' + (item.classList.contains('active') ? ' active' : '');
    row.dataset.threadId = threadId;
    row.innerHTML = `
      <div class="flyout-icon ${isRag ? 'flyout-icon-rag' : 'flyout-icon-travel'}">
        <i class="bi ${isRag ? 'bi-chat-square-dots-fill' : 'bi-airplane-fill'}"></i>
      </div>
      <div class="flyout-meta">
        <div class="flyout-name">${escHtml(title)}</div>
        ${time ? `<div class="flyout-time">${escHtml(time)}</div>` : ''}
      </div>
      <button class="flyout-rename-btn" title="Rename chat" onclick="event.stopPropagation(); openRenameFromFlyout('${threadId}', this)">
        <i class="bi bi-pencil"></i>
      </button>`;

    /* Click row = open that thread (mirrors sidebar item click) */
    row.addEventListener('click', () => {
      item.click();   /* delegate to the real sidebar item */
      closeFlyout();
    });

    listEl.appendChild(row);
  });
}

/* Re-populate whenever flyout is already open and DOM changes */
const flyoutObserver = new MutationObserver(() => {
  if (flyoutOpen) populateFlyout();
});
flyoutObserver.observe(document.getElementById('thread-list'), { childList: true, subtree: true });

/* Rename from flyout row */
function openRenameFromFlyout(threadId, renameBtn) {
  /* Find the real sidebar item and delegate */
  const item = document.querySelector(`#thread-list .thread-item[data-thread-id="${threadId}"]`);
  const nameEl = item ? item.querySelector('.thread-name') : null;
  openRenameModal(threadId, nameEl, null);
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


window.addEventListener('popstate', () => {
  const mode = new URLSearchParams(window.location.search).get('mode') || 'travel';
  switchTab(mode, null);
});

document.addEventListener('DOMContentLoaded', () => {
  marked.setOptions({ breaks: true, gfm: true });

  // Handle ?q= pre-fill only — tab switching is owned by app.js loadThreads()
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') || 'travel';
  const q = params.get('q') || '';

  if (q) {
    const inputId = mode === 'rag' ? 'rag-input' : 'travel-input';
    const sendFn = mode === 'rag' ? sendRag : sendTravel;
    const input = document.getElementById(inputId);
    if (input) { input.value = q; autoGrow(input); }
    setTimeout(sendFn, 800);
  }
});

//  IST Timestamp Formatter
function formatIST(utcString) {
  if (!utcString) return '';
  const raw = utcString.endsWith('Z') ? utcString : utcString + 'Z';
  const date = new Date(raw);
  const IST_MS = 5.5 * 3600000;
  const ist = new Date(date.getTime() + IST_MS);
  const nowIST = new Date(Date.now() + IST_MS);
  const todayMid = new Date(nowIST); todayMid.setUTCHours(0, 0, 0, 0);
  const yestMid = new Date(todayMid.getTime() - 86400000);
  const hh = ist.getUTCHours(), mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const ampm = hh >= 12 ? 'PM' : 'AM', h12 = ((hh % 12) || 12);
  const time = `${h12}:${mm} ${ampm}`;
  if (ist >= todayMid) return `Today, ${time}`;
  if (ist >= yestMid) return `Yesterday, ${time}`;
  const day = ist.getUTCDate();
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][ist.getUTCMonth()];
  return `${day} ${month}, ${time}`;
}

// Thread Item Patcher
let _renameThreadId = null, _renameNameEl = null, _renameModal = null;

function _findTitleEl(item) {
  const byClass = item.querySelector('.thread-name,.thread-title,.chat-title,.item-title,[data-title]');
  if (byClass) return byClass;
  for (const el of item.querySelectorAll('span,div,p,a')) {
    if (el.querySelector('button,i,svg')) continue;
    const t = el.textContent.trim();
    if (t.length > 0 && t.length < 120) return el;
  }
  return null;
}

function openRenameModal(threadId, nameEl, event) {
  if (event) event.stopPropagation();
  _renameThreadId = threadId;
  _renameNameEl = nameEl;
  document.getElementById('rename-input').value = nameEl ? nameEl.textContent.trim() : '';
  if (!_renameModal) _renameModal = new bootstrap.Modal(document.getElementById('renameModal'));
  _renameModal.show();
  setTimeout(() => document.getElementById('rename-input').select(), 300);
}

async function confirmRename() {
  const newTitle = document.getElementById('rename-input').value.trim();
  if (!newTitle || !_renameThreadId) return;
  try {
    const res = await fetch(`/api/threads/${_renameThreadId}/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle }),
    });
    if (!res.ok) throw new Error('Rename failed');

    /* Update sidebar item name */
    if (_renameNameEl) _renameNameEl.textContent = newTitle;
    [
      `.thread-item[data-thread-id="${_renameThreadId}"] .thread-name`,
      `.thread-item[data-thread-id="${_renameThreadId}"] .thread-title`,
      `.thread-item[data-thread-id="${_renameThreadId}"] .thread-label`,
    ].forEach(sel => {
      const el = document.querySelector(sel);
      if (el && el !== _renameNameEl) el.textContent = newTitle;
    });

    /* Update App.threads cache */
    const t = App.threads.find(t => t.id == _renameThreadId);
    if (t) t.title = newTitle;

    /* Update flyout row if open */
    if (flyoutOpen) populateFlyout();

    _renameModal.hide();
  } catch (err) { alert('Could not rename chat. Please try again.'); }
}

document.addEventListener('DOMContentLoaded', () => {
  const threadList = document.getElementById('thread-list');
  if (!threadList) return;

  function patchThreadItems() {
    threadList.querySelectorAll('.thread-item:not([data-patched])').forEach(item => {
      item.setAttribute('data-patched', '1');

      const threadId = item.dataset.threadId || item.dataset.id || '';
      const threadType = item.dataset.type || 'travel';
      const isRag = threadType === 'rag';
      const nameEl = _findTitleEl(item);

      /* ── Wrap name + time into .thread-meta ── */
      if (!item.querySelector('.thread-meta') && nameEl) {
        const meta = document.createElement('div');
        meta.className = 'thread-meta';

        if (nameEl.parentElement === item) item.removeChild(nameEl);
        nameEl.className = 'thread-name';
        meta.appendChild(nameEl);

        const timeEl = item.querySelector('.thread-time,[data-time],time,small');
        if (timeEl) {
          timeEl.className = 'thread-time';
          const raw = timeEl.dataset.utc || timeEl.getAttribute('datetime') || timeEl.textContent.trim();
          if (raw) timeEl.textContent = formatIST(raw);
          if (timeEl.parentElement === item) item.removeChild(timeEl);
          meta.appendChild(timeEl);
        }
        item.appendChild(meta);
      }

      /* ── Type icon (prepend) ── */
      if (!item.querySelector('.thread-icon')) {
        const iconEl = document.createElement('div');
        iconEl.className = `thread-icon ${isRag ? 'thread-icon-rag' : 'thread-icon-travel'}`;
        iconEl.innerHTML = `<i class="bi ${isRag ? 'bi-chat-square-dots-fill' : 'bi-airplane-fill'}"></i>`;
        item.insertBefore(iconEl, item.firstChild);
      }

      /* ── Rename button ── */
      if (!item.querySelector('.thread-rename-btn')) {
        const btn = document.createElement('button');
        btn.className = 'thread-rename-btn';
        btn.title = 'Rename chat';
        btn.innerHTML = '<i class="bi bi-pencil"></i>';
        btn.onclick = e => openRenameModal(threadId, item.querySelector('.thread-name'), e);
        item.appendChild(btn);
      }
    });
  }

  patchThreadItems();
  new MutationObserver(patchThreadItems).observe(threadList, { childList: true, subtree: true });
}, { once: false });