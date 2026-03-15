const BACKEND_URL = 'http://127.0.0.1:8765';
const WS_URL = BACKEND_URL.replace(/^http/, 'ws').replace(/\/?$/, '') + '/ws';

/** Escape HTML and render basic Markdown for workflow summary display. */
function renderMarkdown(text) {
  if (!text || typeof text !== 'string') return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>');
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatRelativeTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

// ─── DOM refs ────────────────────────────────────────────────────────────────

const input = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const sendIconSend = document.getElementById('send-icon-send');
const sendIconCancel = document.getElementById('send-icon-cancel');
const messagesEl = document.getElementById('messages');
const modelSelect = document.getElementById('model-select');
const queueContainer = document.getElementById('queue-container');
const sidebarList = document.getElementById('sidebar-list');
const newChatBtn = document.getElementById('new-chat-btn');
const memoryBtn = document.getElementById('memory-btn');
const memoryPanel = document.getElementById('memory-panel');
const memoryList = document.getElementById('memory-list');
const memoryCloseBtn = document.getElementById('memory-close-btn');
const memoryClearAllBtn = document.getElementById('memory-clear-all-btn');
const knowledgeBtn = document.getElementById('knowledge-btn');
const knowledgePanel = document.getElementById('knowledge-panel');
const knowledgeCloseBtn = document.getElementById('knowledge-close-btn');
const knowledgeSearchInput = document.getElementById('knowledge-search-input');
const knowledgeSearchMode = document.getElementById('knowledge-search-mode');
const knowledgeResults = document.getElementById('knowledge-results');
const knowledgeStats = document.getElementById('knowledge-stats');

// ─── Runtime state ────────────────────────────────────────────────────────────

let availableModels = [];
let typingBubble = null;
let ws = null;
let wsReady = false;
let lastSentUserMessage = '';
// terminalMap: cmdId -> { block: <details>, pre: <pre> }
// Multiple entries coexist during parallel step execution.
const terminalMap = new Map();
// When set, plan/step messages/commands go inside this collapsible; final response is the only visible bubble.
let currentWorkflowThinking = null; // { details: HTMLDetailsElement, content: HTMLElement }
let activeAgentWorkflow = false;
let queuedAgentRequests = [];
let nextQueueId = 1;
let cancellingWorkflow = false;
// Tracks the msgId of the user bubble that triggered the currently-running workflow,
// so incoming file_snapshot messages can be stored against the right message.
let currentWorkflowMessageId = null;

// ─── Conversation state ───────────────────────────────────────────────────────

let currentConversationId = generateId();
let currentConversationMessages = []; // structured records for persistence
let conversationTitle = null;

// How many recent user↔assistant turn-pairs to send verbatim; older turns are collapsed into summaries.
const RECENT_TURNS = 6;

/**
 * Build the `conversation_history` array to seed the backend session.
 * Strategy:
 *   - Extract only meaningful turns: user messages + workflow_done summaries (already LLM-condensed).
 *   - Exclude the most-recent user message (it's already sent as payload.message and
 *     appended by the backend — sending it here too would duplicate it).
 *   - Keep the last RECENT_TURNS entries verbatim.
 *   - Condense anything older into a single assistant message built from prior summaries.
 */
function buildContextForBackend() {
  const msgs = currentConversationMessages.slice();

  // Drop the last user message — it travels as payload.message separately.
  const lastUserIdx = msgs.reduce((acc, m, i) => (m.type === 'user' ? i : acc), -1);
  const historyMsgs = lastUserIdx >= 0 ? msgs.slice(0, lastUserIdx) : msgs;

  // Flatten into [{role, content}] keeping only user intent + assistant summaries.
  const turns = [];
  for (const msg of historyMsgs) {
    if (msg.type === 'user') {
      turns.push({ role: 'user', content: msg.text });
    } else if (msg.type === 'workflow_done' && msg.summary) {
      turns.push({ role: 'assistant', content: msg.summary });
    }
  }

  if (turns.length === 0) return [];
  if (turns.length <= RECENT_TURNS) return turns;

  // Split into recent (verbatim) and older (collapsed into summary).
  const recent = turns.slice(-RECENT_TURNS);
  const older = turns.slice(0, -RECENT_TURNS);

  // Older assistant summaries are already LLM-condensed — just concatenate them.
  const olderSummaryText = older
    .filter((t) => t.role === 'assistant')
    .map((t) => t.content)
    .join('\n\n---\n\n');

  const result = [];
  if (olderSummaryText) {
    result.push({ role: 'assistant', content: `Earlier conversation summary:\n${olderSummaryText}` });
  }
  result.push(...recent);
  return result;
}

// ─── Conversation persistence ─────────────────────────────────────────────────

async function saveCurrentConversation() {
  if (!window.electronAPI?.saveConversation) return;
  if (!currentConversationMessages.length) return;
  const now = new Date().toISOString();
  await window.electronAPI.saveConversation({
    id: currentConversationId,
    title: conversationTitle || 'New Chat',
    createdAt: currentConversationMessages[0]?.timestamp || now,
    updatedAt: now,
    messages: currentConversationMessages,
  });
  await refreshSidebar();
}

/**
 * Fire-and-forget helper that asks the backend LLM to propose a conversation
 * title from the first user message. Runs fully in the background and never
 * blocks the main send flow.
 *
 * @param {string} firstMessage
 * @param {string | null} provider
 * @param {string | null} model
 */
function maybeGenerateConversationTitleInBackground(firstMessage, provider, model) {
  // Only attempt this on the very first user message of a fresh conversation.
  if (
    !firstMessage ||
    currentConversationMessages.length !== 1 ||
    currentConversationMessages[0]?.type !== 'user'
  ) {
    return;
  }

  const payload = {
    message: firstMessage,
    provider: provider || null,
    model: model || null,
  };

  // Fire-and-forget: we intentionally do not await this.
  (async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || !data.ok || !data.title) return;

      conversationTitle = String(data.title).slice(0, 120);
      // Persist updated title and refresh sidebar; this stays lightweight.
      await saveCurrentConversation();
    } catch (_) {
      // Swallow errors: title generation is best-effort only.
    }
  })();
}

