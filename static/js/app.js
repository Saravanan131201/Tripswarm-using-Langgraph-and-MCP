//  TripSwarm — app.js 

const App = {
  currentTravelThreadId: null,
  currentRagThreadId: null,
  currentTab: 'travel',
  threads: [],
  sending: false,
  socketId: null,
};

// Web URLs registry (avoids JSON serialization in onclick attrs) 
const _webUrlsRegistry = new Map();
let _webUrlsRegistryCounter = 0;

// ── Socket.IO ────
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  App.socketId = socket.id;
});

socket.on('agent_progress', ({ status, detail }) => {
  _onAgentProgress(status, detail);
  if (status === 'agent_error') {
    const statusEl = document.getElementById('ts-agent-status');
    if (statusEl) statusEl.remove();
    const summaryWrapper = document.querySelector('#travel-messages .ts-summary-wrapper');
    if (summaryWrapper) {
      const footer = summaryWrapper.querySelector('.ts-summary-footer');
      if (footer) footer.remove();
    }
    appendTsError(detail || 'An error occurred. Please try again.');
    App.sending = false;
    const sendBtn = document.getElementById('travel-send-btn');
    if (sendBtn) sendBtn.disabled = false;
  }
});

socket.on('rag_progress', ({ status, detail }) => {
  _onRagProgress(status, detail);
  if (status === 'rag_error') {
    // Remove loading indicator immediately on error
    const loadingRow = document.querySelector('#rag-messages .loading-row');
    if (loadingRow) loadingRow.remove();
  }
});

// Map backend status -> human-readable label
const STATUS_LABELS = {
  searching_flights: '✈️ Searching for the best flights…',
  flights_found: '✈️ Flights found ✓',
  researching_destination: '🗺️ Researching places, hotels & food…',
  destination_found: '🗺️ Destination research complete ✓',
  building_itinerary: '📅 Building your day-by-day itinerary…',
  itinerary_done: '📅 Itinerary ready ✓',
  generating_report: '📝 Generating your trip report…',
  report_ready: '📝 Trip report generated ✓',
};

function _onAgentProgress(status, detail) {
  const label = STATUS_LABELS[status] || detail || status;

  // Update the summary card footer if it exists
  const footer = document.querySelector('.ts-summary-footer .ts-loading-label');
  if (footer) footer.textContent = label;

  // On final step update summary card footer
  if (status === 'report_ready') {
    if (footer) {
      const parent = footer.parentElement;
      if (parent) {
        parent.innerHTML = '<span class="ts-report-ready">✅ Trip report generated</span>';
      }
    }
  }
}

const RAG_STATUS_LABELS = {
  analysing:       '🔍 Analysing your question…',
  retrieving_docs: '📚 Retrieving from your documents…',
  searching_web:   '🌐 Searching the web…',
  thinking:        '🧠 Thinking…',
  rag_done:        '✅ Done',
};

function _onRagProgress(status, detail) {
  const label = RAG_STATUS_LABELS[status] || detail || status;
  const loadingRow = document.querySelector('#rag-messages .loading-row');
  if (!loadingRow) return;
  let labelEl = loadingRow.querySelector('.loading-status-label');
  if (!labelEl) {
    labelEl = document.createElement('div');
    labelEl.className = 'loading-status-label';
    labelEl.style.cssText = 'font-size:0.72rem;color:#94a3b8;margin-top:4px;text-align:center;padding:0 8px;';
    const bubble = loadingRow.querySelector('.loading-bubble');
    if (bubble) bubble.appendChild(labelEl);
  }
  labelEl.textContent = label;
}


// TripFlow state
const TripFlow = {
  query: '',
  parsedTrip: null,
  tripInfo: null,
  flightPrefs: null,
  travelPrefs: null,
  _resolve: null,
  _counts: { adults: 1, children: 0, infants_in_seat: 0, infants_on_lap: 0 },
};



//  Time Formatting

function formatLocalTime(isoString) {
  if (!isoString) return '';
  const raw = /[Zz]$|[+-]\d{2}:\d{2}$/.test(isoString) ? isoString : isoString + 'Z';
  const date = new Date(raw);
  if (isNaN(date)) return isoString;

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fmt = (d, opts) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(d);

  const todayStr = fmt(now, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const msgStr = fmt(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const yesterdayStr = fmt(new Date(now - 86400000), { year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeStr = fmt(date, { hour: 'numeric', minute: '2-digit', hour12: true });

  if (msgStr === todayStr) return `Today, ${timeStr}`;
  if (msgStr === yesterdayStr) return `Yesterday, ${timeStr}`;
  return `${fmt(date, { day: 'numeric', month: 'short', year: 'numeric' })}, ${timeStr}`;
}


//  Threads — with persistence + duplicate prevention

async function loadThreads() {
  try {
    const res = await fetch('/api/threads');
    if (!res.ok) return;

    App.threads = await res.json();

    // Restore the correct tab/thread state first.
    await _restoreLastThread();

    // Render only after the correct active thread has been resolved.
    renderThreadList();

    updateThreadLabel('travel');
    updateThreadLabel('rag');

  } catch (e) {
    console.error('Failed to load threads', e);
  }
}

/**
 * After load, auto-select the most recent thread for each tab type
 * so the user never sees an empty chat when history exists.
 */
async function _restoreLastThread() {
  const params = new URLSearchParams(window.location.search);

  // If a specific thread is being opened through ?thread=,
  // DOMContentLoaded will handle it.
  if (params.get('thread')) return;

  // If ?mode= is in the URL, honour it — override sessionStorage
  const modeParam = params.get('mode');
  if (modeParam && ['travel', 'rag', 'reports', 'docs'].includes(modeParam)) {
    sessionStorage.setItem('ts_active_tab', modeParam === 'travel' ? 'travel' : modeParam === 'rag' ? 'rag' : modeParam);
  }

  const travelThreads = App.threads.filter(t => t.type === 'travel');
  const ragThreads = App.threads.filter(t => t.type === 'rag');

  const savedTravelId = sessionStorage.getItem('ts_travel_thread') || '';
  const savedRagId = sessionStorage.getItem('ts_rag_thread') || '';

  // Restore each tab's selected thread independently
  const travelThread =
    travelThreads.find(t => t.id === savedTravelId) ||
    travelThreads[0] ||
    null;

  const ragThread =
    ragThreads.find(t => t.id === savedRagId) ||
    ragThreads[0] ||
    null;

  if (travelThread) {
    App.currentTravelThreadId = travelThread.id;
    sessionStorage.setItem('ts_travel_thread', String(travelThread.id));
  } else {
    App.currentTravelThreadId = null;
    sessionStorage.removeItem('ts_travel_thread');
  }

  if (ragThread) {
    App.currentRagThreadId = ragThread.id;
    sessionStorage.setItem('ts_rag_thread', String(ragThread.id));
  } else {
    App.currentRagThreadId = null;
    sessionStorage.removeItem('ts_rag_thread');
  }

  // Restore the previously active tab — now respects all 4 tab types
  const rawSaved = sessionStorage.getItem('ts_active_tab') || 'travel';
  const savedTab = ['travel', 'rag', 'reports', 'docs'].includes(rawSaved) ? rawSaved : 'travel';
  App.currentTab = savedTab;
  sessionStorage.setItem('ts_active_tab', savedTab);

  // Apply tab UI
  _applyTab(savedTab);
  renderThreadList();
  updateThreadLabel('travel');
  updateThreadLabel('rag');

  // Reports and Docs have no threads — just apply and return
  if (savedTab === 'reports' || savedTab === 'docs') {
    return;
  }

  // Load messages for the active tab
  if (savedTab === 'travel') {
    if (travelThread) await _loadThreadMessages(travelThread.id, 'travel', true);
    else clearChat('travel');
  } else {
    if (ragThread) await _loadThreadMessages(ragThread.id, 'rag', true);
    else clearChat('rag');
  }
}

/**
 * Silently activates a tab in the DOM without triggering any thread-load
 * side-effects.  Used by _restoreLastThread and switchTab.
 */
function _applyTab(tab) {
  App.currentTab = tab;
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  const tabBtn = document.querySelector(`.nav-tab[data-tab="${tab}"]`);
  if (tabBtn) tabBtn.classList.add('active');
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  const pane = document.getElementById(`tab-${tab}`);
  if (pane) pane.classList.add('active');
  if (tab === 'reports') loadReports();
  if (tab === 'docs') loadDocuments();
}

async function _loadThreadMessages(threadId, type, silent = false) {
  const tabName = type === 'rag' ? 'rag' : 'travel';
  const cid = tabName === 'travel'
    ? 'travel-messages'
    : 'rag-messages';

  try {
    /*
     * Make sure this thread actually belongs to the requested tab.
     * This prevents accidental cross-tab loading.
     */
    const thread = App.threads.find(t => t.id === threadId);

    if (!thread || thread.type !== tabName) {
      console.warn(
        `Ignoring invalid ${tabName} thread selection:`,
        threadId
      );

      clearChat(tabName);
      return;
    }

    /*
     * IMPORTANT:
     * Clear the current tab BEFORE checking whether the new
     * thread has messages.
     *
     * This fixes:
     * New Trip -> old Trip messages remaining on screen.
     */
    clearChat(tabName);

    /*
     * Make sure the selected thread is still the current
     * thread for this specific tab before starting the request.
     */
    const currentId = tabName === 'travel' ? App.currentTravelThreadId : App.currentRagThreadId;

    if (currentId !== threadId) { return; }

    const res = await fetch(`/api/threads/${threadId}/messages`);

    if (!res.ok) {
      console.error(`Failed to load ${tabName} thread messages:`, res.status);
      return;
    }

    const messages = await res.json();

    /*
     * The user may have switched threads while the request
     * was running.
     *
     * If that happened, DO NOT render these messages.
     */
    const latestCurrentId = tabName === 'travel' ? App.currentTravelThreadId : App.currentRagThreadId;

    if (App.currentTab !== tabName || latestCurrentId !== threadId) {
      return;
    }

    /*
     * Empty thread:
     *
     * clearChat() was already called above, so the chat remains
     * completely empty and the welcome screen is shown.
     */
    if (!Array.isArray(messages) || !messages.length) {
      return;
    }

    if (tabName === 'travel') {

      // Find source_id for artifacts
      let sourceId = null;

      try {
        const srcRes = await fetch(`/api/threads/${threadId}/sources`);

        if (srcRes.ok) {
          const srcData = await srcRes.json();
          sourceId = srcData.id;
        }
      } catch (_) { }

      /*
       * Check again because fetching sources is asynchronous.
       */
      if (App.currentTab !== 'travel' || App.currentTravelThreadId !== threadId) {
        return;
      }

      messages.forEach(msg => {

        if (msg.role !== 'assistant') {
          appendMessage(cid, msg.role, msg.content, null, msg.created_at, false);
          return;
        }

        appendMessageWithArtifacts(cid, msg.content, msg.created_at, sourceId, threadId, null, msg.id);
      });

    } else {

      /*
       * RAG messages
       */
      messages.forEach(msg => {

        if (
          msg.role === 'user' &&
          msg.attached_files &&
          msg.attached_files.length
        ) {
          appendRagUserMessage(
            cid,
            msg.content,
            msg.attached_files,
            msg.created_at
          );

        } else if (msg.role === 'assistant') {

          appendRagAssistantMessage(
            cid,
            msg.content,
            null,
            msg.created_at,
            [],
            msg.id
          );

          // Lazily restore source badge + artifact chips from stored record
          if (msg.id) {
            fetch(`/api/rag/chunks/by-message/${msg.id}`)
              .then(r => r.ok ? r.json() : null)
              .then(data => {
                if (!data) return;

                const source   = data.source   || 'direct';
                const chunks   = data.chunks   || [];
                const webUrls  = data.web_urls || [];

                const row = document.querySelector(
                  `#rag-messages .msg-row[data-assistant-chat-id="${msg.id}"]`
                );
                if (!row) return;

                // ── 1. Update source badge in footer ──
                const footer = row.querySelector('.msg-footer');
                if (footer) {
                  footer.querySelectorAll('.source-badge, .msg-footer-dot').forEach(el => el.remove());
                const badgeMap = {
                    kb:     `<span class="source-badge source-rag"><i class="bi bi-database-fill"></i> Hybrid Search</span>`,
                    web:    `<span class="source-badge source-web"><i class="bi bi-globe2"></i> Web Search</span>`,
                    direct: `<span class="source-badge source-llm"><i class="bi bi-cpu-fill"></i> Direct LLM</span>`,
                  };
                  const badgeHtml = badgeMap[source] || badgeMap['direct'];
                  const dot = document.createElement('div');
                  dot.className = 'msg-footer-dot';
                  footer.appendChild(dot);
                  footer.insertAdjacentHTML('beforeend', badgeHtml);
                }

                // ── 2. Inject artifact chips (skip for direct LLM) ──
                if (source === 'direct') return;

                // Remove any stale artifact row already rendered
                const existingArtRow = row.querySelector('.ts-artifacts-row');
                if (existingArtRow) existingArtRow.remove();

                const showKbChip  = source === 'kb';
                const showWebChip = source === 'web';
                const safeId      = row.querySelector('.msg-bubble')?.id || '';
                const chatId      = msg.id;
                const chunkCount  = chunks.length;
                const chipSubtitle = chunkCount > 0
                  ? `${chunkCount} chunk${chunkCount !== 1 ? 's' : ''} from your documents`
                  : 'From your documents';
                let restoreWebKey = '';
                if (showWebChip) {
                  restoreWebKey = `wurl_${++_webUrlsRegistryCounter}`;
                  _webUrlsRegistry.set(restoreWebKey, webUrls);
                }
                const webUrlsEncoded = showWebChip ? escapeAttr(JSON.stringify(webUrls)) : '[]';

                const artifactHtml = `
                  <div class="ts-artifacts-row">
                    ${showKbChip ? `
                    <div class="ts-artifact-chip ts-artifact-sources"
                         onclick="openRagContextArtifact('${safeId}', ${jsArg(chatId)})"
                         title="View retrieved document context">
                      <div class="ts-artifact-icon"><i class="bi bi-journals"></i></div>
                      <div class="ts-artifact-meta">
                        <div class="ts-artifact-name">Retrieved Context</div>
                        <div class="ts-artifact-sub">${chipSubtitle}</div>
                      </div>
                    </div>` : ''}
                    ${showWebChip ? `
                    <div class="ts-artifact-chip ts-artifact-sources"
                         onclick="openWebSourcesFromRegistry('${restoreWebKey}')"
                         title="View web sources"
                         data-web-key="${restoreWebKey}">
                      <div class="ts-artifact-icon"><i class="bi bi-globe2"></i></div>
                      <div class="ts-artifact-meta">
                        <div class="ts-artifact-name">Web Sources</div>
                        <div class="ts-artifact-sub">${webUrls.length} source${webUrls.length !== 1 ? 's' : ''}</div>
                      </div>
                    </div>` : ''}
                  </div>`;

                const msgBody = row.querySelector('.msg-body');
                if (msgBody) msgBody.insertAdjacentHTML('beforeend', artifactHtml);
              })
              .catch(() => {});
          }

        } else {

          appendMessage(
            cid,
            msg.role,
            msg.content,
            null,
            msg.created_at,
            false
          );
        }
      });
    }

    scrollToBottom(cid);

  } catch (e) {
    console.error(
      `Failed to load ${tabName} thread messages`,
      e
    );
  }
}

function renderThreadList() {
  const container = document.getElementById('thread-list');
  const empty = document.getElementById('thread-empty');
  container.querySelectorAll('.thread-item').forEach(el => el.remove());

  if (!App.threads.length) {
    if (empty) empty.style.display = 'flex';
    return;
  }
  if (empty) empty.style.display = 'none';

  // Derive the active thread id purely from the current tab — no shared sidebar id
  const activeThreadId = App.currentTab === 'rag'
    ? App.currentRagThreadId
    : App.currentTravelThreadId;

  App.threads.forEach(thread => {
    const isActive = thread.id === activeThreadId;
    const icon = thread.type === 'travel' ? 'bi-airplane' : 'bi-chat-square-dots';

    const item = document.createElement('div');
    item.className = 'thread-item' + (isActive ? ' active' : '');
    item.dataset.threadId = thread.id;
    item.dataset.threadType = thread.type;
    item.innerHTML = `
      <i class="bi ${icon} thread-icon"></i>
      <span class="thread-label" title="${escapeHtml(thread.title)}">${escapeHtml(thread.title)}</span>
      <button class="thread-chevron-btn" title="Options"
              onclick="toggleThreadMenu(event, ${jsArg(thread.id)})">
        <i class="bi bi-chevron-down"></i>
      </button>
      <div class="thread-dropdown" id="thread-menu-${thread.id}">
        <button class="thread-dropdown-item"
                onclick="openRenameFromSidebar(event, ${jsArg(thread.id)}, ${jsArg(thread.title)})">
          <i class="bi bi-pencil"></i> Rename
        </button>
        <button class="thread-dropdown-item thread-dropdown-delete"
                onclick="confirmDeleteThread(event, ${jsArg(thread.id)})">
          <i class="bi bi-trash3"></i> Delete
        </button>
      </div>`;
    item.addEventListener('click', () => switchThread(thread.id, thread.type));
    container.appendChild(item);
  });
}

/**
 * newThread — prevents creating duplicate empty chats.
 * If an empty "New Trip" / "New Travel Copilot" thread already exists for this type,
 * simply switch to it instead of creating another one.
 */
async function newThread(type) {
  const tabName =
    type === 'rag'
      ? 'rag'
      : 'travel';

  const emptyTitle =
    type === 'travel'
      ? 'New Trip'
      : 'New Travel Copilot';

  /*
   * Reuse an existing empty thread of the same type.
   * This prevents duplicate "New Trip" / "New Travel Copilot".
   */
  const existing = App.threads.find(
    t =>
      t.type === tabName &&
      t.title === emptyTitle
  );

  if (existing) {

    if (tabName === 'travel') {

      App.currentTravelThreadId =
        existing.id;

      sessionStorage.setItem(
        'ts_travel_thread',
        String(existing.id)
      );

    } else {

      App.currentRagThreadId =
        existing.id;

      sessionStorage.setItem(
        'ts_rag_thread',
        String(existing.id)
      );
    }

    /*
     * Switch to the correct tab first.
     */
    App.currentTab = tabName;

    _applyTab(tabName);

    sessionStorage.setItem(
      'ts_active_tab',
      tabName
    );

    /*
     * Clear ONLY this tab.
     */
    clearChat(tabName);

    /*
     * Re-render so the new thread is highlighted.
     */
    renderThreadList();

    updateThreadLabel(tabName);

    return;
  }

  try {

    const res = await fetch(
      '/api/threads',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: tabName,
          title: emptyTitle
        })
      }
    );

    if (!res.ok) {
      console.error(
        'Failed to create thread:',
        res.status
      );
      return;
    }

    const thread = await res.json();

    /*
     * Add the new thread to the local list.
     */
    App.threads.unshift(thread);

    /*
     * Select it ONLY for its own tab.
     */
    if (tabName === 'travel') {

      App.currentTravelThreadId =
        thread.id;

      sessionStorage.setItem(
        'ts_travel_thread',
        String(thread.id)
      );

    } else {

      App.currentRagThreadId =
        thread.id;

      sessionStorage.setItem(
        'ts_rag_thread',
        String(thread.id)
      );
    }

    /*
     * Activate the correct tab.
     */
    App.currentTab = tabName;

    _applyTab(tabName);

    sessionStorage.setItem(
      'ts_active_tab',
      tabName
    );

    /*
     * Clear only the new thread's tab.
     */
    clearChat(tabName);

    /*
     * Highlight the new thread.
     */
    renderThreadList();

    updateThreadLabel(tabName);

  } catch (e) {
    console.error(
      'Failed to create thread',
      e
    );
  }
}

async function switchThread(threadId, type) {
  const tabName =
    type === 'rag'
      ? 'rag'
      : 'travel';

  /*
   * Verify that the thread exists and belongs
   * to the requested tab.
   */
  const thread = App.threads.find(
    t => t.id === threadId
  );

  if (!thread || thread.type !== tabName) {
    console.warn(
      'Invalid thread selection:',
      threadId,
      type
    );
    return;
  }

  /*
   * Update ONLY the selected thread for this tab.
   */
  if (tabName === 'travel') {
    App.currentTravelThreadId = threadId;

    sessionStorage.setItem(
      'ts_travel_thread',
      String(threadId)
    );
  } else {
    App.currentRagThreadId = threadId;

    sessionStorage.setItem(
      'ts_rag_thread',
      String(threadId)
    );
  }

  /*
   * Activate the requested tab.
   */
  App.currentTab = tabName;

  _applyTab(tabName);

  sessionStorage.setItem(
    'ts_active_tab',
    tabName
  );

  /*
   * Highlight the selected thread immediately.
   */
  renderThreadList();

  /*
   * Load ONLY this thread into ONLY this tab.
   */
  await _loadThreadMessages(
    threadId,
    tabName
  );

  updateThreadLabel(tabName);
}

// Toggle the dropdown menu for a thread item
function toggleThreadMenu(event, threadId) {
  event.stopPropagation();
  // Close all other open menus first
  document.querySelectorAll('.thread-dropdown.open').forEach(el => {
    if (el.id !== `thread-menu-${threadId}`) el.classList.remove('open');
  });
  const menu = document.getElementById(`thread-menu-${threadId}`);
  if (menu) menu.classList.toggle('open');
}

// Close all thread dropdowns when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.thread-dropdown.open').forEach(el => el.classList.remove('open'));
});

