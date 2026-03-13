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
      appendMessage(msg.text, true, false);
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
 */
function appendMessage(text, isUser = true, record = true) {
  const div = document.createElement('div');
  div.className = `message ${isUser ? 'user' : 'assistant'}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  if (record) {
    if (isUser && !conversationTitle) {
      conversationTitle = text.length > 60 ? text.slice(0, 60) + '…' : text;
    }
    currentConversationMessages.push({
      type: isUser ? 'user' : 'assistant',
      text,
      timestamp: new Date().toISOString(),
    });
    saveCurrentConversation();
  }
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
  appendMessage(next.text);
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

/** Fire-and-forget: extract memory from an exchange and persist any new chunks. */
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

      const now = new Date().toISOString();
      const newChunks = data.chunks.map((content) => ({ id: generateId(), content, createdAt: now }));
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

  const requestPayload = {
    id: nextQueueId++,
    text,
    provider: selected.provider,
    model: selected.model,
    context,
  };

  if (!activeAgentWorkflow) {
    lastSentUserMessage = text;
    appendMessage(text);
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

// ─── Init ─────────────────────────────────────────────────────────────────────

loadModels();
refreshSidebar();