async function refreshSidebar() {
  if (!sidebarList || !window.electronAPI?.listConversations) return;
  const convs = await window.electronAPI.listConversations();
  sidebarList.innerHTML = '';
  for (const conv of convs) {
    const item = document.createElement('div');
    item.className = 'sidebar-item' + (conv.id === currentConversationId ? ' active' : '');
    item.dataset.id = conv.id;

    const titleEl = document.createElement('div');
    titleEl.className = 'sidebar-item-title';
    titleEl.textContent = conv.title;

    const timeEl = document.createElement('div');
    timeEl.className = 'sidebar-item-time';
    timeEl.textContent = formatRelativeTime(conv.updatedAt);

    const delBtn = document.createElement('button');
    delBtn.className = 'sidebar-item-delete';
    delBtn.title = 'Delete conversation';
    delBtn.textContent = '×';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      await window.electronAPI.deleteConversation(conv.id);
      if (conv.id === currentConversationId) startNewConversation();
      else refreshSidebar();
    };

    item.appendChild(titleEl);
    item.appendChild(timeEl);
    item.appendChild(delBtn);
    item.onclick = () => {
      if (activeAgentWorkflow) return; // don't switch while a task is running
      openConversation(conv.id);
    };
    sidebarList.appendChild(item);
  }
}

async function openConversation(id) {
  if (!window.electronAPI?.getConversation) return;
  const conv = await window.electronAPI.getConversation(id);
  if (!conv) return;

  // Reset runtime state
  currentConversationId = id;
  currentConversationMessages = conv.messages || [];
  conversationTitle = conv.title;
  queuedAgentRequests = [];
  renderQueue();

  // Clear and re-render chat from stored messages (group plan/steps into Thinking… collapsible)
  messagesEl.innerHTML = '';
  const thinkingRef = { current: null };
  for (const msg of currentConversationMessages) {
    renderStoredMessage(msg, thinkingRef);
  }

  // Re-attach revert buttons for any user messages that have stored snapshots.
  restoreRevertButtons();

  await refreshSidebar();
  input.focus();
}

function startNewConversation() {
  currentConversationId = generateId();
  currentConversationMessages = [];
  conversationTitle = null;
  queuedAgentRequests = [];
  renderQueue();
  messagesEl.innerHTML = '';
  refreshSidebar();
  input.focus();
}

/** Render a stored message record back into the DOM (no recording). Uses thinkingContainer to group plan/steps into one collapsible. */
function renderStoredMessage(msg, thinkingContainerRef) {
  const tc = thinkingContainerRef;
  switch (msg.type) {
    case 'user':
      appendMessage(msg.text, true, false, msg.msgId || null);
      tc.current = null;
      break;
    case 'assistant':
      if (tc.current) {
        const div = document.createElement('div');
        div.className = 'step-message-inline';
        div.textContent = msg.text;
        tc.current.appendChild(div);
      } else {
        appendMessage(msg.text, false, false);
      }
      break;
    case 'plan': {
      const details = document.createElement('details');
      details.className = 'workflow-thinking';
      const summary = document.createElement('summary');
      summary.textContent = 'Thinking…';
      details.appendChild(summary);
      const content = document.createElement('div');
      content.className = 'workflow-thinking-content';
      details.appendChild(content);
      messagesEl.appendChild(details);
      tc.current = content;
      showPlan(msg.plan, false, content);
      break;
    }
    case 'step_start': {
      if (!tc.current) {
        const details = document.createElement('details');
        details.className = 'workflow-thinking';
        const summary = document.createElement('summary');
        summary.textContent = 'Thinking…';
        details.appendChild(summary);
        tc.current = document.createElement('div');
        tc.current.className = 'workflow-thinking-content';
        details.appendChild(tc.current);
        messagesEl.appendChild(details);
      }
      const badge = document.createElement('div');
      badge.className = 'step-badge';
      badge.textContent = `Step ${msg.step_id}: ${msg.description || ''}`;
      tc.current.appendChild(badge);
      break;
    }
    case 'step_message': {
      if (tc.current) {
        const div = document.createElement('div');
        div.className = 'step-message-inline';
        div.textContent = msg.text || '';
        tc.current.appendChild(div);
      }
      break;
    }
    case 'step_failed': {
      if (tc.current) {
        const d = document.createElement('div');
        d.className = 'step-badge step-failed';
        d.textContent = `Step ${msg.step_id} failed${msg.reason ? ': ' + msg.reason : ''}`;
        tc.current.appendChild(d);
      }
      break;
    }
    case 'step_complete': {
      if (tc.current) {
        const d = document.createElement('div');
        d.className = 'step-badge';
        d.textContent = `Step ${msg.step_id} complete`;
        tc.current.appendChild(d);
      }
      break;
    }
    case 'command': {
      if (!tc.current) {
        const details = document.createElement('details');
        details.className = 'workflow-thinking';
        const summary = document.createElement('summary');
        summary.textContent = 'Thinking…';
        details.appendChild(summary);
        tc.current = document.createElement('div');
        tc.current.className = 'workflow-thinking-content';
        details.appendChild(tc.current);
        messagesEl.appendChild(details);
      }
      const d = document.createElement('details');
      d.className = 'command-result-block terminal-block terminal-collapsible';
      const sum = document.createElement('summary');
      const heading = document.createElement('span');
      heading.className = 'terminal-heading';
      heading.textContent = `Running: ${msg.command || ''}`;
      sum.appendChild(heading);
      d.appendChild(sum);
      if (msg.output) {
        const pre = document.createElement('pre');
        pre.className = 'terminal-output';
        pre.textContent = msg.output;
        d.appendChild(pre);
      }
      tc.current.appendChild(d);
      break;
    }
    case 'workflow_done': {
      tc.current = null;
      const text = (msg.summary && msg.summary.trim()) ? msg.summary : '';
      if (text) {
        const bubble = document.createElement('div');
        bubble.className = 'message assistant';
        const inner = document.createElement('div');
        inner.className = 'workflow-done-summary';
        inner.innerHTML = renderMarkdown(text);
        bubble.appendChild(inner);
        messagesEl.appendChild(bubble);
      }
      break;
    }
    case 'workflow_stopped': {
      tc.current = null;
      const d = document.createElement('div');
      d.className = 'workflow-stopped';
      d.textContent = msg.reason || 'Stopped.';
      messagesEl.appendChild(d);
      break;
    }
    case 'error': {
      tc.current = null;
      appendMessage(`Error: ${msg.error || 'Unknown'}`, false, false);
      break;
    }
    default:
      break;
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ─── Streaming command output ──────────────────────────────────────────────────

if (window.electronAPI && typeof window.electronAPI.onCommandStream === 'function') {
  window.electronAPI.onCommandStream((msg) => {
    if (!msg || typeof msg.data !== 'string') return;
    // Route stream data to the correct terminal block by cmdId.
    const entry = msg.cmdId ? terminalMap.get(msg.cmdId) : null;
    if (!entry) return;
    entry.pre.textContent += msg.data;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

// ─── Message helpers ──────────────────────────────────────────────────────────

/**
 * Append a text message bubble to the chat.
 * @param {string} text
 * @param {boolean} isUser
 * @param {boolean} record - whether to record into conversation history (default true)
 * @param {string|null} existingMsgId - re-use a stored msgId when restoring from history
 * @returns {string|null} msgId for user messages, null for assistant messages
 */
function appendMessage(text, isUser = true, record = true, existingMsgId = null) {
  const msgId = isUser ? (existingMsgId || generateId()) : null;

  let elementToAppend;

  if (isUser) {
    // Wrap user bubble so we can position the revert button to its left.
    const wrapper = document.createElement('div');
    wrapper.className = 'user-msg-outer';

    const revertBtn = document.createElement('button');
    revertBtn.className = 'revert-btn';
    revertBtn.title = 'Revert to before this message';
    revertBtn.style.display = 'none'; // revealed only when snapshots exist
    revertBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 7v6h6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 13a9 9 0 1 0-3 6.3L21 16" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    revertBtn.onclick = (e) => { e.stopPropagation(); showRevertModal(msgId, text); };

    const div = document.createElement('div');
    div.className = 'message user';
    div.textContent = text;
    div.dataset.msgId = msgId;

    wrapper.appendChild(revertBtn);
    wrapper.appendChild(div);
    elementToAppend = wrapper;
  } else {
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.textContent = text;
    elementToAppend = div;
  }

  messagesEl.appendChild(elementToAppend);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  if (record) {
    if (isUser && !conversationTitle) {
      conversationTitle = text.length > 60 ? text.slice(0, 60) + '…' : text;
    }
    currentConversationMessages.push({
      type: isUser ? 'user' : 'assistant',
      text,
      msgId: isUser ? msgId : undefined,
      timestamp: new Date().toISOString(),
    });
    saveCurrentConversation();
  }

  return msgId;
}

function showTypingBubble() {
  if (typingBubble) return;
  const div = document.createElement('div');
  div.className = 'message assistant typing';
  const dots = document.createElement('div');
  dots.className = 'typing-dots';
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement('span');
    dots.appendChild(dot);
  }
  div.appendChild(dots);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  typingBubble = div;
}

function hideTypingBubble() {
  if (!typingBubble) return;
  messagesEl.removeChild(typingBubble);
  typingBubble = null;
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function ensureWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const w = new WebSocket(WS_URL);
    w.onopen = () => {
      ws = w;
      wsReady = true;
      resolve();
    };
    w.onerror = () => reject(new Error('WebSocket error'));
    w.onclose = () => { wsReady = false; };
    w.onmessage = onWsMessage;
  });
}

// ─── Task queue UI ────────────────────────────────────────────────────────────

function renderQueue() {
  if (!queueContainer) return;
  queueContainer.innerHTML = '';
  if (!queuedAgentRequests.length) return;

  queuedAgentRequests.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'queue-item';
    card.style.zIndex = String(100 - idx);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'queue-item-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove from queue';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      queuedAgentRequests = queuedAgentRequests.filter((q) => q.id !== item.id);
      renderQueue();
    };
    card.appendChild(removeBtn);

    const label = document.createElement('div');
    label.className = 'queue-item-label';
    label.textContent = idx === 0 ? 'Next task in queue' : `Queued #${idx + 1}`;
    card.appendChild(label);

    const text = document.createElement('div');
    text.className = 'queue-item-text';
    text.textContent = item.text;
    card.appendChild(text);

    queueContainer.appendChild(card);
  });
}