// Open rename modal from sidebar chevron menu
function openRenameFromSidebar(event, threadId, currentTitle) {
  event.stopPropagation();
  document.querySelectorAll('.thread-dropdown.open').forEach(el => el.classList.remove('open'));
  _renameThreadId = threadId;
  // Point _renameNameEl to the .thread-label span so confirmRename() can update it
  _renameNameEl = document.querySelector(`.thread-item[data-thread-id="${threadId}"] .thread-label`);
  document.getElementById('rename-input').value = currentTitle;
  if (!_renameModal) _renameModal = new bootstrap.Modal(document.getElementById('renameModal'));
  _renameModal.show();
  setTimeout(() => document.getElementById('rename-input').select(), 300);
}

// Show bootstrap modal to confirm delete
let _deleteThreadId = null;
function confirmDeleteThread(event, threadId) {
  event.stopPropagation();
  document.querySelectorAll('.thread-dropdown.open').forEach(el => el.classList.remove('open'));
  _deleteThreadId = threadId;
  if (!_deleteModal) _deleteModal = new bootstrap.Modal(document.getElementById('deleteThreadModal'));
  _deleteModal.show();
}

let _deleteModal = null;

async function deleteThread(event, threadId) {
  if (event) event.stopPropagation();
  try {
    await fetch(`/api/threads/${threadId}`, { method: 'DELETE' });
    App.threads = App.threads.filter(t => t.id !== threadId);

    if (App.currentTravelThreadId === threadId) {
      App.currentTravelThreadId = null;
      sessionStorage.removeItem('ts_travel_thread');
      clearChat('travel');
      updateThreadLabel('travel');
      // Auto-select next available travel thread
      const next = App.threads.find(t => t.type === 'travel');
      if (next) {
        App.currentTravelThreadId = next.id;
        sessionStorage.setItem('ts_travel_thread', next.id);
        if (App.currentTab === 'travel') _loadThreadMessages(next.id, 'travel', true);
      }
    }

    if (App.currentRagThreadId === threadId) {
      App.currentRagThreadId = null;
      sessionStorage.removeItem('ts_rag_thread');
      clearChat('rag');
      updateThreadLabel('rag');
      // Auto-select next available rag thread
      const next = App.threads.find(t => t.type === 'rag');
      if (next) {
        App.currentRagThreadId = next.id;
        sessionStorage.setItem('ts_rag_thread', next.id);
        if (App.currentTab === 'rag') _loadThreadMessages(next.id, 'rag', true);
      }
    }

    renderThreadList();
  } catch (e) {
    console.error('Failed to delete thread', e);
  }
}

async function executeDeleteThread() {
  if (!_deleteThreadId) return;
  if (_deleteModal) _deleteModal.hide();
  await deleteThread(null, _deleteThreadId);
  _deleteThreadId = null;
}


//  Sidebar Toggle

function toggleSidebar() {
  const shell = document.getElementById('app-shell');
  if (window.innerWidth <= 768) {
    shell.classList.toggle('sidebar-open');
  } else {
    shell.classList.toggle('sidebar-collapsed');
    document.body.classList.toggle('desktop-sidebar-collapsed', shell.classList.contains('sidebar-collapsed'));
  }
}

function closeMobileSidebar() {
  document.getElementById('app-shell').classList.remove('sidebar-open');
}

window.addEventListener('resize', () => {
  const shell = document.getElementById('app-shell');
  if (window.innerWidth > 768) {
    shell.classList.remove('sidebar-open');
  } else {
    shell.classList.remove('sidebar-collapsed');
    document.body.classList.remove('desktop-sidebar-collapsed');
  }
});



//  Tabs — highlight sidebar item on switch

async function switchTab(tab, el) {
  const tabName = tab === 'rag' ? 'rag' : tab === 'reports' ? 'reports' : tab === 'docs' ? 'docs' : 'travel';

  App.currentTab = tabName;
  sessionStorage.setItem('ts_active_tab', tabName);

  const params = new URLSearchParams(window.location.search);
  params.set('mode', tabName);
  params.delete('q');
  history.pushState({ tab: tabName }, '', '/chat?' + params.toString());

  _applyTab(tabName);

  // Reports and Docs tabs have no threads — just apply the tab and return
  if (tabName === 'reports' || tabName === 'docs') {
    renderThreadList();
    return;
  }

  // Resolve the correct thread for THIS tab only
  let selectedThreadId = tabName === 'travel'
    ? App.currentTravelThreadId
    : App.currentRagThreadId;

  // Verify stored thread still exists and belongs to this tab
  const selectedThread = selectedThreadId
    ? App.threads.find(t => t.id === selectedThreadId && t.type === tabName)
    : null;

  // If stored thread is invalid, fall back to latest thread for this tab
  if (!selectedThread) {
    const latestThread = App.threads.find(t => t.type === tabName) || null;
    selectedThreadId = latestThread ? latestThread.id : null;

    if (tabName === 'travel') {
      App.currentTravelThreadId = selectedThreadId;
      if (selectedThreadId) sessionStorage.setItem('ts_travel_thread', String(selectedThreadId));
      else sessionStorage.removeItem('ts_travel_thread');
    } else {
      App.currentRagThreadId = selectedThreadId;
      if (selectedThreadId) sessionStorage.setItem('ts_rag_thread', String(selectedThreadId));
      else sessionStorage.removeItem('ts_rag_thread');
    }
  }

  // Highlight the correct thread in sidebar BEFORE loading messages
  renderThreadList();
  updateThreadLabel(tabName);

  // Load messages for the active tab's thread
  if (selectedThreadId) {
    await _loadThreadMessages(selectedThreadId, tabName, true);
  } else {
    clearChat(tabName);
  }
}


function clearQueryParam() {
  const params = new URLSearchParams(window.location.search);
  params.delete('q');
  const newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
  history.replaceState(null, '', newUrl);
}


//  TRAVEL SEND — with Socket.IO sid

async function sendTravel() {
  if (App.sending) return;

  const input = document.getElementById('travel-input');
  const message = (input?.value || '').trim();
  if (!message) return;

  input.value = '';
  autoGrow(input);
  document.getElementById('travel-send-btn').disabled = true;
  App.sending = true;

  TripFlow.query = message;
  TripFlow.parsedTrip = null;
  TripFlow.tripInfo = null;
  TripFlow.flightPrefs = null;
  TripFlow.travelPrefs = null;
  TripFlow._counts = { adults: 1, children: 0, infants_in_seat: 0, infants_on_lap: 0 };

  hideWelcome('travel-welcome');
  appendMessage('travel-messages', 'user', message, null, new Date().toISOString(), false);


  scrollToBottom('travel-messages');

  try {
    // STEP 1: Parse trip
    tsSetLoading(true, 'Analysing your trip…');

    const parseRes = await fetch('/api/parse-trip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: message }),
    });

    if (!parseRes.ok) throw new Error('Could not reach the server. Please try again.');

    const parsed = await parseRes.json();
    tsSetLoading(false);


    TripFlow.parsedTrip = parsed.trip_info || {};

    // STEP 2: Hard-block missing route
    if (parsed.needs_route) {
      appendTsError(
        "I couldn't determine your departure or destination. " +
        'Please include both — e.g. <em>"from Chennai to Bangkok"</em>.'
      );
      return;
    }

    // STEP 3: Date picker
    let tripInfo = await tsShowDatePicker(parsed.trip_info || {});
    if (!tripInfo) return;
    TripFlow.tripInfo = tripInfo;

    // STEP 4: Non-blocking warnings
    if (parsed.warnings && parsed.warnings.length) {
      const proceed = await tsShowWarnings(parsed.warnings);
      if (!proceed) return;
    }

    // STEP 5: Flight preferences
    const flightPrefs = await tsShowFlightPrefs(tripInfo, TripFlow.parsedTrip);
    if (!flightPrefs) return;
    TripFlow.flightPrefs = flightPrefs;

    // STEP 6: Travel preferences
    const travelPrefs = await tsShowTravelPrefs(TripFlow.parsedTrip);
    if (!travelPrefs) return;
    TripFlow.travelPrefs = travelPrefs;

    // STEP 7: Summary card
    tsAppendSummaryCard(tripInfo, flightPrefs, travelPrefs);

    // Join socket room so backend can push progress
    const threadKey = App.currentTravelThreadId
      ? String(App.currentTravelThreadId)
      : socket.id;
    socket.emit('join_trip', { thread_id: threadKey });

    // STEP 8: Run agents
    // const loadingId = appendLoading('travel-messages');
    scrollToBottom('travel-messages');

    const requestThreadId = App.currentTravelThreadId;

    const travelRes = await fetch('/api/travel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        trip_info: tripInfo,
        flight_prefs: flightPrefs,
        travel_prefs: travelPrefs,
        thread_id: requestThreadId,
        sid: socket.id,
        trip_summary_data: { trip_info: tripInfo, flight_prefs: flightPrefs, travel_prefs: travelPrefs },
      }),
    });

    const data = await travelRes.json();
    // removeLoading(loadingId);

    // Remove status indicator
    const statusEl = document.getElementById('ts-agent-status');
    if (statusEl) statusEl.remove();

    socket.emit('leave_trip', { thread_id: threadKey });

    if (
      App.currentTab !== 'travel' ||
      App.currentTravelThreadId !== requestThreadId
    ) {
      clearQueryParam();
      return;
    }

    clearQueryParam();

    if (data.error) {
      appendTsError(data.error);
    } else if (travelRes.ok) {
      // Append the main assistant message with artifacts — summary card renders inside it
      appendMessageWithArtifacts(
        'travel-messages',
        data.response,
        data.assistant_created_at,
        data.source_id,
        data.thread_id,
        { trip_info: tripInfo, flight_prefs: flightPrefs, travel_prefs: travelPrefs },
        data.assistant_chat_id
      );

      if (data.thread_id && !App.currentTravelThreadId) {
        App.currentTravelThreadId = data.thread_id;

        await loadThreads();
      } else if (data.thread_id) {
        const t = App.threads.find(t => t.id === data.thread_id);
        if (t && data.thread_title) t.title = data.thread_title;
        renderThreadList();
      }
      updateThreadLabel('travel');
    } else {
      appendTsError(data.detail || 'Something went wrong. Please try again.');
    }

  } catch (err) {
    tsSetLoading(false);
    clearQueryParam();

    document.querySelectorAll('.ts-card-wrapper').forEach(el => el.remove());
    appendTsError('Network error: ' + err.message);
  } finally {
    App.sending = false;
    document.getElementById('travel-send-btn').disabled = false;
    scrollToBottom('travel-messages');
    document.getElementById('travel-input')?.focus();
  }
}


//  Pre-flight UI helpers

function tsSetLoading(active, label) {
  const existing = document.getElementById('ts-inline-loading');
  if (active) {
    if (existing) return;

    const row = document.createElement('div');
    row.id = 'ts-inline-loading';
    row.className = 'msg-row assistant';
    row.innerHTML = `
      <div class="msg-body">
        <div class="msg-bubble assistant ts-inline-loading-bubble">
          <span class="ts-dots">
            <span></span><span></span><span></span>
          </span>
          <span class="ts-loading-label">${escapeHtml(label || 'Working…')}</span>
        </div>
        <div class="msg-footer">
          <div class="msg-footer-avatar">🤖</div>
          <span class="msg-footer-time">${formatLocalTime(new Date().toISOString())}</span>
        </div>
      </div>`;

    const container = document.getElementById('travel-messages');
    if (container) { container.appendChild(row); scrollToBottom('travel-messages'); }
  } else {
    if (existing) existing.remove();
  }
}

function appendTsError(html) {
  const container = document.getElementById('travel-messages');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.innerHTML = `
    <div class="msg-body">
      <div class="msg-bubble assistant ts-error-bubble">${html}</div>
      <div class="msg-footer">
        <div class="msg-footer-avatar">⚠️</div>
        <span class="msg-footer-time">${formatLocalTime(new Date().toISOString())}</span>
      </div>
    </div>`;
  container.appendChild(row);
  scrollToBottom('travel-messages');
}

function tsAppendCard(id, html) {
  const container = document.getElementById('travel-messages');
  if (!container) return;
  const old = document.getElementById(id);
  if (old) old.closest('.ts-card-wrapper')?.remove();

  const row = document.createElement('div');
  row.className = 'ts-card-wrapper msg-row assistant';
  row.innerHTML = `
    <div class="msg-body">
      <div class="ts-card" id="${id}">${html}</div>
      <div class="msg-footer">
        <div class="msg-footer-avatar">🤖</div>
        <span class="msg-footer-time">${formatLocalTime(new Date().toISOString())}</span>
      </div>
    </div>`;
  container.appendChild(row);
  scrollToBottom('travel-messages');
}

function tsRemoveCard(id) {
  const el = document.getElementById(id);
  if (el) el.closest('.ts-card-wrapper')?.remove();
}

function tsResolve(value) {
  if (TripFlow._resolve) {
    const fn = TripFlow._resolve;
    TripFlow._resolve = null;
    fn(value);
  }
}


// DATE PICKER

function tsShowDatePicker(tripInfo) {
  return new Promise(resolve => {
    TripFlow._resolve = resolve;
    TripFlow.tripInfo = tripInfo;

    const today = new Date();
    const minDate = today.toISOString().split('T')[0];
    const s = tripInfo?.start_date || '';
    const e = tripInfo?.end_date || '';
    const origin = tripInfo?.origin_iata || '?';
    const dest = tripInfo?.destination_iata || '?';

    tsAppendCard('ts-date-picker', `
      <div class="ts-card-header">
        <span class="ts-card-icon">📅</span>
        <div>
          <div class="ts-card-title">Confirm Trip Dates</div>
          <div class="ts-card-sub">
            ${escapeHtml(origin)} → ${escapeHtml(dest)}
            ${s && e ? ' · Dates pre-filled from your query — edit if needed.' : ' · Please select your travel dates.'}
          </div>
        </div>
      </div>
      <div class="ts-date-grid">
        <div class="ts-date-field">
          <label>Departure Date</label>
          <input type="date" id="dp-start" min="${minDate}" value="${escapeHtml(s)}"
                 class="ts-date-input" onchange="tsDatePickerValidate()" />
        </div>
        <div class="ts-date-field">
          <label>Return / End Date</label>
          <input type="date" id="dp-end" min="${minDate}" value="${escapeHtml(e)}"
                 class="ts-date-input" onchange="tsDatePickerValidate()" />
        </div>
      </div>
      <div id="dp-warn" class="ts-date-warning" style="display:none;"></div>
      <div class="ts-card-actions">
        <button class="ts-btn ts-btn-ghost" onclick="tsDatePickerCancel()">Cancel</button>
        <button class="ts-btn ts-btn-primary" id="dp-confirm"
                onclick="tsDatePickerConfirm()" ${s && e ? '' : 'disabled'}>
          Next →
        </button>
      </div>
    `);

    if (s && e) tsDatePickerValidate();
  });
}

function tsDatePickerValidate() {
  const startEl = document.getElementById('dp-start');
  const endEl = document.getElementById('dp-end');
  const warnEl = document.getElementById('dp-warn');
  const confirmEl = document.getElementById('dp-confirm');
  if (!startEl || !endEl) return;

  const s = startEl.value, e = endEl.value;
  const warnings = [];
  let canConfirm = false;

  if (s && e) {
    const start = new Date(s), end = new Date(e);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const deltaDays = Math.floor((start - today) / 86400000);

    if (end <= start) {
      warnings.push('Return date must be after departure date.');
    } else if (deltaDays < 0) {
      warnings.push('Departure date cannot be in the past.');
    } else {
      canConfirm = true;
      if (deltaDays < 7) warnings.push('⚠️ Trips are best booked at least 7 days in advance.');
    }
  }

  if (warnEl) {
    warnEl.innerHTML = warnings.map(w => escapeHtml(w)).join('<br>');
    warnEl.style.display = warnings.length ? 'block' : 'none';
  }
  if (confirmEl) confirmEl.disabled = !canConfirm;
}

function tsDatePickerConfirm() {
  const s = document.getElementById('dp-start')?.value;
  const e = document.getElementById('dp-end')?.value;
  if (!s || !e || new Date(e) <= new Date(s)) return;
  tsRemoveCard('ts-date-picker');
  tsResolve({ ...TripFlow.tripInfo, start_date: s, end_date: e });
}