async function startNextQueuedAgentRequest() {
  if (activeAgentWorkflow) return;
  if (!queuedAgentRequests.length) return;

  const next = queuedAgentRequests.shift();
  renderQueue();
  if (!next) return;

  lastSentUserMessage = next.text;
  currentWorkflowMessageId = appendMessage(next.text);
  maybeGenerateConversationTitleInBackground(next.text, next.provider || null, next.model || null);
  activeAgentWorkflow = true;
  cancellingWorkflow = false;
  showTypingBubble();
  try {
    await ensureWs();
    ws.send(JSON.stringify({
      type: 'start',
      payload: {
        message: next.text,
        provider: next.provider,
        model: next.model,
        context: next.context,
        conversation_history: buildContextForBackend(),
      },
    }));
  } catch (err) {
    activeAgentWorkflow = false;
    hideTypingBubble();
    appendMessage(`Error: ${err.message || 'WebSocket failed'}`, false);
    sendBtn.disabled = false;
    await startNextQueuedAgentRequest();
  }
}

// ─── WebSocket message handler ────────────────────────────────────────────────

function onWsMessage(ev) {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch (_) {
    return;
  }
  const typ = msg.type;
  if (cancellingWorkflow && typ !== 'workflow_stopped') return;

  // Store file snapshots against the active user message for revert support.
  if (typ === 'file_snapshot') {
    if (currentWorkflowMessageId && window.electronAPI?.saveSnapshots) {
      window.electronAPI.saveSnapshots(currentWorkflowMessageId, [{
        path: msg.path,
        original_content: msg.original_content,
        existed: msg.existed,
      }]);
    }
    return;
  }

  if (typ === 'plan') {
    hideTypingBubble();
    const content = ensureWorkflowThinking();
    showPlan(msg.plan, true, content);
    return;
  }
  if (typ === 'error') {
    hideTypingBubble();
    currentWorkflowThinking = null;
    appendMessage(`Error: ${msg.error || 'Unknown'}`, false);
    // Also record as error type for history
    activeAgentWorkflow = false;
    cancellingWorkflow = false;
    startNextQueuedAgentRequest();
    input.focus();
    updateSendState();
    return;
  }
  if (typ === 'step_start') {
    const content = ensureWorkflowThinking();
    const badge = document.createElement('div');
    badge.className = 'step-badge';
    badge.textContent = `Step ${msg.step_id}: ${msg.description || ''}`;
    content.appendChild(badge);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    currentConversationMessages.push({
      type: 'step_start',
      step_id: msg.step_id,
      description: msg.description || '',
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (typ === 'step_message' && msg.message) {
    const content = ensureWorkflowThinking();
    const div = document.createElement('div');
    div.className = 'step-message-inline';
    div.textContent = msg.message;
    content.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    currentConversationMessages.push({
      type: 'step_message',
      text: msg.message,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (typ === 'run_command_start') {
    const content = ensureWorkflowThinking();
    const cmdId = msg.cmd_id || `fallback_${Date.now()}`;

    const d = document.createElement('details');
    d.className = 'command-result-block terminal-block terminal-collapsible';
    const summary = document.createElement('summary');
    const heading = document.createElement('span');
    heading.className = 'terminal-heading';
    heading.textContent = `Running: ${msg.command || ''}`;
    summary.appendChild(heading);
    d.appendChild(summary);
    const pre = document.createElement('pre');
    pre.className = 'terminal-output';
    d.appendChild(pre);
    content.appendChild(d);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Register this terminal in the map so stream data can be routed here.
    terminalMap.set(cmdId, { block: d, pre });

    // Record command in conversation history; output filled when done.
    const cmdRecord = {
      type: 'command',
      command: msg.command || '',
      output: '',
      timestamp: new Date().toISOString(),
    };
    const cmdRecordIdx = currentConversationMessages.length;
    currentConversationMessages.push(cmdRecord);

    if (window.electronAPI && typeof window.electronAPI.runInteractiveCommand === 'function') {
      window.electronAPI.runInteractiveCommand(msg.command || '', cmdId).then((result) => {
        // Capture full streamed output from the terminal pre element.
        const entry = terminalMap.get(cmdId);
        currentConversationMessages[cmdRecordIdx].output =
          (entry ? entry.pre.textContent : '') || result.stdout || '';
        terminalMap.delete(cmdId);
        saveCurrentConversation();

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'command_result',
            payload: {
              cmd_id: cmdId,
              stdout: result.stdout || '',
              stderr: result.stderr || '',
              returncode: result.returncode ?? 0,
            },
          }));
        }
      });
    }
    return;
  }
  if (typ === 'step_complete') {
    const content = ensureWorkflowThinking();
    const d = document.createElement('div');
    d.className = 'step-badge';
    d.textContent = `Step ${msg.step_id} complete`;
    content.appendChild(d);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    currentConversationMessages.push({
      type: 'step_complete',
      step_id: msg.step_id,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  // step_failed: one step failed independently — does NOT end the workflow.
  if (typ === 'step_failed') {
    const content = ensureWorkflowThinking();
    const d = document.createElement('div');
    d.className = 'step-badge step-failed';
    d.textContent = `Step ${msg.step_id} failed${msg.reason ? ': ' + msg.reason : ''}`;
    content.appendChild(d);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    currentConversationMessages.push({
      type: 'step_failed',
      step_id: msg.step_id,
      reason: msg.reason || '',
      timestamp: new Date().toISOString(),
    });
    saveCurrentConversation();
    return;
  }
  if (typ === 'workflow_done') {
    const storedContent = (msg.summary && msg.summary.trim()) ? msg.summary : (msg.reply_preview && msg.reply_preview.trim()) || '';
    if (storedContent) {
      const bubble = document.createElement('div');
      bubble.className = 'message assistant';
      const inner = document.createElement('div');
      inner.className = 'workflow-done-summary';
      inner.innerHTML = renderMarkdown(storedContent);
      bubble.appendChild(inner);
      messagesEl.appendChild(bubble);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    currentWorkflowThinking = null;
    currentConversationMessages.push({
      type: 'workflow_done',
      summary: storedContent,
      timestamp: new Date().toISOString(),
    });
    saveCurrentConversation();
    if (storedContent) extractAndSaveMemory(lastSentUserMessage, storedContent);
    activeAgentWorkflow = false;
    cancellingWorkflow = false;
    const wfMsgIdDone = currentWorkflowMessageId;
    currentWorkflowMessageId = null;
    if (wfMsgIdDone) (async () => { await maybeShowRevertButton(wfMsgIdDone); })();
    startNextQueuedAgentRequest();
    input.focus();
    updateSendState();
    return;
  }
  if (typ === 'confirmation_required') {
    const block = document.createElement('div');
    block.className = 'confirmation-block';
    const text = document.createElement('div');
    text.className = 'confirmation-text';
    text.textContent = msg.prompt || 'Do you approve this action?';
    block.appendChild(text);
    const buttons = document.createElement('div');
    buttons.className = 'confirmation-buttons';
    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.textContent = 'Yes';
    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.textContent = 'No';
    yesBtn.onclick = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'confirmation_response', payload: { approved: true } }));
      }
      yesBtn.disabled = true;
      noBtn.disabled = true;
    };
    noBtn.onclick = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'confirmation_response', payload: { approved: false } }));
      }
      yesBtn.disabled = true;
      noBtn.disabled = true;
    };
    buttons.appendChild(yesBtn);
    buttons.appendChild(noBtn);
    block.appendChild(buttons);
    messagesEl.appendChild(block);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }
  if (typ === 'ask_user_required') {
    const block = document.createElement('div');
    block.className = 'ask-user-block';

    const questionEl = document.createElement('div');
    questionEl.className = 'ask-user-question';
    questionEl.textContent = msg.question || 'I need some information to continue.';
    block.appendChild(questionEl);

    const options = Array.isArray(msg.options) ? msg.options : [];

    function submitAnswer(answer) {
      if (!answer.trim()) return;
      block.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
      appendMessage(answer.trim());
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ask_user_response', payload: { answer: answer.trim() } }));
      }
    }

    if (options.length > 0) {
      const optionsEl = document.createElement('div');
      optionsEl.className = 'ask-user-options';
      options.forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ask-user-option-btn';
        btn.textContent = opt;
        btn.onclick = () => submitAnswer(opt);
        optionsEl.appendChild(btn);
      });
      block.appendChild(optionsEl);
    }

    const customRow = document.createElement('div');
    customRow.className = 'ask-user-custom-row';
    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.className = 'ask-user-custom-input';
    customInput.placeholder = 'Or type a custom answer…';
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAnswer(customInput.value);
    });
    const customBtn = document.createElement('button');
    customBtn.type = 'button';
    customBtn.className = 'ask-user-custom-btn';
    customBtn.textContent = 'Submit';
    customBtn.onclick = () => submitAnswer(customInput.value);
    customRow.appendChild(customInput);
    customRow.appendChild(customBtn);
    block.appendChild(customRow);

    messagesEl.appendChild(block);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    customInput.focus();
    return;
  }
  if (typ === 'workflow_stopped') {
    hideTypingBubble();
    currentWorkflowThinking = null;
    if (!cancellingWorkflow) {
      const d = document.createElement('div');
      d.className = 'workflow-stopped';
      d.textContent = msg.reason || 'Stopped.';
      messagesEl.appendChild(d);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      currentConversationMessages.push({
        type: 'workflow_stopped',
        reason: msg.reason || 'Stopped.',
        timestamp: new Date().toISOString(),
      });
      saveCurrentConversation();
    }
    activeAgentWorkflow = false;
    cancellingWorkflow = false;
    const wfMsgIdStopped = currentWorkflowMessageId;
    currentWorkflowMessageId = null;
    if (wfMsgIdStopped) (async () => { await maybeShowRevertButton(wfMsgIdStopped); })();
    startNextQueuedAgentRequest();
    input.focus();
    updateSendState();
    return;
  }
}

// ─── Plan display ─────────────────────────────────────────────────────────────

/** Append plan block to parentEl, or to messagesEl if not provided. */
function showPlan(planData, record = true, parentEl = null) {
  const block = document.createElement('div');
  block.className = 'plan-block';
  const h4 = document.createElement('h4');
  h4.textContent = 'Current plan';
  block.appendChild(h4);
  const ol = document.createElement('ol');
  (planData.steps || []).forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s.description;
    ol.appendChild(li);
  });
  block.appendChild(ol);
  const target = parentEl || messagesEl;
  target.appendChild(block);
  if (!parentEl) messagesEl.scrollTop = messagesEl.scrollHeight;

  if (record) {
    currentConversationMessages.push({
      type: 'plan',
      plan: planData,
      timestamp: new Date().toISOString(),
    });
  }
}

/** Ensure the current workflow has a collapsible "Thinking…" block; return its content div. */
function ensureWorkflowThinking() {
  if (currentWorkflowThinking) return currentWorkflowThinking.content;
  const details = document.createElement('details');
  details.className = 'workflow-thinking';
  const summary = document.createElement('summary');
  summary.textContent = 'Thinking…';
  details.appendChild(summary);
  const content = document.createElement('div');
  content.className = 'workflow-thinking-content';
  details.appendChild(content);
  messagesEl.appendChild(details);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  currentWorkflowThinking = { details, content };
  return content;
}