function tsDatePickerCancel() {
  tsRemoveCard('ts-date-picker');
  tsResolve(null);
}


// WARNINGS CARD 

function tsShowWarnings(warnings) {
  return new Promise(resolve => {
    TripFlow._resolve = resolve;
    const items = warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('');
    tsAppendCard('ts-warnings', `
      <div class="ts-card-header">
        <span class="ts-card-icon">⚠️</span>
        <div>
          <div class="ts-card-title">Planning Recommendation</div>
          <div class="ts-card-sub">These are suggestions, not restrictions.</div>
        </div>
      </div>
      <ul class="ts-warn-list">${items}</ul>
      <div class="ts-card-actions">
        <button class="ts-btn ts-btn-ghost"   onclick="tsWarningsResolve(false)">Cancel</button>
        <button class="ts-btn ts-btn-primary" onclick="tsWarningsResolve(true)">Continue Anyway</button>
      </div>
    `);
  });
}

function tsWarningsResolve(value) {
  tsRemoveCard('ts-warnings');
  tsResolve(value);
}


// FLIGHT PREFS CARD 
function tsShowFlightPrefs(tripInfo, parsedTrip) {
  return new Promise(resolve => {
    TripFlow._resolve = resolve;

    const p = parsedTrip || {};
    TripFlow._counts = {
      adults: p.adults || 1,
      children: p.children || 0,
      infants_in_seat: p.infants_in_seat || 0,
      infants_on_lap: p.infants_on_lap || 0,
    };

    const preType = p.trip_type || '';
    const preCls = p.travel_class || '';
    const origin = tripInfo?.origin_iata || '?';
    const dest = tripInfo?.destination_iata || '?';
    const dep = tripInfo?.start_date || '';
    const ret = tripInfo?.end_date || '';

    tsAppendCard('ts-flight-prefs', `
      <div class="ts-card-header">
        <span class="ts-card-icon">✈️</span>
        <div>
          <div class="ts-card-title">Flight Preferences</div>
          <div class="ts-card-sub">
            ${escapeHtml(origin)} → ${escapeHtml(dest)}
            &nbsp;·&nbsp; ${escapeHtml(dep)} → ${escapeHtml(ret)}
          </div>
        </div>
      </div>

      <div class="ts-prefs-grid">

        <div class="ts-pref-group ts-span-full">
          <label class="ts-pref-label">Trip Type</label>
          <div class="ts-toggle-group" id="pref-type">
            <button class="ts-toggle ${preType === '1' ? 'active' : ''}" data-val="1"
                    onclick="tsSelectToggle('pref-type', this)">🔄 Round Trip</button>
            <button class="ts-toggle ${preType === '2' ? 'active' : ''}" data-val="2"
                    onclick="tsSelectToggle('pref-type', this)">→ One-way</button>
          </div>
        </div>

        <div class="ts-pref-group ts-span-full">
          <label class="ts-pref-label">Travel Class</label>
          <div class="ts-toggle-group" id="pref-class">
            <button class="ts-toggle ${preCls == 1 ? 'active' : ''}" data-val="1"
                    onclick="tsSelectToggle('pref-class', this)">Economy</button>
            <button class="ts-toggle ${preCls == 2 ? 'active' : ''}" data-val="2"
                    onclick="tsSelectToggle('pref-class', this)">Prem. Economy</button>
            <button class="ts-toggle ${preCls == 3 ? 'active' : ''}" data-val="3"
                    onclick="tsSelectToggle('pref-class', this)">Business</button>
            <button class="ts-toggle ${preCls == 4 ? 'active' : ''}" data-val="4"
                    onclick="tsSelectToggle('pref-class', this)">First</button>
          </div>
        </div>

        <div class="ts-pref-group ts-span-full">
          <label class="ts-pref-label">Passengers</label>
          <div class="ts-pax-grid">
            ${_paxRow('adults', 'Adults', TripFlow._counts.adults, 1, 9)}
            ${_paxRow('children', 'Children (2–11)', TripFlow._counts.children, 0, 9)}
            ${_paxRow('infants_in_seat', 'Infants (seat)', TripFlow._counts.infants_in_seat, 0, 9)}
            ${_paxRow('infants_on_lap', 'Infants (lap)', TripFlow._counts.infants_on_lap, 0, 9)}
          </div>
        </div>

        <div class="ts-pref-group">
          <label class="ts-pref-label">Currency</label>
        <select class="ts-select" id="pref-currency">
          <option value="" disabled ${!p.currency ? 'selected' : ''}>Select currency</option>
          <option value="INR" ${p.currency === 'INR' ? 'selected' : ''}>🇮🇳 INR</option>
          <option value="USD" ${p.currency === 'USD' ? 'selected' : ''}>🇺🇸 USD</option>
          <option value="EUR" ${p.currency === 'EUR' ? 'selected' : ''}>🇪🇺 EUR</option>
          <option value="GBP" ${p.currency === 'GBP' ? 'selected' : ''}>🇬🇧 GBP</option>
          <option value="AED" ${p.currency === 'AED' ? 'selected' : ''}>🇦🇪 AED</option>
          <option value="SGD" ${p.currency === 'SGD' ? 'selected' : ''}>🇸🇬 SGD</option>
          <option value="JPY" ${p.currency === 'JPY' ? 'selected' : ''}>🇯🇵 JPY</option>
          <option value="AUD" ${p.currency === 'AUD' ? 'selected' : ''}>🇦🇺 AUD</option>
          <option value="CAD" ${p.currency === 'CAD' ? 'selected' : ''}>🇨🇦 CAD</option>
          <option value="THB" ${p.currency === 'THB' ? 'selected' : ''}>🇹🇭 THB</option>
        </select>
        </div>

        <div class="ts-pref-group">
          <label class="ts-pref-label">Search Region</label>
          <select class="ts-select" id="pref-gl">
            <option value="" disabled ${!p.gl ? 'selected' : ''}>Select region</option>
            <option value="in" ${p.gl === 'in' ? 'selected' : ''}>🇮🇳 India</option>
            <option value="us" ${p.gl === 'us' ? 'selected' : ''}>🇺🇸 United States</option>
            <option value="gb" ${p.gl === 'gb' ? 'selected' : ''}>🇬🇧 United Kingdom</option>
            <option value="sg" ${p.gl === 'sg' ? 'selected' : ''}>🇸🇬 Singapore</option>
            <option value="ae" ${p.gl === 'ae' ? 'selected' : ''}>🇦🇪 UAE</option>
            <option value="au" ${p.gl === 'au' ? 'selected' : ''}>🇦🇺 Australia</option>
          </select>
        </div>

      </div>

      <div class="ts-card-actions">
        <button class="ts-btn ts-btn-ghost"   onclick="tsFlightPrefsCancel()">Cancel</button>
        <button class="ts-btn ts-btn-primary" onclick="tsFlightPrefsConfirm()">Next →</button>
      </div>
    `);
  });
}

function _paxRow(key, label, value, min, max) {
  return `
    <div class="ts-pax-row">
      <span class="ts-pax-label">${escapeHtml(label)}</span>
      <div class="ts-stepper">
        <button class="ts-step-btn" onclick="tsPaxStep('${key}', -1, ${min}, ${max})">−</button>
        <span id="ts-pax-${key}">${value}</span>
        <button class="ts-step-btn" onclick="tsPaxStep('${key}', 1, ${min}, ${max})">+</button>
      </div>
    </div>`;
}

function tsPaxStep(key, delta, min, max) {
  TripFlow._counts[key] = Math.max(min, Math.min(max, (TripFlow._counts[key] || 0) + delta));
  const el = document.getElementById(`ts-pax-${key}`);
  if (el) el.textContent = TripFlow._counts[key];
}