// ─── Revert ───────────────────────────────────────────────────────────────────

/**
 * Show the revert button on a user bubble if snapshots exist for that msgId.
 */
async function maybeShowRevertButton(msgId) {
  if (!msgId || !window.electronAPI?.getSnapshots) return;
  const snapshots = await window.electronAPI.getSnapshots(msgId);
  if (!snapshots || snapshots.length === 0) return;
  const bubble = messagesEl.querySelector(`.message.user[data-msg-id="${CSS.escape(msgId)}"]`);
  if (!bubble) return;
  const btn = bubble.parentElement?.querySelector('.revert-btn');
  if (btn) btn.style.display = '';
}

/**
 * After loading a stored conversation, re-attach revert buttons for any user
 * messages whose snapshots are still on disk.
 */
function restoreRevertButtons() {
  const bubbles = messagesEl.querySelectorAll('.message.user[data-msg-id]');
  for (const bubble of bubbles) {
    const msgId = bubble.dataset.msgId;
    if (msgId) (async () => { await maybeShowRevertButton(msgId); })();
  }
}

/**
 * Show a confirmation modal before reverting.
 */
function showRevertModal(msgId, text) {
  const overlay = document.createElement('div');
  overlay.className = 'revert-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'revert-modal';

  const title = document.createElement('div');
  title.className = 'revert-modal-title';
  title.textContent = 'Revert changes?';

  const desc = document.createElement('div');
  desc.className = 'revert-modal-desc';
  desc.textContent = 'All files modified during this request will be restored to their previous state. The conversation from this point will be removed and the original message will be placed back in the input.';

  const buttons = document.createElement('div');
  buttons.className = 'revert-modal-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'revert-modal-btn revert-modal-btn-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => document.body.removeChild(overlay);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'revert-modal-btn revert-modal-btn-confirm';
  confirmBtn.textContent = 'Yes, Revert';
  confirmBtn.onclick = async () => {
    document.body.removeChild(overlay);
    await performRevert(msgId, text);
  };

  buttons.appendChild(cancelBtn);
  buttons.appendChild(confirmBtn);
  modal.appendChild(title);
  modal.appendChild(desc);
  modal.appendChild(buttons);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close on backdrop click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) document.body.removeChild(overlay);
  });
}

/**
 * Restore file snapshots, truncate conversation history and DOM from msgId
 * onward, then place the original message text back into the input.
 */
async function performRevert(msgId, text) {
  if (activeAgentWorkflow) return; // refuse while a workflow is running

  // 1. Restore each snapshotted file.
  if (window.electronAPI?.getSnapshots && window.electronAPI?.restoreFileSnapshot) {
    const snapshots = await window.electronAPI.getSnapshots(msgId);
    if (snapshots && snapshots.length > 0) {
      for (const snap of snapshots) {
        await window.electronAPI.restoreFileSnapshot(snap.path, snap.original_content, snap.existed);
      }
    }
  }

  // 2. Delete snapshots for this message and all later user messages.
  if (window.electronAPI?.deleteSnapshots) {
    const msgIdx = currentConversationMessages.findIndex(
      (m) => m.type === 'user' && m.msgId === msgId,
    );
    if (msgIdx >= 0) {
      const laterIds = currentConversationMessages
        .slice(msgIdx + 1)
        .filter((m) => m.type === 'user' && m.msgId)
        .map((m) => m.msgId);
      for (const id of laterIds) await window.electronAPI.deleteSnapshots(id);
    }
    await window.electronAPI.deleteSnapshots(msgId);
  }

  // 3. Truncate conversation messages — drop the reverted user message and everything after.
  const msgIdx = currentConversationMessages.findIndex(
    (m) => m.type === 'user' && m.msgId === msgId,
  );
  if (msgIdx >= 0) {
    currentConversationMessages = currentConversationMessages.slice(0, msgIdx);
  }

  // 4. Remove DOM elements from the user bubble's wrapper onward.
  const bubble = messagesEl.querySelector(`.message.user[data-msg-id="${CSS.escape(msgId)}"]`);
  if (bubble) {
    // The bubble lives inside a .user-msg-outer wrapper — remove from wrapper onward.
    const target = bubble.closest('.user-msg-outer') || bubble;
    const children = Array.from(messagesEl.children);
    const startIdx = children.indexOf(target);
    if (startIdx >= 0) {
      for (let i = children.length - 1; i >= startIdx; i--) {
        messagesEl.removeChild(children[i]);
      }
    }
  }

  // 5. Persist the truncated conversation.
  await saveCurrentConversation();

  // 6. Place the original message back in the input.
  input.value = text;
  input.focus();
  updateSendState();
}

// ─── Memory ───────────────────────────────────────────────────────────────────

/** Score memory chunks by keyword overlap with query. Returns top 5 relevant chunks. */
async function getRelevantMemory(query) {
  if (!window.electronAPI?.getMemory) return [];
  const all = await window.electronAPI.getMemory();
  if (!all?.length) return [];

  const queryWords = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (queryWords.size === 0) return all.slice(0, 5);

  const scored = all.map((chunk) => {
    const words = chunk.content.toLowerCase().split(/\W+/);
    const score = words.filter((w) => queryWords.has(w)).length;
    return { chunk, score };
  });
  scored.sort((a, b) => b.score - a.score || new Date(b.chunk.createdAt) - new Date(a.chunk.createdAt));
  return scored.slice(0, 5).map((s) => s.chunk);
}

async function getRelevantKnowledge(query) {
  if (!window.electronAPI?.knowledgeSearch) return [];
  try {
    const result = await window.electronAPI.knowledgeSearch(query, { mode: 'hybrid', top_k: 5 });
    if (result?.ok && result.results?.length > 0) {
      return result.results;
    }
  } catch (_) {}
  return [];
}

/** Fire-and-forget: extract memory from an exchange and persist only non-duplicate chunks (semantic dedupe via backend). */
function extractAndSaveMemory(userMessage, assistantResponse) {
  if (!userMessage || !assistantResponse) return;
  const selected = getSelectedModel();
  const provider = selected ? selected.provider : null;
  if (!provider) return;

  (async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/extract-memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_message: userMessage,
          assistant_response: assistantResponse,
          provider,
          model: selected.model || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.chunks?.length) return;

      const newContents = data.chunks;
      const existing = window.electronAPI?.getMemory ? await window.electronAPI.getMemory() : [];
      const existingContents = (existing || []).map((c) => c.content || '').filter(Boolean);

      const filterRes = await fetch(`${BACKEND_URL}/filter-memory-duplicates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          existing: existingContents,
          new: newContents,
          provider,
          model: selected.model || null,
        }),
      });
      const filterData = await filterRes.json().catch(() => ({}));
      const keepIndices = filterRes.ok && filterData.ok && Array.isArray(filterData.keep_indices)
        ? filterData.keep_indices
        : newContents.map((_, i) => i);

      const toAdd = keepIndices
        .filter((i) => i >= 0 && i < newContents.length)
        .map((i) => newContents[i])
        .filter(Boolean);
      if (!toAdd.length) return;

      const now = new Date().toISOString();
      const newChunks = toAdd.map((content) => ({ id: generateId(), content, createdAt: now }));
      if (window.electronAPI?.addMemoryChunks) {
        await window.electronAPI.addMemoryChunks(newChunks);
      }
    } catch (_) {}
  })();
}

async function renderMemoryPanel() {
  if (!memoryList) return;
  const chunks = window.electronAPI?.getMemory ? await window.electronAPI.getMemory() : [];
  memoryList.innerHTML = '';

  if (!chunks?.length) {
    const empty = document.createElement('div');
    empty.className = 'memory-empty';
    empty.textContent = 'No memories stored yet.';
    memoryList.appendChild(empty);
    return;
  }

  for (const chunk of [...chunks].reverse()) {
    const item = document.createElement('div');
    item.className = 'memory-item';

    const body = document.createElement('div');
    body.className = 'memory-item-body';

    const content = document.createElement('div');
    content.className = 'memory-item-content';
    content.textContent = chunk.content;
    body.appendChild(content);

    const date = document.createElement('div');
    date.className = 'memory-item-date';
    date.textContent = formatRelativeTime(chunk.createdAt);
    body.appendChild(date);

    item.appendChild(body);

    const delBtn = document.createElement('button');
    delBtn.className = 'memory-item-delete';
    delBtn.title = 'Delete';
    delBtn.textContent = '×';
    delBtn.onclick = async () => {
      if (window.electronAPI?.deleteMemoryChunk) {
        await window.electronAPI.deleteMemoryChunk(chunk.id);
      }
      renderMemoryPanel();
    };
    item.appendChild(delBtn);

    memoryList.appendChild(item);
  }
}

function openMemoryPanel() {
  if (!memoryPanel) return;
  memoryPanel.style.display = 'flex';
  memoryBtn?.classList.add('active');
  renderMemoryPanel();
}

function closeMemoryPanel() {
  if (!memoryPanel) return;
  memoryPanel.style.display = 'none';
  memoryBtn?.classList.remove('active');
}

// ─── Knowledge panel ─────────────────────────────────────────────────────────

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

async function renderKnowledgeStats() {
  if (!knowledgeStats) return;
  let stats = {};
  try {
    const res = window.electronAPI?.knowledgeStats ? await window.electronAPI.knowledgeStats() : {};
    if (res?.ok) stats = res;
  } catch (_) {}

  const indexed = stats.indexed_files || 0;
  const watching = stats.watcher_active ? 'Active' : 'Inactive';
  const status = stats.indexing_status || {};
  const phase = status.phase || 'idle';
  const embedded = status.files_embedded || 0;

  knowledgeStats.innerHTML = `
    <div class="knowledge-stat-card">
      <div class="knowledge-stat-value">${indexed.toLocaleString()}</div>
      <div class="knowledge-stat-label">Files Indexed</div>
    </div>
    <div class="knowledge-stat-card">
      <div class="knowledge-stat-value">${embedded.toLocaleString()}</div>
      <div class="knowledge-stat-label">Files Embedded</div>
    </div>
    <div class="knowledge-stat-card">
      <div class="knowledge-stat-value">${phase.charAt(0).toUpperCase() + phase.slice(1)}</div>
      <div class="knowledge-stat-label">Status</div>
    </div>
    <div class="knowledge-stat-card">
      <div class="knowledge-stat-value">${watching}</div>
      <div class="knowledge-stat-label">Watcher</div>
    </div>
  `;
}

async function searchKnowledge(query) {
  if (!knowledgeResults) return;
  if (!query.trim()) {
    knowledgeResults.innerHTML = '<div class="knowledge-empty">Type a query to search your indexed files</div>';
    return;
  }

  knowledgeResults.innerHTML = '<div class="knowledge-empty">Searching...</div>';

  try {
    const mode = knowledgeSearchMode?.value || 'hybrid';
    const res = window.electronAPI?.knowledgeSearch
      ? await window.electronAPI.knowledgeSearch(query, { mode, top_k: 20 })
      : { ok: false };

    if (!res?.ok || !res.results?.length) {
      knowledgeResults.innerHTML = '<div class="knowledge-empty">No results found</div>';
      return;
    }

    knowledgeResults.innerHTML = '';
    for (const r of res.results) {
      const item = document.createElement('div');
      item.className = 'knowledge-result-item';

      const header = document.createElement('div');
      header.className = 'knowledge-result-header';

      const name = document.createElement('span');
      name.className = 'knowledge-result-name';
      name.textContent = r.file_name;
      header.appendChild(name);

      if (r.extension) {
        const ext = document.createElement('span');
        ext.className = 'knowledge-result-ext';
        ext.textContent = r.extension;
        header.appendChild(ext);
      }

      const score = document.createElement('span');
      score.className = 'knowledge-result-score';
      score.textContent = `score: ${r.score.toFixed(3)}`;
      header.appendChild(score);

      item.appendChild(header);

      const pathEl = document.createElement('div');
      pathEl.className = 'knowledge-result-path';
      pathEl.textContent = r.file_path;
      item.appendChild(pathEl);

      if (r.excerpt) {
        const excerpt = document.createElement('div');
        excerpt.className = 'knowledge-result-excerpt';
        excerpt.textContent = r.excerpt;
        item.appendChild(excerpt);
      }

      const meta = document.createElement('div');
      meta.className = 'knowledge-result-meta';
      meta.innerHTML = `<span>${formatFileSize(r.size)}</span><span>${r.source}</span>`;
      if (r.modified_at) {
        const d = new Date(r.modified_at * 1000);
        meta.innerHTML += `<span>${d.toLocaleDateString()}</span>`;
      }
      item.appendChild(meta);

      knowledgeResults.appendChild(item);
    }
  } catch (e) {
    knowledgeResults.innerHTML = `<div class="knowledge-empty">Error: ${e.message}</div>`;
  }
}

let knowledgeSearchTimer = null;

function openKnowledgePanel() {
  if (!knowledgePanel) return;
  knowledgePanel.style.display = 'flex';
  knowledgeBtn?.classList.add('active');
  renderKnowledgeStats();
  if (knowledgeResults) {
    knowledgeResults.innerHTML = '<div class="knowledge-empty">Type a query to search your indexed files</div>';
  }
  knowledgeSearchInput?.focus();
}

function closeKnowledgePanel() {
  if (!knowledgePanel) return;
  knowledgePanel.style.display = 'none';
  knowledgeBtn?.classList.remove('active');
}

if (knowledgeCloseBtn) {
  knowledgeCloseBtn.addEventListener('click', closeKnowledgePanel);
}

if (knowledgeBtn) {
  knowledgeBtn.addEventListener('click', () => {
    if (knowledgePanel?.style.display === 'none' || !knowledgePanel?.style.display) {
      closeMemoryPanel();
      openKnowledgePanel();
    } else {
      closeKnowledgePanel();
    }
  });
}

if (knowledgeSearchInput) {
  knowledgeSearchInput.addEventListener('input', () => {
    clearTimeout(knowledgeSearchTimer);
    knowledgeSearchTimer = setTimeout(() => {
      searchKnowledge(knowledgeSearchInput.value);
    }, 400);
  });
  knowledgeSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(knowledgeSearchTimer);
      searchKnowledge(knowledgeSearchInput.value);
    }
  });
}

if (knowledgeSearchMode) {
  knowledgeSearchMode.addEventListener('change', () => {
    if (knowledgeSearchInput?.value.trim()) {
      searchKnowledge(knowledgeSearchInput.value);
    }
  });
}

// ─── Model loading ────────────────────────────────────────────────────────────

async function loadModels() {
  try {
    const res = await fetch(`${BACKEND_URL}/models`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
    availableModels = data.models || [];
    modelSelect.innerHTML = '';
    for (const m of availableModels) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      modelSelect.appendChild(opt);
    }
  } catch (err) {
    availableModels = [];
    modelSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Models unavailable';
    modelSelect.appendChild(opt);
    appendMessage(`Error loading models: ${err.message || String(err)}`);
  }
}

function getSelectedModel() {
  const id = modelSelect.value;
  if (!id) return null;
  return availableModels.find((m) => m.id === id) || null;
}

function getFallbackContext() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const platform = typeof navigator !== 'undefined' ? navigator.platform : 'unknown';
  return { platform, user_agent: ua.slice(0, 200), source: 'renderer' };
}

// ─── Send / cancel ────────────────────────────────────────────────────────────

async function send() {
  const text = input.value.trim();
  if (!text) return;
  const useAgent = document.getElementById('use-agent').checked;
  const selected = getSelectedModel();

  if (!useAgent || !selected) {
    lastSentUserMessage = text;
    appendMessage(text);
    // First user message in a new conversation: kick off background title generation.
    maybeGenerateConversationTitleInBackground(
      text,
      selected ? selected.provider : null,
      selected ? selected.model : null,
    );
    input.value = '';
    sendBtn.disabled = true;

    let context = {};
    try {
      if (window.electronAPI && typeof window.electronAPI.getDeviceContext === 'function') {
        context = await window.electronAPI.getDeviceContext();
      } else {
        context = getFallbackContext();
      }
    } catch (_) {
      context = getFallbackContext();
    }

    const relevantChunks = await getRelevantMemory(text);
    if (relevantChunks.length > 0) {
      context.user_memory = relevantChunks.map((c) => c.content).join(' | ');
    }

    const knowledgeResults = await getRelevantKnowledge(text);
    if (knowledgeResults.length > 0) {
      context.knowledge_context = knowledgeResults
        .map((r) => `[${r.file_name}] (${r.file_path}): ${r.excerpt}`)
        .join('\n');
    }

    showTypingBubble();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(`${BACKEND_URL}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          provider: selected?.provider,
          model: selected?.model,
          context,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) appendMessage(`Error: ${data.error || res.statusText}`, false);
      else if (!data.ok) appendMessage(`Error: ${data.error || 'Unknown'}`, false);
      else if (Array.isArray(data.responses)) {
        const responseContent = data.responses[0]?.content;
        if (selected && responseContent) {
          appendMessage(responseContent, false);
          extractAndSaveMemory(text, responseContent);
        } else {
          data.responses.forEach((r) => { if (r?.content) appendMessage(`${r.provider}: ${r.content}`, false); });
        }
      }
    } catch (err) {
      const errMsg = err.name === 'AbortError' ? 'Request timed out' : (err.message || 'Backend unreachable');
      appendMessage(`Error: ${errMsg}`, false);
    } finally {
      hideTypingBubble();
      input.focus();
      updateSendState();
    }
    return;
  }

  input.value = '';
  sendBtn.disabled = true;

  let context = {};
  try {
    if (window.electronAPI && typeof window.electronAPI.getDeviceContext === 'function') {
      context = await window.electronAPI.getDeviceContext();
    } else {
      context = getFallbackContext();
    }
  } catch (_) {
    context = getFallbackContext();
  }

  const relevantChunks = await getRelevantMemory(text);
  if (relevantChunks.length > 0) {
    context.user_memory = relevantChunks.map((c) => c.content).join(' | ');
  }

  const knowledgeResults2 = await getRelevantKnowledge(text);
  if (knowledgeResults2.length > 0) {
    context.knowledge_context = knowledgeResults2
      .map((r) => `[${r.file_name}] (${r.file_path}): ${r.excerpt}`)
      .join('\n');
  }

  const requestPayload = {
    id: nextQueueId++,
    text,
    provider: selected.provider,
    model: selected.model,
    context,
  };

  if (!activeAgentWorkflow) {
    lastSentUserMessage = text;
    currentWorkflowMessageId = appendMessage(text);
    // First user message in a new conversation: kick off background title generation.
    maybeGenerateConversationTitleInBackground(text, selected.provider, selected.model);
    activeAgentWorkflow = true;
    cancellingWorkflow = false;
    updateSendState();
    showTypingBubble();
    try {
      await ensureWs();
      ws.send(JSON.stringify({
        type: 'start',
        payload: {
          message: requestPayload.text,
          provider: requestPayload.provider,
          model: requestPayload.model,
          context: requestPayload.context,
          conversation_history: buildContextForBackend(),
        },
      }));
    } catch (err) {
      activeAgentWorkflow = false;
      hideTypingBubble();
      appendMessage(`Error: ${err.message || 'WebSocket failed'}`, false);
      updateSendState();
    }
  } else {
    queuedAgentRequests.push(requestPayload);
    renderQueue();
    input.focus();
    updateSendState();
  }
}