function tsSelectToggle(groupId, btn) {
  document.querySelectorAll(`#${groupId} .ts-toggle`)
    .forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function tsFlightPrefsConfirm() {
  const type = document.querySelector('#pref-type .ts-toggle.active')?.dataset.val || '';
  const cls = document.querySelector('#pref-class .ts-toggle.active')?.dataset.val || '';
  const currency = document.getElementById('pref-currency')?.value || '';
  const gl = document.getElementById('pref-gl')?.value || '';
  const hl = 'en';

  tsRemoveCard('ts-flight-prefs');
  tsResolve({
    type, currency, hl, gl,
    adults: TripFlow._counts.adults,
    children: TripFlow._counts.children,
    infants_in_seat: TripFlow._counts.infants_in_seat,
    infants_on_lap: TripFlow._counts.infants_on_lap,
    travel_class: cls ? parseInt(cls, 10) : null,
  });
}

function tsFlightPrefsCancel() {
  tsRemoveCard('ts-flight-prefs');
  tsResolve(null);
}


// TRAVEL PREFERENCES
function tsShowTravelPrefs(parsedTrip) {
  return new Promise(resolve => {
    TripFlow._resolve = resolve;
    const p = parsedTrip || {};

    const preStyle = p.travel_style || '';
    const preBudget = p.budget || '';
    const preInterests = p.interests || [];
    const preHotel = p.hotel_preference || [];
    const preDiet = p.diet || [];
    const preFood = p.food_preference || [];
    const preSpecial = p.special_requirements || [];

    function _chips(groupId, options, preSelected) {
      return options.map(opt => {
        const active = preSelected.includes(opt) ? 'active' : '';
        return `<button class="ts-chip ${active}" data-group="${groupId}"
                  onclick="tsChipToggle(this)">${escapeHtml(opt)}</button>`;
      }).join('');
    }

    tsAppendCard('ts-travel-prefs', `
      <div class="ts-card-header">
        <span class="ts-card-icon">🎒</span>
        <div>
          <div class="ts-card-title">Travel Preferences</div>
          <div class="ts-card-sub">Help us personalise your itinerary and recommendations.</div>
        </div>
      </div>

      <div class="ts-prefs-grid">

        <div class="ts-pref-group ts-span-full">
          <label class="ts-pref-label">Travel Style</label>
          <div class="ts-toggle-group" id="pref-style">
            <button class="ts-toggle ${preStyle === 'Adventure' ? 'active' : ''}" data-val="Adventure"
                    onclick="tsSelectToggle('pref-style', this)">🏔️ Adventure</button>
            <button class="ts-toggle ${preStyle === 'Relaxed' ? 'active' : ''}"   data-val="Relaxed"
                    onclick="tsSelectToggle('pref-style', this)">🏖️ Relaxed</button>
            <button class="ts-toggle ${preStyle === 'Balanced' ? 'active' : ''}"  data-val="Balanced"
                    onclick="tsSelectToggle('pref-style', this)">⚖️ Balanced</button>
          </div>
        </div>

        <div class="ts-pref-group ts-span-full">
          <label class="ts-pref-label">Budget</label>
          <div class="ts-toggle-group" id="pref-budget">
            <button class="ts-toggle ${preBudget === 'Budget' ? 'active' : ''}"    data-val="Budget"
                    onclick="tsSelectToggle('pref-budget', this)">💸 Budget</button>
            <button class="ts-toggle ${preBudget === 'Mid-range' ? 'active' : ''}" data-val="Mid-range"
                    onclick="tsSelectToggle('pref-budget', this)">💳 Mid-range</button>
            <button class="ts-toggle ${preBudget === 'Luxury' ? 'active' : ''}"    data-val="Luxury"
                    onclick="tsSelectToggle('pref-budget', this)">💎 Luxury</button>
          </div>
        </div>

        <div class="ts-pref-group ts-span-full">
          <label class="ts-pref-label">Interests <span class="ts-label-hint">(select all that apply)</span></label>
          <div class="ts-chips-wrap" id="chips-interests">
            ${_chips('interests', ['Nature', 'Culture', 'Beaches', 'Adventure', 'History', 'Nightlife', 'Shopping', 'Photography', 'Food', 'Wellness'], preInterests)}
          </div>
        </div>

        <div class="ts-pref-group ts-span-full">
          <label class="ts-pref-label">Hotel Preference</label>
          <div class="ts-chips-wrap" id="chips-hotel">
            ${_chips('hotel', ['Hotel', 'Boutique', 'Hostel', 'Resort', 'Beachfront', 'Villa', 'Airbnb'], preHotel)}
          </div>
        </div>

        <div class="ts-pref-group ts-span-full">
          <label class="ts-pref-label">Diet</label>
          <div class="ts-chips-wrap" id="chips-diet">
            ${_chips('diet', ['Veg', 'Non-veg'], preDiet)}
          </div>
        </div>

        <div class="ts-pref-group ts-span-full">
          <label class="ts-pref-label">Food Preference</label>
          <div class="ts-chips-wrap" id="chips-food">
            ${_chips('food', ['Local Food', 'Seafood', 'Street food', 'Fine dining', 'Vegetarian', 'Halal', 'Vegan'], preFood)}
          </div>
        </div>

        <div class="ts-pref-group ts-span-full">
          <label class="ts-pref-label">Traveling as</label>
          <div class="ts-chips-wrap" id="chips-special">
            ${_chips('special', ['Solo', 'Couple', 'Family', 'Family and Kids', 'Friends', 'Seniors'], preSpecial)}
          </div>
        </div>

      </div>

      <div id="tp-warn" class="ts-date-warning" style="display:none;">Please select at least one diet option.</div>

      <div class="ts-card-actions">
        <button class="ts-btn ts-btn-ghost"   onclick="tsTravelPrefsCancel()">Cancel</button>
        <button class="ts-btn ts-btn-primary" onclick="tsTravelPrefsConfirm()"><i class="bi bi-send-check-fill"></i> Build my Plan</button>
      </div>
    `);
  });
}

function tsChipToggle(btn) {
  const groupId = btn.dataset.group;

  if (groupId === 'special') {
    document.querySelectorAll('#chips-special .ts-chip')
      .forEach(chip => chip.classList.remove('active'));

    btn.classList.add('active');
    return;
  }

  btn.classList.toggle('active');
}

function setRagUploadLock(locked) {
  const input = document.getElementById('rag-input');
  const sendBtn = document.getElementById('rag-send-btn');
  const attachBtn = document.querySelector('label[for="rag-file-input"]');

  if (input) {
    input.disabled = locked;
    input.placeholder = locked
      ? 'Uploading document… please wait'
      : 'Ask about visas, destinations, tips, or your documents...';
  }

  if (sendBtn) {
    sendBtn.disabled = locked || App.sending;
  }

  if (attachBtn) {
    attachBtn.style.pointerEvents = locked ? 'none' : '';
    attachBtn.style.opacity = locked ? '0.5' : '';
  }
}


function _getChips(wrapperId) {
  return Array.from(document.querySelectorAll(`#${wrapperId} .ts-chip.active`))
    .map(b => b.textContent.trim());
}

function tsTravelPrefsConfirm() {
  const diet = _getChips('chips-diet');
  const warn = document.getElementById('tp-warn');
  if (!diet.length) {
    if (warn) { warn.style.display = 'block'; warn.textContent = 'Please select at least one diet option.'; }
    return;
  }
  if (warn) warn.style.display = 'none';

  const travel_style = document.querySelector('#pref-style .ts-toggle.active')?.dataset.val || '';
  const budget = document.querySelector('#pref-budget .ts-toggle.active')?.dataset.val || '';
  const interests = _getChips('chips-interests');
  const hotel_preference = _getChips('chips-hotel');
  const food_preference = _getChips('chips-food');
  const special_requirements = _getChips('chips-special');

  tsRemoveCard('ts-travel-prefs');
  tsResolve({
    travel_style,
    budget,
    interests: interests.length ? interests : ['Culture', 'Nature'],
    hotel_preference: hotel_preference.length ? hotel_preference : ['Hotel'],
    diet,
    food_preference: food_preference.length ? food_preference : ['Local'],
    special_requirements: special_requirements.length ? special_requirements : ['Solo'],
  });
}

function tsTravelPrefsCancel() {
  tsRemoveCard('ts-travel-prefs');
  tsResolve(null);
}


//  SUMMARY CARD — with real-time status line

function tsAppendSummaryCard(tripInfo, flightPrefs, travelPrefs) {
  const cls = { 1: 'Economy', 2: 'Prem. Economy', 3: 'Business', 4: 'First' }[flightPrefs.travel_class] || 'Economy';
  const type = flightPrefs.type === '2' ? 'One-way' : 'Round Trip';
  const paxParts = [];
  if (flightPrefs.adults) paxParts.push(`${flightPrefs.adults} adult${flightPrefs.adults !== 1 ? 's' : ''}`);
  if (flightPrefs.children) paxParts.push(`${flightPrefs.children} child${flightPrefs.children !== 1 ? 'ren' : ''}`);
  if (flightPrefs.infants_in_seat) paxParts.push(`${flightPrefs.infants_in_seat} infant(seat)`);
  if (flightPrefs.infants_on_lap) paxParts.push(`${flightPrefs.infants_on_lap} infant(lap)`);

  const pills = (arr) => (arr || []).map(v =>
    `<span class="ts-summary-pill">${escapeHtml(v)}</span>`
  ).join('');

  const html = `
    <div class="msg-row assistant ts-summary-msg-row">
      <div class="msg-body">
        <div class="ts-summary-card">
          <div class="ts-summary-header">
            <span class="ts-summary-icon">🗺️</span>
            <div>
              <div class="ts-summary-title">Your Trip at a Glance</div>
              <div class="ts-summary-route">
                ${escapeHtml(tripInfo.origin_iata)} → ${escapeHtml(tripInfo.destination_iata)}
                &nbsp;·&nbsp; ${escapeHtml(tripInfo.start_date)} → ${escapeHtml(tripInfo.end_date)}
              </div>
            </div>
          </div>
          <div class="ts-summary-grid">
            <div class="ts-summary-section">
              <div class="ts-summary-label">✈️ Flight</div>
              <div class="ts-summary-value">${escapeHtml(type)} · ${escapeHtml(cls)} · ${escapeHtml(flightPrefs.currency)}</div>
              <div class="ts-summary-value">${escapeHtml(paxParts.join(', '))}</div>
            </div>
            <div class="ts-summary-section">
              <div class="ts-summary-label">🎒 Style & Budget</div>
              <div>${pills([travelPrefs.travel_style, travelPrefs.budget])}</div>
            </div>
            <div class="ts-summary-section">
              <div class="ts-summary-label">🏖️ Interests</div>
              <div>${pills(travelPrefs.interests)}</div>
            </div>
            <div class="ts-summary-section">
              <div class="ts-summary-label">🏨 Hotel</div>
              <div>${pills(travelPrefs.hotel_preference)}</div>
            </div>
            <div class="ts-summary-section">
              <div class="ts-summary-label">🍜 Food & Diet</div>
              <div>${pills([...travelPrefs.diet, ...travelPrefs.food_preference])}</div>
            </div>
            <div class="ts-summary-section">
              <div class="ts-summary-label">👤 Traveling as</div>
              <div>${pills(travelPrefs.special_requirements)}</div>
            </div>
          </div>
          <div class="ts-summary-footer">
            <span class="ts-dots"><span></span><span></span><span></span></span>
            <span class="ts-loading-label">Searching flights, places, and building your plan…</span>
          </div>
        </div>
        <div class="msg-footer">
          <div class="msg-footer-avatar">🤖</div>
          <span class="msg-footer-time">${formatLocalTime(new Date().toISOString())}</span>
        </div>
      </div>
    </div>`;

  const container = document.getElementById('travel-messages');
  if (!container) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'ts-card-wrapper ts-summary-wrapper';
  wrapper.innerHTML = html;
  container.appendChild(wrapper);
  scrollToBottom('travel-messages');
}

//  Persistent Summary Card (stays in chat after plan is done)

function persistSummaryCard(tripInfo, flightPrefs, travelPrefs, isRestored = false) {

  // If restoring from DB (page reload), render fresh at top before first msg
  if (isRestored) {
    document.querySelectorAll('.ts-summary-wrapper').forEach(el => el.remove());

    const cls = { 1: 'Economy', 2: 'Prem. Economy', 3: 'Business', 4: 'First' }[flightPrefs.travel_class] || 'Economy';
    const type = flightPrefs.type === '2' ? 'One-way' : 'Round Trip';
    const paxParts = [];
    if (flightPrefs.adults) paxParts.push(`${flightPrefs.adults} adult${flightPrefs.adults !== 1 ? 's' : ''}`);
    if (flightPrefs.children) paxParts.push(`${flightPrefs.children} child${flightPrefs.children !== 1 ? 'ren' : ''}`);
    if (flightPrefs.infants_in_seat) paxParts.push(`${flightPrefs.infants_in_seat} infant(seat)`);
    if (flightPrefs.infants_on_lap) paxParts.push(`${flightPrefs.infants_on_lap} infant(lap)`);

    const pills = (arr) => (arr || []).map(v =>
      `<span class="ts-summary-pill">${escapeHtml(v)}</span>`
    ).join('');

    const html = `
      <div class="msg-row assistant ts-summary-msg-row">
        <div class="msg-body">
          <div class="ts-summary-card ts-summary-static">
            <div class="ts-summary-header">
              <span class="ts-summary-icon">🗺️</span>
              <div>
                <div class="ts-summary-title">Trip Summary</div>
                <div class="ts-summary-route">
                  ${escapeHtml(tripInfo.origin_iata || '')} → ${escapeHtml(tripInfo.destination_iata || '')}
                  &nbsp;·&nbsp; ${escapeHtml(tripInfo.start_date || '')} → ${escapeHtml(tripInfo.end_date || '')}
                </div>
              </div>
              <span class="ts-summary-done-badge">✅ Planned</span>
            </div>
            <div class="ts-summary-grid">
              <div class="ts-summary-section">
                <div class="ts-summary-label">✈️ Flight</div>
                <div class="ts-summary-value">${escapeHtml(type)} · ${escapeHtml(cls)} · ${escapeHtml(flightPrefs.currency || 'INR')}</div>
                <div class="ts-summary-value">${escapeHtml(paxParts.join(', '))}</div>
              </div>
              <div class="ts-summary-section">
                <div class="ts-summary-label">🎒 Style & Budget</div>
                <div>${pills([travelPrefs.travel_style, travelPrefs.budget])}</div>
              </div>
              <div class="ts-summary-section">
                <div class="ts-summary-label">🏖️ Interests</div>
                <div>${pills(travelPrefs.interests)}</div>
              </div>
              <div class="ts-summary-section">
                <div class="ts-summary-label">🏨 Hotel</div>
                <div>${pills(travelPrefs.hotel_preference)}</div>
              </div>
              <div class="ts-summary-section">
                <div class="ts-summary-label">🍜 Food & Diet</div>
                <div>${pills([...(travelPrefs.diet || []), ...(travelPrefs.food_preference || [])])}</div>
              </div>
              <div class="ts-summary-section">
                <div class="ts-summary-label">👤 Traveling as</div>
                <div>${pills(travelPrefs.special_requirements)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    const container = document.getElementById('travel-messages');
    if (!container) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'ts-card-wrapper ts-summary-wrapper ts-summary-persistent';
    wrapper.innerHTML = html;
    const firstMsg = container.querySelector('.msg-row');
    if (firstMsg) container.insertBefore(wrapper, firstMsg);
    else container.appendChild(wrapper);
    return;
  }

  // Live generation — update the existing animated summary card IN PLACE
  const existingCard = document.querySelector('.ts-summary-wrapper .ts-summary-card');
  if (!existingCard) return;

  // Swap border color to "planned" green
  existingCard.classList.add('ts-summary-static');

  // Update header — add the ✅ Planned badge and change title
  const titleEl = existingCard.querySelector('.ts-summary-title');
  if (titleEl) titleEl.textContent = 'Trip Summary';

  // Add the done badge next to the header content if not already there
  const headerEl = existingCard.querySelector('.ts-summary-header');
  if (headerEl && !headerEl.querySelector('.ts-summary-done-badge')) {
    const badge = document.createElement('span');
    badge.className = 'ts-summary-done-badge';
    badge.textContent = '✅ Planned';
    headerEl.appendChild(badge);
  }

  // Replace the animated footer with nothing (remove it)
  const footer = existingCard.querySelector('.ts-summary-footer');
  if (footer) footer.remove();
}


//  Artifacts — PDF + Sources panels

// Global artifact panel state

const ArtifactPanel = {
  open: false,
  type: null,    // 'pdf' | 'sources'
  sourceId: null,
  threadId: null,
  _pdfBlob: null,
};

function appendMessageWithArtifacts(containerId, content, createdAt, sourceId, threadId, prefetchedPrefs, assistantChatId) {
  const container = document.getElementById(containerId);
  const safeId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const row = document.createElement('div');
  row.className = 'msg-row assistant';

  // Store assistant_chat_id on the row for artifact lookups
  if (assistantChatId) row.dataset.assistantChatId = assistantChatId;

  const bubbleContent = marked.parse(content);

  // Use assistantChatId-based endpoints when available, fall back to sourceId
  const pdfEndpoint = assistantChatId
    ? `/api/pdf/by-message/${assistantChatId}`
    : `/api/export/pdf-from-source/${sourceId}`;
  const sourcesEndpoint = assistantChatId
    ? `/api/sources/by-message/${assistantChatId}`
    : `/api/sources/${sourceId}`;
  const summaryThreadId = threadId;

  const actionsHtml = `
    <div class="msg-actions" id="actions-${safeId}">
      <button class="msg-action-btn" title="Copy to clipboard" onclick="copyMsgContent('${safeId}')">
        <i class="bi bi-clipboard"></i> Copy
      </button>
      <button class="msg-action-btn" title="Download as PDF"
              onclick="downloadMsgPdfByEndpoint('${pdfEndpoint}', '${safeId}')">
        <i class="bi bi-file-earmark-pdf"></i> PDF
      </button>
      <button class="msg-action-btn" title="Add to My Documents" onclick="addMsgToDocuments('${safeId}')">
        <i class="bi bi-folder-plus"></i> Add to Docs
      </button>
    </div>`;

  // Build artifact chips — always keyed by assistantChatId when present
  const artifactsHtml = (sourceId || assistantChatId) ? `
    <div class="ts-artifacts-row">
      <div class="ts-artifact-chip ts-artifact-pdf"
           onclick="openArtifactPanelByMessage('pdf', '${pdfEndpoint}', ${jsArg(sourceId)}, ${jsArg(threadId)}, ${jsArg(assistantChatId)})"
           title="Click to preview PDF">
        <div class="ts-artifact-icon"><i class="bi bi-file-earmark-pdf-fill"></i></div>
        <div class="ts-artifact-meta">
          <div class="ts-artifact-name">Trip Plan PDF</div>
          <div class="ts-artifact-sub">Click to preview</div>
        </div>
        <div class="ts-artifact-actions">
          <button class="ts-artifact-dl-btn" title="Download PDF"
            onclick="event.stopPropagation(); downloadMsgPdfByEndpoint('${pdfEndpoint}', null)">
            <i class="bi bi-download"></i>
          </button>
        </div>
      </div>
      <div class="ts-artifact-chip ts-artifact-sources"
           onclick="openArtifactPanelByMessage('sources', '${sourcesEndpoint}', ${jsArg(sourceId)}, ${jsArg(threadId)}, ${jsArg(assistantChatId)})"
           title="Click to view sources">
        <div class="ts-artifact-icon"><i class="bi bi-globe2"></i></div>
        <div class="ts-artifact-meta">
          <div class="ts-artifact-name">Flight & Destination Sources</div>
          <div class="ts-artifact-sub">Click to preview</div>
        </div>
      </div>
      <div class="ts-artifact-chip ts-artifact-summary"
           onclick="openArtifactPanelByMessage('summary', null, ${jsArg(sourceId)}, ${jsArg(summaryThreadId)}, ${jsArg(assistantChatId)})"
           title="Click to view trip summary">
        <div class="ts-artifact-icon"><i class="bi bi-map-fill"></i></div>
        <div class="ts-artifact-meta">
          <div class="ts-artifact-name">Trip Summary</div>
          <div class="ts-artifact-sub">Click to preview</div>
        </div>
      </div>
    </div>` : '';

  row.innerHTML = `
    <div class="msg-body">
      <div class="msg-bubble assistant" id="${safeId}" data-raw="${escapeAttr(content)}">${bubbleContent}</div>
      <div class="msg-footer">
        <div class="msg-footer-avatar">🤖</div>
        <span class="msg-footer-time">${formatLocalTime(createdAt)}</span>
        <div class="msg-footer-spacer"></div>
        ${actionsHtml}
      </div>
      ${artifactsHtml}
    </div>`;
  container.appendChild(row);
}

// Per-message artifact panel (uses assistantChatId-based endpoints)
async function openArtifactPanelByMessage(type, endpoint, sourceId, threadId, assistantChatId) {
  ArtifactPanel.type = type;
  ArtifactPanel.sourceId = sourceId;
  ArtifactPanel.threadId = threadId;
  ArtifactPanel.assistantChatId = assistantChatId;

  const panel = document.getElementById('artifact-panel');
  const overlay = document.getElementById('artifact-overlay');
  if (!panel) return;

  panel.classList.add('open');
  if (overlay) overlay.classList.add('show');
  ArtifactPanel.open = true;
  document.getElementById('app-shell').classList.add('artifact-open');

  if (type === 'pdf') {
    await _loadArtifactPdfByEndpoint(endpoint, assistantChatId, threadId);
  } else if (type === 'summary') {
    // Use assistantChatId-based summary endpoint when available
    const summaryEndpoint = assistantChatId
      ? `/api/summary/by-message/${assistantChatId}`
      : null;
    await _loadArtifactSummaryFlex(summaryEndpoint, threadId, assistantChatId);
  } else {
    await _loadArtifactSourcesByEndpoint(endpoint, assistantChatId, threadId);
  }
}

async function _loadArtifactPdfByEndpoint(pdfEndpoint, assistantChatId, threadId) {
  const panel = document.getElementById('artifact-panel');

  // Revoke any previously created blob URL to avoid memory leaks
  if (ArtifactPanel._pdfObjectUrl) {
    URL.revokeObjectURL(ArtifactPanel._pdfObjectUrl);
    ArtifactPanel._pdfObjectUrl = null;
  }

  const _renderHeader = () => `
    <div class="artifact-panel-header">
      <div class="artifact-panel-title">
        <i class="bi bi-file-earmark-pdf-fill" style="flex-shrink:0;color:#f87171;"></i>
        <span>Trip Plan PDF</span>
      </div>
      <div class="artifact-panel-actions">
        <button class="artifact-btn" onclick="downloadMsgPdfByEndpoint('${pdfEndpoint}', null)" title="Download PDF">
          <i class="bi bi-download"></i> Download
        </button>
        <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>`;

  panel.innerHTML = _renderHeader() + `
    <div class="artifact-panel-body" style="align-items:center;justify-content:center;">
      <div class="artifact-loading">
        <div class="ts-dots"><span></span><span></span><span></span></div>
        <span>Generating PDF…</span>
      </div>
    </div>`;

  try {
    const pdfRes = await fetch(pdfEndpoint);
    if (!pdfRes.ok) {
      const errText = await pdfRes.text().catch(() => '');
      throw new Error(`Server returned ${pdfRes.status}${errText ? ': ' + errText.slice(0, 120) : ''}`);
    }
    const blob = await pdfRes.blob();
    if (!blob || blob.size === 0) throw new Error('Empty PDF received');
    ArtifactPanel._pdfBlob = blob;
    const objectUrl = URL.createObjectURL(blob);
    ArtifactPanel._pdfObjectUrl = objectUrl;

    panel.innerHTML = _renderHeader() + `
      <div class="artifact-panel-body artifact-pdf-body" style="padding:0;overflow:hidden;">
        <iframe
          id="artifact-pdf-iframe"
          src="${objectUrl}"
          style="width:100%;height:100%;border:none;display:block;flex:1;"
          title="Trip Plan PDF"
        ></iframe>
      </div>`;
  } catch (e) {
    console.error('PDF preview error:', e);
    panel.innerHTML = _renderHeader() + `
      <div class="artifact-panel-body" style="align-items:center;justify-content:center;">
        <div class="artifact-error">
          <i class="bi bi-exclamation-triangle" style="font-size:1.8rem;margin-bottom:8px;"></i>
          <span>Could not preview PDF.<br><small style="color:#94a3b8;">${escapeHtml(e.message)}</small></span>
          <button class="ts-btn ts-btn-primary" style="margin-top:14px;"
                  onclick="downloadMsgPdfByEndpoint('${pdfEndpoint}', null)">
            <i class="bi bi-download"></i> Download PDF instead
          </button>
        </div>
      </div>`;
  }
}

async function _loadArtifactSourcesByEndpoint(sourcesEndpoint, assistantChatId, threadId) {
  const panel = document.getElementById('artifact-panel');
  panel.innerHTML = `
    <div class="artifact-panel-header">
      <div class="artifact-panel-title"><i class="bi bi-globe2"></i> Sources</div>
      <div class="artifact-panel-actions">
        <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>
    <div class="artifact-panel-body">
      <div class="artifact-loading">
        <div class="ts-dots"><span></span><span></span><span></span></div>
        <span>Loading sources…</span>
      </div>
    </div>`;

  try {
    const res = await fetch(sourcesEndpoint);
    if (!res.ok) throw new Error('Sources not found');
    const data = await res.json();

    const flightHtml = data.flight_results_text
      ? `<div class="artifact-section">
           <div class="artifact-section-title">✈️ Flight Results</div>
           <pre class="artifact-flight-pre">${escapeHtml(data.flight_results_text)}</pre>
         </div>`
      : '';

    const urlsData = data.destination_urls || {};
    const sections = { places: '📍 Places to Visit', hotels: '🏨 Hotels', food: '🍜 Food & Restaurants' };
    let urlsHtml = '';

    for (const [key, label] of Object.entries(sections)) {
      const urls = urlsData[key] || [];
      if (!urls.length) continue;
      urlsHtml += `<div class="artifact-section">
        <div class="artifact-section-title">${label}</div>
        <ul class="artifact-url-list">
          ${urls.map(u => `<li><a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" class="artifact-url-link">
            <i class="bi bi-box-arrow-up-right"></i> ${escapeHtml(u.replace(/^https?:\/\//, '').split('/')[0])}
          </a></li>`).join('')}
        </ul>
      </div>`;
    }

    panel.innerHTML = `
      <div class="artifact-panel-header">
        <div class="artifact-panel-title"><i class="bi bi-globe2"></i> Sources</div>
        <div class="artifact-panel-actions">
          <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>
      <div class="artifact-panel-body artifact-sources-body">
        ${flightHtml}
        ${urlsHtml || '<div class="artifact-empty">No source URLs found.</div>'}
      </div>`;
  } catch (e) {
    panel.querySelector('.artifact-panel-body').innerHTML =
      `<div class="artifact-error"><i class="bi bi-exclamation-triangle"></i> Failed to load sources.</div>`;
  }
}

async function _loadArtifactSummaryFlex(summaryEndpoint, threadId, assistantChatId) {
  const panel = document.getElementById('artifact-panel');
  panel.innerHTML = `
    <div class="artifact-panel-header">
      <div class="artifact-panel-title"><i class="bi bi-map-fill"></i> Trip Summary</div>
      <div class="artifact-panel-actions">
        <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>
    <div class="artifact-panel-body">
      <div class="artifact-loading">
        <div class="ts-dots"><span></span><span></span><span></span></div>
        <span>Loading trip summary…</span>
      </div>
    </div>`;

  try {
    // Prefer assistantChatId endpoint, fall back to thread endpoint
    const endpoint = summaryEndpoint || `/api/threads/${threadId}/summary`;
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error('Summary not found');
    const data = await res.json();

    const t = data.trip_info || {};
    const f = data.flight_prefs || {};
    const tp = data.travel_prefs || {};

    // Fetch destination image from Pixabay using trip_summary_id (from the fetched summary)
    const destCity = t.destination_city || '';
    const summaryDataId = data.id || null;
    let heroImgHtml = '';
    if (destCity) {
      try {
        const imgParam = summaryDataId
          ? `trip_summary_id=${summaryDataId}`
          : `city=${encodeURIComponent(destCity)}`;
        const imgRes = await fetch(`/api/city-image?${imgParam}`);
        const imgData = await imgRes.json();
        if (imgData.url) {
          heroImgHtml = `
            <div class="artifact-summary-hero-wrap">
              <img src="${escapeHtml(imgData.url)}"
                   alt="${escapeHtml(destCity)}"
                   class="artifact-summary-hero-img"
                   onerror="this.parentElement.style.display='none'">
              <div class="artifact-summary-hero-overlay">
                <b><span class="artifact-summary-hero-city">${escapeHtml(destCity)}</span></b>
              </div>
            </div>`;
        }
      } catch (_) { }
    }

    const cls = { 1: 'Economy', 2: 'Prem. Economy', 3: 'Business', 4: 'First' }[f.travel_class] || 'Economy';
    const type = f.type === '2' ? 'One-way' : 'Round Trip';

    const paxParts = [];
    if (f.adults) paxParts.push(`${f.adults} adult${f.adults !== 1 ? 's' : ''}`);
    if (f.children) paxParts.push(`${f.children} child${f.children !== 1 ? 'ren' : ''}`);
    if (f.infants_in_seat) paxParts.push(`${f.infants_in_seat} infant(seat)`);
    if (f.infants_on_lap) paxParts.push(`${f.infants_on_lap} infant(lap)`);

    const pills = (arr) => (arr || []).map(v =>
      `<span class="artifact-summary-pill">${escapeHtml(v)}</span>`
    ).join('');

    const rows = [
      { label: '✈️ Route', value: `${escapeHtml(t.origin_city || '')} (${escapeHtml(t.origin_iata || '')}) → ${escapeHtml(t.destination_city || '')} (${escapeHtml(t.destination_iata || '')})` },
      { label: '📅 Dates', value: `${escapeHtml(t.start_date || '')} → ${escapeHtml(t.end_date || '')}` },
      { label: '🎫 Trip Type', value: escapeHtml(type) },
      { label: '💺 Class', value: escapeHtml(cls) },
      { label: '💱 Currency', value: escapeHtml(f.currency || 'INR') },
      { label: '👥 Passengers', value: escapeHtml(paxParts.join(', ') || '1 adult') },
      { label: '🎒 Travel Style', value: escapeHtml(tp.travel_style || '') },
      { label: '💰 Budget', value: escapeHtml(tp.budget || '') },
    ].map(row => `
      <div class="artifact-summary-row">
        <span class="artifact-summary-label">${row.label}</span>
        <span class="artifact-summary-value">${row.value}</span>
      </div>`).join('');

    const chipSections = [
      { label: '🏖️ Interests', items: tp.interests },
      { label: '🏨 Hotel', items: tp.hotel_preference },
      { label: '🍜 Food & Diet', items: [...(tp.diet || []), ...(tp.food_preference || [])] },
      { label: '👤 Traveling As', items: tp.special_requirements },
    ].map(sec => sec.items && sec.items.length ? `
      <div class="artifact-section">
        <div class="artifact-section-title">${sec.label}</div>
        <div class="artifact-summary-pills">${pills(sec.items)}</div>
      </div>` : ''
    ).join('');

    panel.innerHTML = `
      <div class="artifact-panel-header">
        <div class="artifact-panel-title"><i class="bi bi-map-fill"></i> Trip Summary</div>
        <div class="artifact-panel-actions">
          <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>
      <div class="artifact-panel-body artifact-sources-body">
        ${heroImgHtml}
        <div class="artifact-section">
          <div class="artifact-section-title">📍 Trip Details</div>
          <div class="artifact-summary-details">${rows}</div>
        </div>
        ${chipSections}
      </div>`;

  } catch (e) {
    panel.querySelector('.artifact-panel-body').innerHTML =
      `<div class="artifact-error"><i class="bi bi-exclamation-triangle"></i> Failed to load trip summary.</div>`;
  }
}

async function downloadMsgPdfByEndpoint(endpoint, safeId) {
  if (safeId) _flashActionBtn(safeId, 'pdf', '⏳ Generating…');
  try {
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error('Failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trip-plan-${Date.now()}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (safeId) _flashActionBtn(safeId, 'pdf', '✓ Downloaded!');
  } catch (e) {
    console.error('PDF download error:', e);
    if (safeId) _flashActionBtn(safeId, 'pdf', '✗ Failed');
  }
}

async function openArtifactPanel(type, sourceId, threadId) {
  ArtifactPanel.type = type;
  ArtifactPanel.sourceId = sourceId;
  ArtifactPanel.threadId = threadId;

  const panel = document.getElementById('artifact-panel');
  const overlay = document.getElementById('artifact-overlay');
  if (!panel) return;

  panel.classList.add('open');
  if (overlay) overlay.classList.add('show');
  ArtifactPanel.open = true;

  // Adjust chat layout
  document.getElementById('app-shell').classList.add('artifact-open');

  if (type === 'pdf') {
    await _loadArtifactPdf(sourceId, threadId);
  } else if (type === 'summary') {
    await _loadArtifactSummary(sourceId, threadId);
  } else {
    await _loadArtifactSources(sourceId);
  }
}

function closeArtifactPanel() {
  const panel = document.getElementById('artifact-panel');
  const overlay = document.getElementById('artifact-overlay');
  if (panel) panel.classList.remove('open');
  if (overlay) overlay.classList.remove('show');
  document.getElementById('app-shell').classList.remove('artifact-open');
  ArtifactPanel.open = false;
  ArtifactPanel._pdfBlob = null;
  if (ArtifactPanel._pdfObjectUrl) {
    URL.revokeObjectURL(ArtifactPanel._pdfObjectUrl);
    ArtifactPanel._pdfObjectUrl = null;
  }
}

async function _loadArtifactPdf(sourceId, threadId) {
  const panel = document.getElementById('artifact-panel');

  const headerHtml = `
    <div class="artifact-panel-header">
      <div class="artifact-panel-title"><i class="bi bi-file-earmark-pdf-fill"></i> Trip Plan PDF</div>
      <div class="artifact-panel-actions">
        <button class="artifact-btn" onclick="downloadArtifactPdf(${jsArg(sourceId)}, ${jsArg(threadId)})" title="Download PDF">
          <i class="bi bi-download"></i> Download
        </button>
        <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>`;

  panel.innerHTML = headerHtml + `
    <div class="artifact-panel-body">
      <div class="artifact-loading">
        <div class="ts-dots"><span></span><span></span><span></span></div>
        <span>Generating PDF preview…</span>
      </div>
    </div>`;

  try {
    const pdfRes = await fetch(`/api/export/pdf-from-source/${sourceId}`);
    if (!pdfRes.ok) {
      const errText = await pdfRes.text();
      throw new Error(`PDF generation failed: ${pdfRes.status} — ${errText}`);
    }

    const blob = await pdfRes.blob();
    ArtifactPanel._pdfBlob = blob;
    const url = URL.createObjectURL(blob);

    panel.innerHTML = headerHtml + `
      <div class="artifact-panel-body artifact-pdf-body">
        <iframe src="${url}" class="artifact-pdf-iframe" title="Trip Plan PDF"></iframe>
      </div>`;

  } catch (e) {
    console.error('PDF preview error:', e);
    panel.innerHTML = headerHtml + `
      <div class="artifact-panel-body">
        <div class="artifact-error">
          <i class="bi bi-exclamation-triangle"></i>
          <span>Failed to load PDF preview.<br><small>${escapeHtml(e.message)}</small></span>
          <button class="ts-btn ts-btn-primary" style="margin-top:8px;"
                  onclick="downloadArtifactPdf(${jsArg(sourceId)}, ${jsArg(threadId)})">
            <i class="bi bi-download"></i> Download instead
          </button>
        </div>
      </div>`;
  }
}

async function _loadArtifactSources(sourceId) {
  const panel = document.getElementById('artifact-panel');
  panel.innerHTML = `
    <div class="artifact-panel-header">
      <div class="artifact-panel-title"><i class="bi bi-globe2"></i> Sources</div>
      <div class="artifact-panel-actions">
        <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>
    <div class="artifact-panel-body">
      <div class="artifact-loading">
        <div class="ts-dots"><span></span><span></span><span></span></div>
        <span>Loading sources…</span>
      </div>
    </div>`;

  try {
    const res = await fetch(`/api/sources/${sourceId}`);
    if (!res.ok) throw new Error('Sources not found');
    const data = await res.json();

    const flightHtml = data.flight_results_text
      ? `<div class="artifact-section">
           <div class="artifact-section-title">✈️ Flight Results</div>
           <pre class="artifact-flight-pre">${escapeHtml(data.flight_results_text)}</pre>
         </div>`
      : '';

    const urlsData = data.destination_urls || {};
    const sections = { places: '📍 Places to Visit', hotels: '🏨 Hotels', food: '🍜 Food & Restaurants' };
    let urlsHtml = '';

    for (const [key, label] of Object.entries(sections)) {
      const urls = urlsData[key] || [];
      if (!urls.length) continue;
      urlsHtml += `<div class="artifact-section">
        <div class="artifact-section-title">${label}</div>
        <ul class="artifact-url-list">
          ${urls.map(u => `<li><a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" class="artifact-url-link">
            <i class="bi bi-box-arrow-up-right"></i> ${escapeHtml(u.replace(/^https?:\/\//, '').split('/')[0])}
          </a></li>`).join('')}
        </ul>
      </div>`;
    }

    panel.innerHTML = `
      <div class="artifact-panel-header">
        <div class="artifact-panel-title"><i class="bi bi-globe2"></i> Sources</div>
        <div class="artifact-panel-actions">
          <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>
      <div class="artifact-panel-body artifact-sources-body">
        ${flightHtml}
        ${urlsHtml || '<div class="artifact-empty">No source URLs found.</div>'}
      </div>`;
  } catch (e) {
    panel.querySelector('.artifact-panel-body').innerHTML =
      `<div class="artifact-error"><i class="bi bi-exclamation-triangle"></i> Failed to load sources.</div>`;
  }
}


async function _loadArtifactSummary(sourceId, threadId) {
  const panel = document.getElementById('artifact-panel');
  panel.innerHTML = `
    <div class="artifact-panel-header">
      <div class="artifact-panel-title"><i class="bi bi-map-fill"></i> Trip Summary</div>
      <div class="artifact-panel-actions">
        <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>
    <div class="artifact-panel-body">
      <div class="artifact-loading">
        <div class="ts-dots"><span></span><span></span><span></span></div>
        <span>Loading trip summary…</span>
      </div>
    </div>`;

  try {
    const res = await fetch(`/api/threads/${threadId}/summary`);
    if (!res.ok) throw new Error('Summary not found');
    const data = await res.json();

    const t = data.trip_info || {};
    const f = data.flight_prefs || {};
    const tp = data.travel_prefs || {};

    const cls = { 1: 'Economy', 2: 'Prem. Economy', 3: 'Business', 4: 'First' }[f.travel_class] || 'Economy';
    const type = f.type === '2' ? 'One-way' : 'Round Trip';

    const paxParts = [];
    if (f.adults) paxParts.push(`${f.adults} adult${f.adults !== 1 ? 's' : ''}`);
    if (f.children) paxParts.push(`${f.children} child${f.children !== 1 ? 'ren' : ''}`);
    if (f.infants_in_seat) paxParts.push(`${f.infants_in_seat} infant(seat)`);
    if (f.infants_on_lap) paxParts.push(`${f.infants_on_lap} infant(lap)`);

    const pills = (arr) => (arr || []).map(v =>
      `<span class="artifact-summary-pill">${escapeHtml(v)}</span>`
    ).join('');

    const rows = [
      { label: '✈️ Route', value: `${escapeHtml(t.origin_city || '')}  (${escapeHtml(t.origin_iata || '')}) → ${escapeHtml(t.destination_city || '')} (${escapeHtml(t.destination_iata || '')})` },
      { label: '📅 Dates', value: `${escapeHtml(t.start_date || '')} → ${escapeHtml(t.end_date || '')}` },
      { label: '🎫 Trip Type', value: escapeHtml(type) },
      { label: '💺 Class', value: escapeHtml(cls) },
      { label: '💱 Currency', value: escapeHtml(f.currency || 'INR') },
      { label: '👥 Passengers', value: escapeHtml(paxParts.join(', ') || '1 adult') },
      { label: '🎒 Travel Style', value: escapeHtml(tp.travel_style || '') },
      { label: '💰 Budget Type', value: escapeHtml(tp.budget || '') },
    ].map(row => `
      <div class="artifact-summary-row">
        <span class="artifact-summary-label">${row.label}</span>
        <span class="artifact-summary-value">${row.value}</span>
      </div>`).join('');

    const chipSections = [
      { label: '🏖️ Interests', items: tp.interests },
      { label: '🏨 Hotel', items: tp.hotel_preference },
      { label: '🍜 Food & Diet', items: [...(tp.diet || []), ...(tp.food_preference || [])] },
      { label: '👤 Traveling As', items: tp.special_requirements },
    ].map(sec => sec.items && sec.items.length ? `
      <div class="artifact-section">
        <div class="artifact-section-title">${sec.label}</div>
        <div class="artifact-summary-pills">${pills(sec.items)}</div>
      </div>` : ''
    ).join('');

    panel.innerHTML = `
      <div class="artifact-panel-header">
        <div class="artifact-panel-title"><i class="bi bi-map-fill"></i> Trip Summary</div>
        <div class="artifact-panel-actions">
          <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>
      <div class="artifact-panel-body artifact-sources-body">
        <div class="artifact-section">
          <div class="artifact-section-title">📍 Trip Details</div>
          <div class="artifact-summary-details">${rows}</div>
        </div>
        ${chipSections}
      </div>`;

  } catch (e) {
    panel.querySelector('.artifact-panel-body').innerHTML =
      `<div class="artifact-error"><i class="bi bi-exclamation-triangle"></i> Failed to load trip summary.</div>`;
  }
}


async function downloadArtifactPdf(sourceId, threadId) {
  try {
    const res = await fetch(`/api/export/pdf-from-source/${sourceId}`);
    if (!res.ok) throw new Error('Failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trip-plan-${threadId}-${Date.now()}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    console.error('PDF download failed', e);
  }
}

//  RAG Send

// RAG File Attachment State 
const RagAttach = {
  files: [],   // [{filename, db_id, file_url, has_preview, content_type}]
  pending: [],   // File objects waiting to upload
  uploading: false,
};

async function onRagFileSelect(input) {
  const chosen = Array.from(input.files);
  input.value = '';

  const total = RagAttach.files.length + chosen.length;
  if (total > 3) {
    alert(`You can attach up to 3 files per message. You already have ${RagAttach.files.length} attached.`);
    return;
  }

  // Validate extensions
  const allowed = ['.pdf', '.docx', '.txt', '.md'];
  for (const f of chosen) {
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      alert(`${f.name} is not supported. Please use PDF, DOCX, TXT, or MD files.`);
      return;
    }
  }

  // Show uploading chips
  chosen.forEach(f => _addPendingChip(f.name));

  // Upload
  RagAttach.uploading = true;
  setRagUploadLock(true);
  const formData = new FormData();
  chosen.forEach(f => formData.append('files', f));

  try {
    const res = await fetch('/api/rag/upload-attach', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json();
      _clearPendingChips();
      if (res.status === 409 && err.detail && err.detail.filenames) {
        showDuplicateModal(err.detail.filenames);
      } else {
        alert('Upload failed: ' + (typeof err.detail === 'string' ? err.detail : 'Unknown error'));
      }
      return;
    }
    const data = await res.json();
    data.attached.forEach(a => {
      RagAttach.files.push(a);
      _updateChipToReady(a.filename);
    });
  } catch (e) {
    alert('Upload failed. Check your connection.');
    _clearPendingChips();
  } finally {
    RagAttach.uploading = false;
    _renderAttachChips();
    setRagUploadLock(false);
  }
}

//  File card helpers 

function _fileCardIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const map = {
    pdf: { cls: 'pdf', icon: 'bi-file-earmark-pdf-fill', label: 'PDF' },
    docx: { cls: 'docx', icon: 'bi-file-earmark-word-fill', label: 'Word' },
    doc: { cls: 'docx', icon: 'bi-file-earmark-word-fill', label: 'Word' },
    txt: { cls: 'txt', icon: 'bi-file-earmark-text-fill', label: 'Text' },
    md: { cls: 'md', icon: 'bi-file-earmark-code-fill', label: 'MD' },
  };
  return map[ext] || { cls: 'other', icon: 'bi-file-earmark-fill', label: ext.toUpperCase() };
}

function _buildFileCard({ filename, uploading = false, removable = false, idx = null, clickable = false, db_id = null }) {
  const { cls, icon, label } = _fileCardIcon(filename);
  const card = document.createElement('div');
  card.className = 'file-card' + (uploading ? ' uploading' : '') + (clickable ? ' clickable' : '');
  card.dataset.filename = filename;
  card.innerHTML = `
    <div class="file-card-icon ${cls}"><i class="bi ${icon}"></i></div>
    <div class="file-card-meta">
      <div class="file-card-name" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>
      <div class="file-card-type">${uploading ? 'Uploading…' : label}</div>
    </div>
    ${uploading ? '<div class="file-card-upload-bar"></div>' : ''}
    ${removable ? `<button class="file-card-remove" title="Remove" onclick="removeRagAttach(${idx})"><i class="bi bi-x"></i></button>` : ''}
  `;
  if (clickable && db_id) {
    card.onclick = () => previewDocument(db_id, filename);
  }
  return card;
}

function _addPendingChip(filename) {
  const chipsEl = document.getElementById('rag-attach-chips');
  if (!chipsEl) return;
  chipsEl.style.display = 'flex';
  chipsEl.appendChild(_buildFileCard({ filename, uploading: true }));
}

function _updateChipToReady(filename) {
  const chipsEl = document.getElementById('rag-attach-chips');
  if (!chipsEl) return;
  const old = chipsEl.querySelector(`.file-card[data-filename="${CSS.escape(filename)}"]`);
  if (old) old.remove();
  // Will be re-rendered by _renderAttachChips after all uploads done
}

function _clearPendingChips() {
  const chipsEl = document.getElementById('rag-attach-chips');
  if (!chipsEl) return;
  chipsEl.querySelectorAll('.file-card.uploading').forEach(c => c.remove());
  if (!chipsEl.children.length) chipsEl.style.display = 'none';
}

function _renderAttachChips() {
  const chipsEl = document.getElementById('rag-attach-chips');
  if (!chipsEl) return;
  chipsEl.innerHTML = '';
  if (!RagAttach.files.length) { chipsEl.style.display = 'none'; return; }
  chipsEl.style.display = 'flex';
  RagAttach.files.forEach((f, idx) => {
    chipsEl.appendChild(_buildFileCard({ filename: f.filename, removable: true, idx }));
  });
}

function removeRagAttach(idx) {
  const f = RagAttach.files[idx];
  if (!f || !f.db_id) return;
  // Reuse the same confirmation modal + delete flow as the My Docs tab
  confirmDeleteDocument(f.db_id);
}

async function sendRag() {
  if (App.sending) return;
  if (RagAttach.uploading) return;
  const input = document.getElementById('rag-input');
  const query = input.value.trim();
  if (!query) return;

  App.sending = true;
  input.value = '';
  autoGrow(input);
  document.getElementById('rag-send-btn').disabled = true;

  // Snapshot attached files, then clear state
  const attachedFiles = [...RagAttach.files];
  RagAttach.files = [];
  _renderAttachChips();

  hideWelcome('rag-welcome');
  // Pass attached files to message renderer
  appendRagUserMessage('rag-messages', query, attachedFiles, new Date().toISOString());
  const loadingId = appendLoading('rag-messages');
  scrollToBottom('rag-messages');
  document.getElementById('rag-source-badge').innerHTML = '';

  const requestThreadId = App.currentRagThreadId;
  const ragThreadKey = requestThreadId ? String(requestThreadId) : socket.id;
  socket.emit('join_trip', { thread_id: ragThreadKey });

  try {
    const res = await fetch('/api/rag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        thread_id: requestThreadId,
        attached_files: attachedFiles,
        sid: socket.id,
      }),
    });
    const data = await res.json();
    removeLoading(loadingId);
    socket.emit('leave_trip', { thread_id: ragThreadKey });

    if (
      App.currentTab !== 'rag' ||
      App.currentRagThreadId !== requestThreadId
    ) {
      clearQueryParam();
      App.sending = false;
      document.getElementById('rag-send-btn').disabled = false;
      return;
    }

    clearQueryParam();

    if (res.ok) {
      if (data.is_error) {
        // Retrieval error — show error bubble with only copy action, no artifacts
        appendRagErrorMessage('rag-messages', data.answer, data.assistant_created_at);
      } else {
        appendRagAssistantMessage(
            'rag-messages',
            data.answer,
            data.source,
            data.assistant_created_at,
            data.documents_used || [],
            data.assistant_chat_id,
            data.web_urls || []
        );
      }
      if (data.thread_id && !App.currentRagThreadId) {
        App.currentRagThreadId = data.thread_id;
        await loadThreads();
      } else if (data.thread_id && data.thread_title) {
        const t = App.threads.find(t => t.id === data.thread_id);
        if (t) t.title = data.thread_title;
        renderThreadList();
      }
      const badge = document.getElementById('rag-source-badge');
      const sourceLabelMap = {
        kb:     '<span class="source-badge source-rag"><i class="bi bi-database-fill"></i> Hybrid Search</span>',
        web:    '<span class="source-badge source-web"><i class="bi bi-globe2"></i> Web Search</span>',
        direct: '<span class="source-badge source-llm"><i class="bi bi-cpu-fill"></i> Direct LLM</span>',
      };
      badge.innerHTML = data.is_error ? '' : (sourceLabelMap[data.source] || sourceLabelMap['direct']);
      updateThreadLabel('rag');

    } else {
      appendErrorMessage('rag-messages', data.detail || 'Something went wrong. Please try again.');
    }
  } catch (e) {
    removeLoading(loadingId);
    socket.emit('leave_trip', { thread_id: ragThreadKey });
    clearQueryParam();
    appendErrorMessage('rag-messages', 'Network error. Check your connection and retry.');
  }

  scrollToBottom('rag-messages');
  App.sending = false;
  document.getElementById('rag-send-btn').disabled = false;
  input.focus();
}

function setRagQuery(text) {
  const input = document.getElementById('rag-input');
  input.value = text;
  autoGrow(input);
  input.focus();
}


//  Message Rendering

function appendRagUserMessage(containerId, text, attachedFiles, created_at) {
  const container = document.getElementById(containerId);
  const row = document.createElement('div');
  row.className = 'msg-row user';

  // File cards
  let fileCardsHtml = '';
  if (attachedFiles && attachedFiles.length) {
    const cards = attachedFiles.map(f => {
      const { cls, icon, label } = _fileCardIcon(f.filename);
      const clickAttr = f.db_id
        ? `onclick="previewDocument(${jsArg(f.db_id)}, '${escapeAttr(f.filename)}')" style="cursor:pointer;"`
        : '';
      return `
        <div class="file-card clickable" ${clickAttr} title="${escapeHtml(f.filename)}">
          <div class="file-card-icon ${cls}"><i class="bi ${icon}"></i></div>
          <div class="file-card-meta">
            <div class="file-card-name">${escapeHtml(f.filename)}</div>
            <div class="file-card-type">${label}</div>
          </div>
        </div>`;
    }).join('');
    fileCardsHtml = `<div class="msg-file-cards">${cards}</div>`;
  }

  row.innerHTML = `
    <div class="msg-body">
      ${fileCardsHtml}
      <div class="msg-bubble user">${escapeHtml(text)}</div>
      <div class="msg-time user">${formatLocalTime(created_at)}</div>
    </div>
    <div class="msg-avatar user">👤</div>`;
  container.appendChild(row);
}


function appendRagAssistantMessage(containerId, content, source, created_at, documentsUsed, assistantChatId, webUrls = []) {
  const container = document.getElementById(containerId);
  const safeId = `rag-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  if (assistantChatId) row.dataset.assistantChatId = assistantChatId;

  const _sourceBadgeMap = {
    kb:     `<span class="source-badge source-rag"><i class="bi bi-database-fill"></i> Hybrid Search</span>`,
    web:    `<span class="source-badge source-web"><i class="bi bi-globe2"></i> Web Search</span>`,
    direct: `<span class="source-badge source-llm"><i class="bi bi-cpu-fill"></i> Direct LLM</span>`,
  };
  // null source on reload — badge resolved lazily after chunk/web-url fetch
  let sourceBadgeHtml = source ? (_sourceBadgeMap[source] || '') : '';

  // Show chip when:
  // (a) fresh response with actual chunks, OR
  // (b) restored from DB with an assistantChatId (we'll check DB lazily on click)
  //     but ONLY for 'rag' source messages — llm messages never have chunks
  const hasFreshChunks = documentsUsed && documentsUsed.length > 0;
  const hasWebUrls = webUrls && webUrls.length > 0;
  const isRagSource = source === 'rag' || source === 'kb' || source === 'web';
  const showKbChip = hasFreshChunks || (source === 'kb' && !!assistantChatId);
  const showWebChip = hasWebUrls;

  const chunkCount = hasFreshChunks ? documentsUsed.length : null;
  const chipSubtitle = chunkCount !== null
    ? `${chunkCount} chunk${chunkCount !== 1 ? 's' : ''} from your documents`
    : 'From your documents';

  let webKey = '';
  if (hasWebUrls) {
    webKey = `wurl_${++_webUrlsRegistryCounter}`;
    _webUrlsRegistry.set(webKey, webUrls);
  }
  const webUrlsEncoded = hasWebUrls ? escapeAttr(JSON.stringify(webUrls)) : '[]';

  const artifactChip = (showKbChip || showWebChip) ? `
    <div class="ts-artifacts-row">
      ${showKbChip ? `
      <div class="ts-artifact-chip ts-artifact-sources"
           onclick="openRagContextArtifact('${safeId}', ${jsArg(assistantChatId || null)})"
           title="View retrieved document context">
        <div class="ts-artifact-icon"><i class="bi bi-journals"></i></div>
        <div class="ts-artifact-meta">
          <div class="ts-artifact-name">Retrieved Context</div>
          <div class="ts-artifact-sub">${chipSubtitle}</div>
        </div>
      </div>` : ''}
       ${showWebChip ? `
      <div class="ts-artifact-chip ts-artifact-sources"
           onclick="openWebSourcesFromRegistry('${webKey}')"
           title="View web sources"
           data-web-key="${webKey}">
        <div class="ts-artifact-icon"><i class="bi bi-globe2"></i></div>
        <div class="ts-artifact-meta">
          <div class="ts-artifact-name">Web Sources</div>
          <div class="ts-artifact-sub">${webUrls.length} source${webUrls.length !== 1 ? 's' : ''}</div>
        </div>
      </div>` : ''}
    </div>` : '';

  row.innerHTML = `
    <div class="msg-body">
      <div class="msg-bubble assistant" id="${safeId}"
           data-raw="${escapeAttr(content)}"
           data-docs="${escapeAttr(JSON.stringify(hasFreshChunks ? documentsUsed : []))}"
      >${marked.parse(content)}</div>
      <div class="msg-footer">
        <div class="msg-footer-avatar">🤖</div>
        <span class="msg-footer-time">${formatLocalTime(created_at)}</span>
        ${sourceBadgeHtml ? `<div class="msg-footer-dot"></div>${sourceBadgeHtml}` : ''}
      </div>
      ${artifactChip}
    </div>`;
  container.appendChild(row);
}

function appendRagErrorMessage(containerId, content, created_at) {
  const container = document.getElementById(containerId);
  const safeId = `rag-err-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const row = document.createElement('div');
  row.className = 'msg-row assistant';

  row.innerHTML = `
    <div class="msg-body">
      <div class="msg-bubble assistant" id="${safeId}"
           data-raw="${escapeAttr(content)}"
           style="border-color:rgba(248,113,113,0.25);color:#fca5a5;">
        ${marked.parse(content)}
      </div>
      <div class="msg-footer">
        <div class="msg-footer-avatar">⚠️</div>
        <span class="msg-footer-time">${formatLocalTime(created_at || new Date().toISOString())}</span>
        <div class="msg-footer-spacer"></div>
        <div class="msg-actions" id="actions-${safeId}">
          <button class="msg-action-btn" title="Copy to clipboard" onclick="copyMsgContent('${safeId}')">
            <i class="bi bi-clipboard"></i> Copy
          </button>
        </div>
      </div>
    </div>`;
  container.appendChild(row);
}

async function openRagContextArtifact(safeIdOrChatId, assistantChatId) {
  const panel = document.getElementById('artifact-panel');
  const overlay = document.getElementById('artifact-overlay');
  if (!panel) return;

  panel.classList.add('open');
  if (overlay) overlay.classList.add('show');
  document.getElementById('app-shell').classList.add('artifact-open');
  ArtifactPanel.open = true;

  const _renderHeader = () => `
    <div class="artifact-panel-header">
      <div class="artifact-panel-title">
        <i class="bi bi-journals" style="flex-shrink:0;"></i>
        <span>Retrieved Context</span>
      </div>
      <div class="artifact-panel-actions">
        <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>`;

  const _renderChunks = (docs) => {
    if (!docs || !docs.length) return '<div class="artifact-empty">No context chunks available.</div>';
    return docs.map((d) => `
      <div class="artifact-section" style="margin-bottom:12px;">
        <div class="artifact-section-title" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
          <span style="word-break:break-word;overflow-wrap:break-word;flex:1;min-width:0;">
            <i class="bi bi-file-earmark-text"></i> ${escapeHtml(d.filename || 'Document')}
          </span>
          <span style="font-size:0.65rem;color:#64748b;font-weight:400;flex-shrink:0;white-space:nowrap;">
            Chunk ${(d.chunk_index !== undefined ? d.chunk_index : '?')} · score ${d.score || '—'}
          </span>
        </div>
        <div class="artifact-rag-chunk" style="overflow-x:hidden;overflow-y:auto;max-height:220px;">
          ${escapeHtml(d.chunk || '')}
        </div>
      </div>`).join('');
  };

  panel.innerHTML = _renderHeader() + `
    <div class="artifact-panel-body artifact-sources-body" id="rag-chunks-body">
      <div class="artifact-loading">
        <div class="ts-dots"><span></span><span></span><span></span></div>
        <span>Loading context…</span>
      </div>
    </div>`;

  // Try to get docs from the DOM element first (fresh message)
  let docs = [];
  if (safeIdOrChatId && !assistantChatId) {
    const msgEl = document.getElementById(safeIdOrChatId);
    if (msgEl && msgEl.dataset.docs) {
      try { docs = JSON.parse(msgEl.dataset.docs); } catch (_) { }
    }
    // Also capture the assistantChatId from the row's dataset if present
    if (msgEl) {
      const row = msgEl.closest('.msg-row[data-assistant-chat-id]');
      if (row) assistantChatId = row.dataset.assistantChatId;
    }
  }

  // If docs already available in DOM, render immediately
  if (docs.length) {
    const body = document.getElementById('rag-chunks-body');
    if (body) {
      body.innerHTML = `
        <p style="color:#64748b;font-size:0.78rem;margin-bottom:12px;line-height:1.5;">
          <i class="bi bi-info-circle"></i>
          Chunks retrieved from your documents used to generate this answer.
        </p>
        ${_renderChunks(docs)}`;
    }
    return;
  }

  // Fetch from DB using assistantChatId
  if (!assistantChatId) {
    const body = document.getElementById('rag-chunks-body');
    if (body) body.innerHTML = '<div class="artifact-empty">No context available for this message.</div>';
    return;
  }

  try {
    const res = await fetch(`/api/rag/chunks/by-message/${assistantChatId}`);
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();
    docs = data.chunks || [];
    const body = document.getElementById('rag-chunks-body');
    if (body) {
      body.innerHTML = `
        <p style="color:#64748b;font-size:0.78rem;margin-bottom:12px;line-height:1.5;">
          <i class="bi bi-info-circle"></i>
          Chunks retrieved from your documents used to generate this answer.
        </p>
        ${_renderChunks(docs)}`;
    }
  } catch (e) {
    const body = document.getElementById('rag-chunks-body');
    if (body) body.innerHTML = '<div class="artifact-empty">Context chunks not available for this message.</div>';
  }
}


function openWebSourcesFromRegistry(key) {
  const urls = _webUrlsRegistry.get(key) || [];
  openWebSourcesArtifact(urls);
}

function openWebSourcesArtifact(webUrlsEncodedOrArray) {
  let urls = [];
  if (Array.isArray(webUrlsEncodedOrArray)) {
    urls = webUrlsEncodedOrArray;
  } else if (typeof webUrlsEncodedOrArray === 'string') {
    try { urls = JSON.parse(webUrlsEncodedOrArray); } catch (_) { }
  }

  const panel = document.getElementById('artifact-panel');
  const overlay = document.getElementById('artifact-overlay');
  if (!panel) return;

  panel.classList.add('open');
  if (overlay) overlay.classList.add('show');
  document.getElementById('app-shell').classList.add('artifact-open');
  ArtifactPanel.open = true;

  const urlsHtml = urls.length
    ? urls.map(u => `
        <li>
          <a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" class="artifact-url-link">
            <i class="bi bi-box-arrow-up-right"></i>
            ${escapeHtml(u.replace(/^https?:\/\//, '').split('/')[0])}
          </a>
        </li>`).join('')
    : '<li style="color:#94a3b8;">No URLs available.</li>';

  panel.innerHTML = `
    <div class="artifact-panel-header">
      <div class="artifact-panel-title">
        <i class="bi bi-globe2"></i> Web Sources
      </div>
      <div class="artifact-panel-actions">
        <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>
    <div class="artifact-panel-body artifact-sources-body">
      <div class="artifact-section">
        <div class="artifact-section-title">🌐 Sources used for this answer</div>
        <ul class="artifact-url-list">${urlsHtml}</ul>
      </div>
    </div>`;
}



function appendMessage(containerId, role, content, source = null, created_at = null, showActions = false) {
  const container = document.getElementById(containerId);
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;

  const bubbleContent = role === 'assistant' ? marked.parse(content) : escapeHtml(content);

  if (role === 'user') {
    row.innerHTML = `
      <div class="msg-body">
        <div class="msg-bubble user">${bubbleContent}</div>
        <div class="msg-time user">${formatLocalTime(created_at)}</div>
      </div>
      <div class="msg-avatar user">👤</div>`;
    container.appendChild(row);
    return;
  }

  let sourceBadgeHtml = '';
  if (source === 'rag') sourceBadgeHtml = `<span class="source-badge source-rag"><i class="bi bi-search"></i> Hybrid Search</span>`;
  else if (source === 'llm') sourceBadgeHtml = `<span class="source-badge source-llm"><i class="bi bi-cpu"></i> LLM</span>`;

  let actionsHtml = '', safeId = '';
  if (showActions) {
    safeId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    actionsHtml = `
      <div class="msg-actions" id="actions-${safeId}">
        <button class="msg-action-btn" title="Copy to clipboard" onclick="copyMsgContent('${safeId}')">
          <i class="bi bi-clipboard"></i> Copy
        </button>
        <button class="msg-action-btn" title="Download as PDF" onclick="downloadMsgPdf('${safeId}')">
          <i class="bi bi-file-earmark-pdf"></i> PDF
        </button>
        <button class="msg-action-btn" title="Add to My Documents" onclick="addMsgToDocuments('${safeId}')">
          <i class="bi bi-folder-plus"></i> Add to Docs
        </button>
      </div>`;
  }

  const footerHtml = `
    <div class="msg-footer">
      <div class="msg-footer-avatar">🤖</div>
      <span class="msg-footer-time">${formatLocalTime(created_at)}</span>
      ${sourceBadgeHtml ? `<div class="msg-footer-dot"></div>${sourceBadgeHtml}` : ''}
      ${showActions ? `<div class="msg-footer-spacer"></div>${actionsHtml}` : ''}
    </div>`;

  const bubbleAttrs = showActions ? `id="${safeId}" data-raw="${escapeAttr(content)}"` : '';

  row.innerHTML = `
    <div class="msg-body">
      <div class="msg-bubble assistant" ${bubbleAttrs}>${bubbleContent}</div>
      ${footerHtml}
    </div>`;
  container.appendChild(row);
}

function appendErrorMessage(containerId, text) {
  const container = document.getElementById(containerId);
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.innerHTML = `
    <div class="msg-body">
      <div class="msg-bubble assistant" style="border-color:rgba(248,113,113,0.2);color:#fca5a5;">${escapeHtml(text)}</div>
      <div class="msg-footer">
        <div class="msg-footer-avatar">⚠️</div>
        <span class="msg-footer-time">${formatLocalTime(new Date().toISOString())}</span>
      </div>
    </div>`;
  container.appendChild(row);
}

function appendLoading(containerId) {
  const container = document.getElementById(containerId);
  const id = `loading-${Date.now()}`;
  const row = document.createElement('div');
  row.id = id;
  row.className = 'loading-row';
  row.innerHTML = `
    <div class="loading-bubble">
      <div class="loading-avatar">🤖</div>
      <div class="loading-dots"><span></span><span></span><span></span></div>
    </div>`;
  container.appendChild(row);
  return id;
}

function removeLoading(id) { const el = document.getElementById(id); if (el) el.remove(); }
function hideWelcome(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

function clearChat(type) {
  const cid = type === 'travel' ? 'travel-messages' : 'rag-messages';
  const wid = type === 'travel' ? 'travel-welcome' : 'rag-welcome';
  document.getElementById(cid)?.querySelectorAll('.msg-row,.loading-row,.ts-card-wrapper,.ts-inline-loading,.ts-agent-status').forEach(el => el.remove());
  const welcome = document.getElementById(wid);
  if (welcome) welcome.style.display = '';
}

function scrollToBottom(cid) { const c = document.getElementById(cid); if (c) c.scrollTop = c.scrollHeight; }

function updateThreadLabel(type) {
  const labelId = type === 'travel' ? 'travel-thread-label' : 'rag-thread-label';
  const el = document.getElementById(labelId);
  if (!el) return;
  const threadId = type === 'travel' ? App.currentTravelThreadId : App.currentRagThreadId;
  if (!threadId) { el.textContent = ''; return; }
  const thread = App.threads.find(t => t.id === threadId);
  if (thread) el.textContent = `Thread: ${thread.title}`;
}


//  Action Buttons

function _getRawContent(safeId) {
  const el = document.getElementById(safeId);
  return el ? (el.dataset.raw || el.innerText) : '';
}

async function copyMsgContent(safeId) {
  const text = _getRawContent(safeId);
  try {
    await navigator.clipboard.writeText(text);
    _flashActionBtn(safeId, 'copy', '✓ Copied!');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    _flashActionBtn(safeId, 'copy', '✓ Copied!');
  }
}

async function downloadMsgPdf(safeId) {
  const text = _getRawContent(safeId);
  _flashActionBtn(safeId, 'pdf', '⏳ Generating…');
  try {
    const res = await fetch('/api/export/pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error('PDF export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `trip-plan-${Date.now()}.pdf`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    _flashActionBtn(safeId, 'pdf', '✓ Downloaded!');
  } catch (e) {
    console.error(e); _flashActionBtn(safeId, 'pdf', '✗ Failed');
  }
}

async function generateContentHash(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function addMsgToDocuments(safeId) {
  const text = _getRawContent(safeId);
  const hash = (await generateContentHash(text)).slice(0, 12);

  const filename = `trip-plan-${hash}.md`;
 
  _flashActionBtn(safeId, 'docs', '⏳ Saving…');
  try {
    const blob = new Blob([text], { type: 'text/markdown' });
    const formData = new FormData();
    formData.append('files', blob, filename);
    const res = await fetch('/api/docs/upload', { method: 'POST', body: formData });
    if (res.status === 409) {
      const err = await res.json();
      _flashActionBtn(safeId, 'docs', 'Already added');
      showDuplicateModal(err.detail?.filenames || [filename]);
      return;
    }
    if (!res.ok) throw new Error('Upload failed');
    const data = await res.json();
    _flashActionBtn(safeId, 'docs', '✓ Added!');
    // Refresh docs list if currently on docs tab
    if (App.currentTab === 'docs') loadDocuments();

    // Redirect to Docs tab after successful upload
    setTimeout(() => {
      if (App.currentTab !== 'docs') {
        switchTab('docs');
      }
    }, 1000);
  } catch (e) {
    console.error(e); _flashActionBtn(safeId, 'docs', '✗ Failed');
  }
}

function _flashActionBtn(safeId, btnType, msg) {
  const actionsEl = document.getElementById(`actions-${safeId}`);
  if (!actionsEl) return;
  const btns = actionsEl.querySelectorAll('.msg-action-btn');
  const map = { copy: 0, pdf: 1, docs: 2 };
  const btn = btns[map[btnType]];
  if (!btn) return;
  const orig = btn.innerHTML;
  btn.textContent = msg; btn.disabled = true;

  if (btnType === 'docs') return;

  setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
}


//  Documents

async function loadDocuments() {
  const list = document.getElementById('docs-list');
  list.innerHTML = `<div class="empty-state"><i class="bi bi-hourglass-split"></i><p>Loading…</p></div>`;
  try {
    const res = await fetch('/api/docs');
    if (!res.ok) throw new Error('Failed');
    const docs = await res.json();
    if (!docs.length) {
      list.innerHTML = `<div class="empty-state"><i class="bi bi-file-earmark-plus"></i><p>No documents uploaded yet.<br>Upload PDF, DOCX, or TXT/MD files to enhance your Travel Copilot.</p></div>`;
      return;
    }
    list.innerHTML = '';
    docs.forEach(doc => {
      const iconClass = getDocIconClass(doc.filename, doc.content_type);
      const item = document.createElement('div');
      item.className = 'doc-item';
      item.innerHTML = `
        <div class="doc-icon ${iconClass.cls}"><i class="bi ${iconClass.icon}"></i></div>
        <div class="doc-info">
          <div class="doc-name" title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</div>
          <div class="doc-meta">${formatBytes(doc.file_size)} · ${formatLocalTime(doc.created_at)}</div>
        </div>
        <div class="doc-actions">
          <button class="doc-preview-btn" onclick="previewDocument(${jsArg(doc.id)}, '${escapeAttr(doc.filename)}')" title="Preview document">
            <i class="bi bi-eye"></i>
          </button>
          <button class="doc-del" onclick="confirmDeleteDocument(${jsArg(doc.id)})" title="Remove document">
            <i class="bi bi-trash3"></i>
          </button>
        </div>`;
      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = `<div class="empty-state"><i class="bi bi-exclamation-triangle"></i><p>Failed to load documents.</p></div>`;
  }
}

async function previewDocument(docId, filename) {
  const panel = document.getElementById('artifact-panel');
  const overlay = document.getElementById('artifact-overlay');
  if (!panel) return;

  panel.classList.add('open');
  if (overlay) overlay.classList.add('show');
  document.getElementById('app-shell').classList.add('artifact-open');
  ArtifactPanel.open = true;

  if (ArtifactPanel._pdfObjectUrl) {
    URL.revokeObjectURL(ArtifactPanel._pdfObjectUrl);
    ArtifactPanel._pdfObjectUrl = null;
  }

  const ext = (filename || '').split('.').pop().toLowerCase();
  const isPdf = ext === 'pdf';
  const isTxt = ext === 'txt' || ext === 'md';
  const isDoc = ext === 'docx' || ext === 'doc';

  const _header = () => `
    <div class="artifact-panel-header">
      <div class="artifact-panel-title">
        <i class="bi bi-file-earmark-text"></i> ${escapeHtml(filename)}
      </div>
      <div class="artifact-panel-actions">
        <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>`;

  panel.innerHTML = _header() + `
    <div class="artifact-panel-body" style="align-items:center;justify-content:center;">
      <div class="artifact-loading">
        <div class="ts-dots"><span></span><span></span><span></span></div>
        <span>Loading preview…</span>
      </div>
    </div>`;

  // All files are fetched through the backend proxy — signed URL never reaches the client
  const proxyUrl = `/api/docs/${docId}/preview`;

  try {
    if (isPdf) {
      // Fetch PDF bytes, create an object URL and embed in iframe
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      ArtifactPanel._pdfObjectUrl = objectUrl;

      panel.innerHTML = _header() + `
        <div class="artifact-panel-body artifact-pdf-body" style="padding:0;overflow:hidden;">
          <iframe
            src="${objectUrl}"
            style="width:100%;height:100%;border:none;display:block;flex:1;"
            title="${escapeHtml(filename)}"
          ></iframe>
        </div>`;

    } else if (isTxt) {
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const text = await res.text();

      panel.innerHTML = _header() + `
        <div class="artifact-panel-body artifact-sources-body">
          <pre style="white-space:pre-wrap;word-break:break-word;font-size:0.82rem;
                      color:#e2e8f0;line-height:1.6;margin:0;padding:4px 0;">${escapeHtml(text)}</pre>
        </div>`;

    } else if (isDoc) {
      // Fetch DOCX bytes, convert with mammoth.js (loaded from CDN)
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();

      // Dynamically load mammoth if not already loaded
      if (typeof mammoth === 'undefined') {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }

      const result = await mammoth.convertToHtml({ arrayBuffer });
      const docHtml = result.value || '<p style="color:#94a3b8;">No content could be extracted.</p>';

      panel.innerHTML = _header() + `
        <div class="artifact-panel-body artifact-sources-body">
          <div class="docx-preview-content"
               style="font-size:0.85rem;line-height:1.7;color:#e2e8f0;
                      font-family:Georgia,serif;max-width:680px;margin:0 auto;">
            ${docHtml}
          </div>
        </div>`;

    } else {
      // Unsupported format — offer a download link through the proxy
      panel.innerHTML = _header() + `
        <div class="artifact-panel-body artifact-sources-body">
          <div class="artifact-doc-text-preview">
            <p style="color:#94a3b8;font-size:0.82rem;line-height:1.6;">
              <i class="bi bi-info-circle"></i>
              Inline preview is not available for this file type.<br><br>
              <a href="${proxyUrl}" download="${escapeHtml(filename)}"
                 style="color:#38bdf8;text-decoration:underline;">
                <i class="bi bi-download"></i> Download file
              </a>
            </p>
          </div>
        </div>`;
    }

  } catch (e) {
    console.error('previewDocument error:', e);
    panel.innerHTML = _header() + `
      <div class="artifact-panel-body" style="align-items:center;justify-content:center;">
        <div class="artifact-error">
          <i class="bi bi-exclamation-triangle" style="font-size:1.8rem;margin-bottom:8px;"></i>
          <span>Could not load preview.<br>
            <small style="color:#94a3b8;">${escapeHtml(e.message)}</small>
          </span>
        </div>
      </div>`;
  }
}


async function uploadDocument(input) {
  if (!input.files.length) return;
  const files = Array.from(input.files);
  const progress = document.getElementById('upload-progress');
  const label = document.getElementById('upload-progress-label');
  progress.style.display = 'block';
  label.textContent = `Uploading ${files.length} file(s): ${files.map(f => f.name).join(', ')}`;
  const formData = new FormData();
  files.forEach(f => formData.append('files', f));
  try {
    const res = await fetch('/api/docs/upload', { method: 'POST', body: formData });
    progress.style.display = 'none'; input.value = '';
    if (!res.ok) {
      const err = await res.json();
      if (res.status === 409 && err.detail && err.detail.filenames) {
        showDuplicateModal(err.detail.filenames);
      } else {
        alert('Upload failed: ' + (typeof err.detail === 'string' ? err.detail : 'Unknown error'));
      }
      return;
    }
    await loadDocuments();
  } catch (e) {
    progress.style.display = 'none'; input.value = '';
    alert('Upload failed. Check your connection and try again.');
  }
}


//  Document delete state

let _deleteDocId = null;
let _deleteDocModal = null;

function confirmDeleteDocument(docId) {
  _deleteDocId = docId;
  if (!_deleteDocModal) {
    _deleteDocModal = new bootstrap.Modal(document.getElementById('deleteDocModal'));
  }
  _deleteDocModal.show();
}

async function executeDeleteDocument() {
  if (!_deleteDocId) return;
  const deletedId = _deleteDocId;
  if (_deleteDocModal) _deleteDocModal.hide();
  try {
    const res = await fetch(`/api/docs/${deletedId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    _deleteDocId = null;

    // If this doc is attached in the Travel Copilot input, remove its chip too
    const before = RagAttach.files.length;
    RagAttach.files = RagAttach.files.filter(f => f.db_id !== deletedId);
    if (RagAttach.files.length !== before) _renderAttachChips();

    await loadDocuments();
  } catch (e) {
    console.error('Failed to delete document', e);
    const list = document.getElementById('docs-list');
    if (list) {
      const errEl = document.createElement('div');
      errEl.className = 'empty-state';
      errEl.style.cssText = 'color:#f87171;padding:12px;';
      errEl.textContent = 'Failed to delete document. Please try again.';
      list.prepend(errEl);
      setTimeout(() => errEl.remove(), 4000);
    }
  }
}

// Duplicate document modal 
let _duplicateDocModal = null;

function showDuplicateModal(filenames) {
  const list = document.getElementById('duplicate-doc-names');
  if (list) list.innerHTML = (filenames || []).map(n => `<li>${escapeHtml(n)}</li>`).join('');
  if (!_duplicateDocModal) {
    _duplicateDocModal = new bootstrap.Modal(document.getElementById('duplicateDocModal'));
  }
  _duplicateDocModal.show();
}

// Keep deleteDocument as alias so any inline onclick="deleteDocument(...)" still works
function deleteDocument(docId) {
  confirmDeleteDocument(docId);
}

function getDocIconClass(filename, contentType) {
  const name = (filename || '').toLowerCase(), ct = (contentType || '').toLowerCase();
  if (name.endsWith('.pdf') || ct.includes('pdf')) return { cls: 'pdf', icon: 'bi-file-earmark-pdf' };
  if (name.endsWith('.docx') || name.endsWith('.doc') || ct.includes('word')) return { cls: 'word', icon: 'bi-file-earmark-word' };
  if (name.endsWith('.md')) return { cls: '', icon: 'bi-file-earmark-code' };
  return { cls: '', icon: 'bi-file-earmark-text' };
}


//  Reports

// Active sub-tab for the trips section
let _currentTripTab = 'upcoming';

function switchTripTab(tab, el) {
  _currentTripTab = tab;
  document.querySelectorAll('.trip-tab-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  document.querySelectorAll('.trip-tab-pane').forEach(p => p.classList.remove('active'));
  const pane = document.getElementById(`trip-tab-${tab}`);
  if (pane) pane.classList.add('active');
}

async function loadReports() {
  // Set all sub-tab containers to loading
  ['upcoming', 'live', 'past'].forEach(t => {
    const el = document.getElementById(`reports-${t}`);
    if (el) el.innerHTML = `<div class="empty-state"><i class="bi bi-hourglass-split"></i><p>Loading…</p></div>`;
  });

  let data = { upcoming: [], live: [], past: [] };
  try {
    const res = await fetch('/api/reports/categorised');
    if (!res.ok) throw new Error('API error ' + res.status);
    data = await res.json();
  } catch (e) {
    console.error('loadReports fetch error:', e);
    ['upcoming', 'live', 'past'].forEach(t => {
      const el = document.getElementById(`reports-${t}`);
      if (el) el.innerHTML = `<div class="empty-state"><i class="bi bi-exclamation-triangle"></i><p>Failed to load trips.</p></div>`;
    });
    return;
  }

  // Show the Live tab button only when there are live trips
  const liveTabBtn = document.querySelector('.trip-tab-btn[data-trip-tab="live"]');
  if (liveTabBtn) {
    if (data.live.length) {
      liveTabBtn.classList.add('visible');
      // Auto-switch to Live tab since a trip is happening right now
      if (_currentTripTab === 'upcoming') {
        switchTripTab('live', liveTabBtn);
      }
    } else {
      liveTabBtn.classList.remove('visible');
      // If user was on live tab but no live trips anymore, fall back to upcoming
      if (_currentTripTab === 'live') {
        const upcomingBtn = document.querySelector('.trip-tab-btn[data-trip-tab="upcoming"]');
        switchTripTab('upcoming', upcomingBtn);
      }
    }
  }

  _renderTripSection('upcoming', data.upcoming, {
    emptyIcon: 'bi-calendar-plus',
    emptyText: 'No upcoming trips yet.<br>Plan your next adventure!',
    bucketType: 'upcoming',
  });

  _renderTripSection('live', data.live, {
    emptyIcon: 'bi-broadcast',
    emptyText: 'No trips happening right now.<br>Enjoy your time at home!',
    bucketType: 'live',
  });

  _renderTripSection('past', data.past, {
    emptyIcon: 'bi-clock-history',
    emptyText: 'No past trips yet.<br>Your completed trips will appear here.',
    bucketType: 'past',
  });
}

function _renderTripSection(bucket, reports, { emptyIcon, emptyText, bucketType }) {
  const container = document.getElementById(`reports-${bucket}`);
  if (!container) return;

  if (!Array.isArray(reports) || !reports.length) {
    container.innerHTML = `
      <div class="trip-tab-empty">
        <i class="bi ${emptyIcon}"></i>
        <p>${emptyText}</p>
      </div>`;
    return;
  }

  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'reports-grid';
  container.appendChild(grid);

  reports.forEach(report => {
    try {
      const card = _buildReportCard(report, bucketType);
      grid.appendChild(card);
    } catch (e) {
      console.error('_buildReportCard error', report.id, e);
    }
  });

  // Load images async
  reports.forEach(report => _loadReportCardImage(report));
}

function _loadReportCardImage(report) {
  const cardId = `report-card-${report.id}`;

  // Use trip_summary_id for a direct, per-report city lookup; fall back to city extraction
  let imagePromise;

  if (report.trip_summary_id) {
    imagePromise = fetch(`/api/city-image?trip_summary_id=${encodeURIComponent(report.trip_summary_id)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => data && data.url ? { url: data.url, city: data.city || '' } : null)
      .catch(() => null);
  } else {
    const city = _extractCityFromReport(report);
    if (!city) return;
    imagePromise = fetch(`/api/city-image?city=${encodeURIComponent(city)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => data && data.url ? { url: data.url, city: city } : null)
      .catch(() => null);
  }
  imagePromise.then(result => {
    if (!result || !result.url) return;

    const wrap = document.querySelector(`#${cardId} .report-card-img-wrap`);
    if (!wrap) return;

    // Update the destination label with the resolved city name if better
    if (result.city) {
      const destEl = wrap.querySelector('.report-card-dest');
      if (destEl && result.city.length > 1) destEl.textContent = result.city;
    }

    const placeholder = wrap.querySelector('.report-card-img-placeholder');
    const existing = wrap.querySelector('.report-card-img');
    if (existing) existing.remove();

    const img = document.createElement('img');
    img.className = 'report-card-img';
    img.alt = result.city || '';
    img.src = result.url;
    img.onload = () => {
      if (placeholder) placeholder.style.display = 'none';
      // Insert before gradient overlay so gradient stays on top
      const gradient = wrap.querySelector('.report-card-img-gradient');
      if (gradient) wrap.insertBefore(img, gradient);
      else wrap.prepend(img);
    };
    img.onerror = () => { img.remove(); };
  });
}

function _extractCityFromReport(report) {
  // Try to extract destination from title: "Trip Plan: from X to Y" or just "X to Y"
  const title = report.title || '';
  const toMatch = title.match(/\bto\s+([A-Za-z\s]+?)(?:\s*$|\.\.\.|\s+from|\s+for|\s+\d)/i);
  if (toMatch) return toMatch[1].trim().split(/\s+/).slice(0, 2).join(' ');
  // Fallback: first meaningful word(s) in title
  const cleaned = title.replace(/^Trip Plan[:–-]?\s*/i, '').trim();
  const words = cleaned.split(/\s+/).slice(0, 2).join(' ');
  return words || null;
}

function _buildReportCard(report, bucketType = 'past') {
  const city = report.destination_city || _extractCityFromReport(report) || 'Trip';
  const title = report.title || 'Trip Plan';
  const content = report.content || '';
  const dateStr = report.created_at
    ? new Date(report.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';
  const plain = content.replace(/[#*`>\-_\[\]!|]/g, '').replace(/\s+/g, ' ').trim();
  const preview = plain.slice(0, 120);

  const isFav = !!report.is_favourite;
  const feedback = report.feedback || null;

  // ── Badge per bucket ──
  let badgeHtml = '';
  if (bucketType === 'live') {
    badgeHtml = `<span class="report-card-type-badge live">
      <span class="report-card-live-dot"></span> Live
    </span>`;
  } else if (bucketType === 'upcoming') {
    const daysUntil = report.start_date
      ? Math.ceil((new Date(report.start_date) - new Date()) / 86400000)
      : null;
    badgeHtml = `<span class="report-card-type-badge upcoming">
      ${daysUntil !== null ? `✈ In ${daysUntil}d` : '✈ Upcoming'}
    </span>`;
  } else {
    badgeHtml = `<span class="report-card-type-badge travel">✈ Trip</span>`;
  }

  // ── Date pill in card body ──
  let datePillHtml = '';
  if (report.start_date && report.end_date) {
    const s = new Date(report.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const e = new Date(report.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const msPerDay = 86400000;
    const tripDays = Math.round((new Date(report.end_date) - new Date(report.start_date)) / msPerDay) + 1;
    datePillHtml = `<div class="report-card-date-pill ${bucketType}" style="background:none;padding:0;border:none;font-size:0.65rem;color:var(--muted);display:flex;align-items:center;gap:6px;margin-top:3px;">
      <i class="bi bi-calendar3" style="font-size:0.6rem;"></i>
      <span>${escapeHtml(s)} → ${escapeHtml(e)}</span>
      <span style="color:rgba(139,160,188,0.4);">|</span>
      <span style="color:var(--teal);font-weight:700;">${tripDays} day${tripDays !== 1 ? 's' : ''}</span>
    </div>`;
  }

  // ── Feedback bar — only for past trips ──
  let feedbackBarHtml = '';
  if (bucketType === 'past') {
    feedbackBarHtml = `
      <div class="report-card-feedback-bar">
        <span class="report-card-feedback-label">Was this trip helpful?</span>
        <button class="report-card-feedback-btn like ${feedback === 'like' ? 'active' : ''}"
                title="Like"
                onclick="setTripFeedback(event, ${jsArg(report.id)}, 'like', this)">
          <i class="bi bi-hand-thumbs-up"></i>
        </button>
        <button class="report-card-feedback-btn dislike ${feedback === 'dislike' ? 'active' : ''}"
                title="Dislike"
                onclick="setTripFeedback(event, ${jsArg(report.id)}, 'dislike', this)">
          <i class="bi bi-hand-thumbs-down"></i>
        </button>
      </div>`;
  }

  const card = document.createElement('div');
  card.className = 'report-img-card';
  card.id = `report-card-${report.id}`;
  card.innerHTML = `
    <div class="report-card-img-wrap">
      <div class="report-card-img-placeholder">🗺️</div>
      <div class="report-card-img-gradient"></div>
      <div class="report-card-dest">${escapeHtml(city)}</div>
      ${badgeHtml}
      <button class="report-card-fav-btn ${isFav ? 'active' : ''}"
              title="${isFav ? 'Remove from favourites' : 'Add to favourites'}"
              onclick="toggleTripFavourite(event, ${jsArg(report.id)}, this)">
        <i class="bi ${isFav ? 'bi-heart-fill' : 'bi-heart'}"></i>
      </button>
    </div>
    <div class="report-card-body">
      <div class="report-card-title">${escapeHtml(title)}</div>
      <div class="report-card-meta">
        <i class="bi bi-calendar3" style="font-size:0.65rem;"></i>
        ${escapeHtml(dateStr)}
      </div>
      ${datePillHtml}
    </div>
    ${feedbackBarHtml}
    <div class="report-card-footer">
      <button class="report-card-open-btn" onclick="navigateToTripByMessage(${jsArg(report.thread_id)}, ${jsArg(report.assistant_chat_id)})">
        <i class="bi bi-chat-left-text"></i> Open Chat
      </button>
      <button class="report-card-open-btn" style="background:rgba(0,212,200,0.08);color:var(--teal);" onclick="openReportArtifact(${jsArg(report.id)})">
        <i class="bi bi-layout-sidebar-reverse"></i> Preview
      </button>
      <button class="report-card-download-btn" title="Download as PDF"
              onclick="downloadReportPdf(${jsArg(report.id)}, '${escapeAttr(title)}')">
        <i class="bi bi-download"></i>
      </button>
    </div>`;
  return card;
}

// Favourite toggle

async function toggleTripFavourite(event, reportId, btn) {
  event.stopPropagation();
  try {
    const res = await fetch(`/api/reports/${reportId}/favourite`, { method: 'PATCH' });
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    const icon = btn.querySelector('i');
    if (data.is_favourite) {
      btn.classList.add('active');
      btn.title = 'Remove from favourites';
      if (icon) { icon.className = 'bi bi-heart-fill'; }
    } else {
      btn.classList.remove('active');
      btn.title = 'Add to favourites';
      if (icon) { icon.className = 'bi bi-heart'; }
    }
  } catch (e) {
    console.error('toggleTripFavourite error', e);
  }
}

//  Trip feedback (like / dislike)

async function setTripFeedback(event, reportId, value, btn) {
  event.stopPropagation();
  // If already active — toggle off (send null)
  const isActive = btn.classList.contains('active');
  const payload = isActive ? null : value;
  try {
    const res = await fetch(`/api/reports/${reportId}/feedback`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: payload }),
    });
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();

    // Update both buttons in the same card feedback bar
    const bar = btn.closest('.report-card-feedback-bar');
    if (bar) {
      bar.querySelectorAll('.report-card-feedback-btn').forEach(b => b.classList.remove('active'));
    }
    if (data.feedback) btn.classList.add('active');

  } catch (e) {
    console.error('setTripFeedback error', e);
  }
}

async function openReportArtifact(reportId) {
  // Find report in already-loaded DOM, or re-fetch
  const res = await fetch('/api/reports');
  if (!res.ok) return;
  const reports = await res.json();
  const report = reports.find(r => r.id === reportId);
  if (!report) return;

  const panel = document.getElementById('artifact-panel');
  const overlay = document.getElementById('artifact-overlay');
  if (!panel) return;

  panel.classList.add('open');
  if (overlay) overlay.classList.add('show');
  document.getElementById('app-shell').classList.add('artifact-open');
  ArtifactPanel.open = true;

  const city = _extractCityFromReport(report);
  const dateStr = report.created_at
    ? new Date(report.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  // Build header
  panel.innerHTML = `
    <div class="artifact-panel-header">
      <div class="artifact-panel-title">
        <i class="bi bi-journal-richtext"></i>
        ${escapeHtml(city || 'Trip Report')}
      </div>
      <div class="artifact-panel-actions">
        <button class="artifact-btn"
                onclick="downloadReportPdf(${jsArg(report.id)}, ${jsArg(report.title || 'trip-plan')})"
                title="Download PDF">
          <i class="bi bi-download"></i> PDF
        </button>
        <button class="artifact-btn artifact-btn-close" onclick="closeArtifactPanel()" title="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>
    <div class="artifact-panel-body artifact-report-body" id="report-artifact-body">
      <div class="artifact-report-header-placeholder" id="report-artifact-hero">🗺️</div>
      <div class="artifact-report-content">
        ${marked.parse(report.content || '')}
      </div>
      <div style="padding:0 20px 8px;font-size:0.7rem;color:var(--text-muted);">
        <i class="bi bi-clock"></i> Saved ${escapeHtml(dateStr)}
      </div>
    </div>`;

  // Try to load a city hero image into the header area
  if (city) {
    _fetchCityImage(city).then(url => {
      if (!url) return;
      const hero = document.getElementById('report-artifact-hero');
      if (!hero) return;
      const img = document.createElement('img');
      img.className = 'artifact-report-header-img';
      img.alt = city;
      img.src = url;
      img.onload = () => hero.replaceWith(img);
      img.onerror = () => { };
    });
  }
}

async function downloadReportPdf(reportId, titleHint) {
  try {
    const res = await fetch('/api/reports');
    if (!res.ok) throw new Error();
    const reports = await res.json();
    const report = reports.find(r => r.id === reportId);
    if (!report) throw new Error('Not found');

    const exportRes = await fetch('/api/export/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: report.content }),
    });
    if (!exportRes.ok) throw new Error('PDF export failed');

    const blob = await exportRes.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(titleHint || 'trip-plan').replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${reportId}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    console.error('PDF download failed', e);
  }
}


//  Utilities

function handleKey(event, type) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (type === 'travel') sendTravel();
    else sendRag();
  }
}

function setQuery(text) {
  const input = document.getElementById('travel-input');
  if (!input) return;
  input.value = text;
  autoGrow(input);
  input.focus();
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

function setupTextareaAutoGrow() {
  document.querySelectorAll('.input-bar textarea').forEach(ta => {
    ta.addEventListener('input', () => autoGrow(ta));
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function jsArg(value) {
  return escapeAttr(JSON.stringify(value));
}

function truncate(str, len) { return str.length > len ? str.slice(0, len) + '…' : str; }

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}


//  Country list

const COUNTRIES = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina",
  "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados",
  "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana",
  "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia", "Cameroon",
  "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo",
  "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czech Republic", "Denmark", "Djibouti", "Dominica",
  "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia",
  "Eswatini", "Ethiopia", "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana",
  "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras", "Hungary",
  "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Jamaica", "Japan",
  "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon",
  "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi",
  "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico",
  "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar",
  "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria",
  "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine", "Panama",
  "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania",
  "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines",
  "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles",
  "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa",
  "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland",
  "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga",
  "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu", "Uganda", "Ukraine",
  "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu",
  "Vatican City", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe"
];

function _populateCountrySelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  // Keep first blank option
  const blank = sel.options[0];
  sel.innerHTML = '';
  sel.appendChild(blank);
  COUNTRIES.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  });
}


//  First-login country setup

async function checkCountrySetup() {
  try {
    const res = await fetch('/api/profile/needs-country');
    const data = await res.json();
    if (data.needs_country) {
      _populateCountrySelect('country-setup-select');
      const modal = new bootstrap.Modal(document.getElementById('countrySetupModal'));
      modal.show();
    }
  } catch (e) {
    console.error('Country check failed', e);
  }
}

async function saveCountrySetup() {
  const sel = document.getElementById('country-setup-select');
  const country = sel?.value;
  if (!country) {
    sel.style.borderColor = '#f87171';
    return;
  }
  try {
    await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country }),
    });
    bootstrap.Modal.getInstance(document.getElementById('countrySetupModal')).hide();
  } catch (e) {
    console.error('Failed to save country', e);
  }
}


//  Destination image via Unsplash source (no API key needed)

async function _fetchCityImage(cityName) {
  if (!cityName || cityName.trim() === '' || cityName === 'New Trip') return null;
  try {
    const res = await fetch(`/api/city-image?city=${encodeURIComponent(cityName)}`);
    const data = await res.json();
    return data.url || null;
  } catch {
    return null;
  }
}


//  Profile Modal

async function openProfileModal() {
  const modal = new bootstrap.Modal(document.getElementById('profileModal'));
  modal.show();
  const body = document.getElementById('profile-modal-body');
  body.innerHTML = `<div style="text-align:center;padding:40px;color:#64748b;">
    <div class="ts-dots"><span></span><span></span><span></span></div>
  </div>`;

  try {
    const res = await fetch('/api/profile');
    if (!res.ok) throw new Error('Failed');
    const p = await res.json();

    const memberYear = p.member_since
      ? new Date(p.member_since).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
      : '—';

    const avatarHtml = p.picture
      ? `<img src="${escapeHtml(p.picture)}" class="profile-avatar-img" alt="Profile">`
      : `<div class="profile-avatar-fallback">${escapeHtml((p.name || 'U')[0].toUpperCase())}</div>`;

    const countryOpts = COUNTRIES.map(c =>
      `<option value="${escapeHtml(c)}" ${c === p.country ? 'selected' : ''}>${escapeHtml(c)}</option>`
    ).join('');

    // Build trip cards with placeholder first, then load images async
    const tripsCardHtml = (p.recent_trips || []).map((trip, idx) => {
      const city = trip.destination_city || 'New Trip';
      const dateStr = trip.updated_at
        ? new Date(trip.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      const cardKey = `trip-card-${idx}`;

      return `
        <div class="profile-trip-card"
             data-thread-id="${escapeHtml(trip.thread_id || '')}"
             data-assistant-chat-id="${escapeHtml(trip.assistant_chat_id || '')}"
             data-city="${escapeHtml(city)}"
             onclick="navigateToTripByMessage(${jsArg(trip.thread_id)}, ${jsArg(trip.assistant_chat_id || null)})"
             title="Open trip: ${escapeHtml(city)}"
             style="cursor:pointer;">
          <div class="profile-trip-placeholder" id="trip-placeholder-${cardKey}">
            <span style="font-size:1.4rem;">🗺️</span>
          </div>
          <img class="profile-trip-img"
               id="trip-img-${cardKey}"
               src=""
               alt="${escapeHtml(city)}"
               style="display:none;"
               onload="this.style.display='block';var p=document.getElementById('trip-placeholder-${cardKey}');if(p)p.style.display='none';"
               onerror="this.style.display='none';">
          <div class="profile-trip-overlay">
            <div class="profile-trip-city">${escapeHtml(city)}</div>
            <div class="profile-trip-date">${escapeHtml(dateStr)}</div>
          </div>
        </div>`;
    }).join('');

    body.innerHTML = `
      <div class="profile-avatar-wrap">
        ${avatarHtml}
        <div class="profile-name-email">
          <div class="profile-name" id="profile-display-name">${escapeHtml(p.name)}</div>
          <div class="profile-email">${escapeHtml(p.email)}</div>
        </div>
      </div>

    <div class="profile-stats-row">
        <div class="profile-stat">
          <div class="profile-stat-val" id="profile-stat-upcoming">—</div>
          <div class="profile-stat-label">Upcoming Trips</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-val">${p.reports_saved}</div>
          <div class="profile-stat-label">Reports Saved</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-val gold" style="font-size:0.85rem;">${escapeHtml(memberYear)}</div>
          <div class="profile-stat-label">Member Since</div>
        </div>
      </div>

      <div class="profile-field-group">
        <div class="profile-field-label">Full Name</div>
        <input type="text" class="profile-field-input" id="profile-name-input"
               value="${escapeHtml(p.name)}" maxlength="255" />
      </div>

      <div class="profile-field-group">
        <div class="profile-field-label">Home Country</div>
        <select class="profile-field-input" id="profile-country-select" style="cursor:pointer;">
          <option value="">Select country…</option>
          ${countryOpts}
        </select>
      </div>

      ${p.recent_trips && p.recent_trips.length ? `
        <div class="profile-section-label">Recent Trip Destinations</div>
        <div class="profile-trips-grid" id="profile-trips-grid">${tripsCardHtml}</div>
      ` : ''}

      <div class="profile-actions-row">
        <button class="profile-save-btn" onclick="saveProfileChanges()">Save Changes</button>
        <a href="/auth/logout" class="profile-signout-btn">Sign Out</a>
      </div>
      <div id="profile-save-msg" style="text-align:center;font-size:0.78rem;margin-top:8px;min-height:18px;color:#4ade80;"></div>
    `;

    // Load upcoming trips count
    try {
      const catRes = await fetch('/api/reports/categorised');
      if (catRes.ok) {
        const catData = await catRes.json();
        const upcomingEl = document.getElementById('profile-stat-upcoming');
        if (upcomingEl) upcomingEl.textContent = (catData.upcoming || []).length;
      }
    } catch (_) { }

    // Load Pixabay images async for each trip card
    (p.recent_trips || []).forEach(async (trip, idx) => {
      const cardKey = `trip-card-${idx}`;
      const imgEl = document.getElementById(`trip-img-${cardKey}`);
      if (!imgEl) return;
      try {
        const param = trip.trip_summary_id
          ? `trip_summary_id=${encodeURIComponent(trip.trip_summary_id)}`
          : `city=${encodeURIComponent(trip.destination_city || '')}`;
        const res = await fetch(`/api/city-image?${param}`);
        const data = await res.json();
        if (data.url) imgEl.src = data.url;
      } catch (_) { }
    });

  } catch (e) {
    body.innerHTML = `<div style="text-align:center;padding:40px;color:#f87171;">Failed to load profile.</div>`;
  }
}

async function saveProfileChanges() {
  const name = document.getElementById('profile-name-input')?.value?.trim();
  const country = document.getElementById('profile-country-select')?.value;
  const msgEl = document.getElementById('profile-save-msg');
  if (!name) { if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Name cannot be empty.'; } return; }
  try {
    await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, country }),
    });
    // Update display name in sidebar
    const nameEl = document.querySelector('.user-name');
    if (nameEl) nameEl.textContent = name;
    const displayEl = document.getElementById('profile-display-name');
    if (displayEl) displayEl.textContent = name;
    if (msgEl) { msgEl.style.color = '#4ade80'; msgEl.textContent = '✓ Changes saved!'; }
    setTimeout(() => { if (msgEl) msgEl.textContent = ''; }, 3000);
  } catch (e) {
    if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Failed to save.'; }
  }
}