function updateSendState() {
  const hasText = !!input.value.trim();
  const useAgentCheckboxEl = document.getElementById('use-agent');
  const agentEnabled = !!(useAgentCheckboxEl && useAgentCheckboxEl.checked);

  if (activeAgentWorkflow && agentEnabled) {
    if (hasText) {
      sendBtn.disabled = false;
      sendBtn.dataset.mode = 'send';
      sendBtn.classList.remove('cancel-mode');
      sendBtn.classList.add('send-mode');
      if (sendIconSend) sendIconSend.style.display = 'inline-flex';
      if (sendIconCancel) sendIconCancel.style.display = 'none';
    } else {
      sendBtn.disabled = false;
      sendBtn.dataset.mode = 'cancel';
      sendBtn.classList.remove('send-mode');
      sendBtn.classList.add('cancel-mode');
      if (sendIconSend) sendIconSend.style.display = 'none';
      if (sendIconCancel) sendIconCancel.style.display = 'inline-flex';
    }
    return;
  }

  sendBtn.dataset.mode = 'send';
  sendBtn.classList.remove('cancel-mode');
  sendBtn.classList.add('send-mode');
  if (sendIconSend) sendIconSend.style.display = 'inline-flex';
  if (sendIconCancel) sendIconCancel.style.display = 'none';
  sendBtn.disabled = !hasText;
}