function navigateToTrip(threadId) {
  const modalEl = document.getElementById('profileModal');
  const modal = bootstrap.Modal.getInstance(modalEl);
  if (modal) modal.hide();

  const thread = App.threads.find(t => t.id === threadId);
  if (!thread) {
    loadThreads().then(() => {
      const t = App.threads.find(t => t.id === threadId);
      if (t) switchThread(threadId, t.type || 'travel');
    });
    return;
  }
  switchThread(threadId, thread.type || 'travel');
}

function navigateToTripByMessage(threadId, assistantChatId) {
  // Close profile modal if open
  const modalEl = document.getElementById('profileModal');
  if (modalEl) {
    const modal = bootstrap.Modal.getInstance(modalEl);
    if (modal) modal.hide();
  }

  // On mobile — redirect to /chat with query params; app.js handles it on load
  if (window.innerWidth <= 991) {
    let url = '/chat?mode=travel';
    if (threadId) url += '&thread=' + threadId;
    if (assistantChatId) url += '&msg=' + assistantChatId;
    window.location.href = url;
    return Promise.resolve();
  }

  const doSwitch = () => {
    const thread = App.threads.find(t => t.id === threadId);
    return switchThread(threadId, (thread && thread.type) || 'travel').then(() => {
      if (!assistantChatId) return;
      setTimeout(() => {
        const msgRow = document.querySelector(
          `#travel-messages .msg-row[data-assistant-chat-id="${assistantChatId}"]`
        );
        if (msgRow) msgRow.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 400);
    });
  };

  if (!App.threads.find(t => t.id === threadId)) {
    return loadThreads().then(doSwitch);
  } else {
    return doSwitch();
  }
}


//  Init on DOM load

document.addEventListener('DOMContentLoaded', () => {

  loadThreads().then(async () => {

    const params =
      new URLSearchParams(
        window.location.search
      );

    const threadParam =
      params.get('thread');

    const msgParam =
      params.get('msg');

    /*
     * If a specific thread was requested in the URL,
     * determine its real type from App.threads.
     */
    if (threadParam) {

      const tid = threadParam;

      const thread =
        App.threads.find(
          t => t.id === tid
        );

      if (thread) {

        const threadType =
          thread.type === 'rag'
            ? 'rag'
            : 'travel';

        await switchThread(
          tid,
          threadType
        );

        /*
         * Scroll to a specific assistant message
         * when ?msg= is present.
         */
        if (msgParam) {

          const acid = msgParam;

          let attempts = 0;

          const tryScroll = () => {

            const selector =
              threadType === 'rag'
                ? `#rag-messages .msg-row[data-assistant-chat-id="${acid}"]`
                : `#travel-messages .msg-row[data-assistant-chat-id="${acid}"]`;

            const msgRow =
              document.querySelector(
                selector
              );

            if (msgRow) {

              msgRow.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
              });

            } else if (attempts++ < 8) {

              setTimeout(
                tryScroll,
                400
              );
            }
          };

          setTimeout(
            tryScroll,
            500
          );
        }
      }
    }

    /*
     * Open profile modal if redirected from homepage
     * avatar tap.
     */
    const urlParams =
      new URLSearchParams(
        window.location.search
      );

    if (
      urlParams.get('openProfile') === '1'
    ) {

      setTimeout(
        () => openProfileModal(),
        800
      );
    }

  });

  setupTextareaAutoGrow();
  checkCountrySetup();
});