function cancelCurrentWorkflow() {
  if (!activeAgentWorkflow) return;

  cancellingWorkflow = true;
  activeAgentWorkflow = false;
  hideTypingBubble();

  const d = document.createElement('div');
  d.className = 'workflow-stopped';
  d.textContent = 'Stopped.';
  messagesEl.appendChild(d);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  currentConversationMessages.push({
    type: 'workflow_stopped',
    reason: 'Stopped.',
    timestamp: new Date().toISOString(),
  });
  saveCurrentConversation();

  updateSendState();
  input.focus();

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    cancellingWorkflow = false;
    return;
  }
  ws.send(JSON.stringify({
    type: 'stop',
    payload: { reason: 'Stopped.' },
  }));
}

async function handleSendOrCancel() {
  const mode = sendBtn.dataset.mode || 'send';
  if (mode === 'cancel') {
    cancelCurrentWorkflow();
  } else {
    await send();
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

input.addEventListener('input', updateSendState);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSendOrCancel();
  }
});
sendBtn.addEventListener('click', () => {
  handleSendOrCancel();
});

if (newChatBtn) {
  newChatBtn.addEventListener('click', () => {
    if (activeAgentWorkflow) return;
    startNewConversation();
  });
}

if (memoryBtn) {
  memoryBtn.addEventListener('click', () => {
    if (memoryPanel?.style.display === 'none' || !memoryPanel?.style.display) {
      openMemoryPanel();
    } else {
      closeMemoryPanel();
    }
  });
}

if (memoryCloseBtn) {
  memoryCloseBtn.addEventListener('click', closeMemoryPanel);
}

if (memoryClearAllBtn) {
  memoryClearAllBtn.addEventListener('click', async () => {
    if (window.electronAPI?.saveMemory) {
      await window.electronAPI.saveMemory([]);
    }
    renderMemoryPanel();
  });
}

updateSendState();

// Default to Agent mode on app open
const useAgentCheckbox = document.getElementById('use-agent');
if (useAgentCheckbox) {
  useAgentCheckbox.checked = true;
}

// ─── Indexing indicator (top-right pill, pushed from main process) ────────────

const indexingIndicator = document.getElementById('indexing-indicator');
const indexingText = document.getElementById('indexing-indicator-text');
const indexingCount = document.getElementById('indexing-indicator-count');

function updateIndexingIndicator(status) {
  if (!indexingIndicator) return;
  if (status.active) {
    if (status.phase === 'scanning') {
      indexingText.textContent = 'Scanning';
      const processed = (status.total_processed || 0).toLocaleString();
      indexingCount.textContent = `${processed} files`;
    } else if (status.phase === 'embedding') {
      indexingText.textContent = 'Embedding';
      const done = (status.files_embedded || 0).toLocaleString();
      const total = (status.files_to_embed || 0).toLocaleString();
      indexingCount.textContent = `${done}/${total}`;
    } else {
      indexingText.textContent = 'Indexing';
      indexingCount.textContent = '';
    }
    indexingIndicator.style.display = 'flex';
  } else {
    indexingIndicator.style.display = 'none';
  }
}

if (window.electronAPI?.onKnowledgeProgress) {
  window.electronAPI.onKnowledgeProgress(updateIndexingIndicator);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadModels();
refreshSidebar();
