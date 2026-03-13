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

const input = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const sendIconSend = document.getElementById('send-icon-send');
const sendIconCancel = document.getElementById('send-icon-cancel');
const messagesEl = document.getElementById('messages');
const modelSelect = document.getElementById('model-select');
const queueContainer = document.getElementById('queue-container');

let availableModels = [];
let typingBubble = null;
let ws = null;
let wsReady = false;
let currentTerminalBlock = null;
let currentTerminalPre = null;
let activeAgentWorkflow = false;
let queuedAgentRequests = [];
let nextQueueId = 1;
let cancellingWorkflow = false;

// Wire up streaming output from Electron main (user-side command execution).
if (window.electronAPI && typeof window.electronAPI.onCommandStream === 'function') {
  window.electronAPI.onCommandStream((msg) => {
    if (!msg || typeof msg.data !== 'string') return;
    if (!currentTerminalPre) return;
    currentTerminalPre.textContent += msg.data;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}
function appendMessage(text, isUser = true) {
  const div = document.createElement('div');
  div.className = `message ${isUser ? 'user' : 'assistant'}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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

  // Now that it is actually starting, show the queued user message in the chat.
  appendMessage(next.text);
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

function onWsMessage(ev) {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch (_) {
    return;
  }
  const typ = msg.type;
  if (cancellingWorkflow && typ !== 'workflow_stopped') {
    // Ignore any in-flight messages from a workflow we've cancelled.
    return;
  }
  if (typ === 'plan') {
    hideTypingBubble();
    showPlan(msg.plan);
    return;
  }
  if (typ === 'error') {
    hideTypingBubble();
    appendMessage(`Error: ${msg.error || 'Unknown'}`, false);
    activeAgentWorkflow = false;
    cancellingWorkflow = false;
    startNextQueuedAgentRequest();
    input.focus();
    updateSendState();
    return;
  }
  if (typ === 'step_start') {
    const badge = document.createElement('div');
    badge.className = 'step-badge';
    badge.textContent = `Step ${msg.step_id}: ${msg.description || ''}`;
    messagesEl.appendChild(badge);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }
  if (typ === 'step_message' && msg.message) {
    appendMessage(msg.message, false);
    return;
  }
  if (typ === 'run_command_start') {
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
    messagesEl.appendChild(d);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    currentTerminalBlock = d;
    currentTerminalPre = pre;

    // Kick off command execution on the user's machine via Electron main.
    if (window.electronAPI && typeof window.electronAPI.runInteractiveCommand === 'function') {
      window.electronAPI.runInteractiveCommand(msg.command || '').then((result) => {
        // Send the final result back to the backend so the agent can continue.
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'command_result',
            payload: {
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
  // Note: 'command_result' messages now flow from the renderer TO backend, not from backend to renderer.
  if (typ === 'step_complete') {
    const d = document.createElement('div');
    d.className = 'step-badge';
    d.textContent = `Step ${msg.step_id} complete`;
    messagesEl.appendChild(d);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }
  if (typ === 'workflow_done') {
    if (msg.summary && msg.summary.trim()) {
      const d = document.createElement('div');
      d.className = 'workflow-done';
      const summaryEl = document.createElement('div');
      summaryEl.className = 'workflow-done-summary';
      summaryEl.innerHTML = renderMarkdown(msg.summary);
      d.appendChild(summaryEl);
      messagesEl.appendChild(d);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
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
      // Disable all interactive elements
      block.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
      // Echo the chosen answer as a user bubble
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
    // Only show the message if we didn't already show it optimistically on click.
    if (!cancellingWorkflow) {
      const d = document.createElement('div');
      d.className = 'workflow-stopped';
      d.textContent = msg.reason || 'Stopped.';
      messagesEl.appendChild(d);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    activeAgentWorkflow = false;
    cancellingWorkflow = false;
    startNextQueuedAgentRequest();
    input.focus();
    updateSendState();
    return;
  }
}

function showPlan(planData) {
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
  messagesEl.appendChild(block);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showCommandResult(stdout, stderr, returncode) {
  const block = document.createElement('div');
  block.className = 'command-result-block';
  const lines = [];
  if (returncode !== undefined && returncode !== 0) lines.push(`Exit code: ${returncode}`);
  if (stderr && stderr.trim()) lines.push('Stderr:\n' + stderr.trim());
  if (stdout && stdout.trim()) lines.push('Output:\n' + stdout.trim());
  block.textContent = lines.length ? lines.join('\n\n') : '(no output)';
  messagesEl.appendChild(block);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

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

async function send() {
  const text = input.value.trim();
  if (!text) return;
  const useAgent = document.getElementById('use-agent').checked;
  const selected = getSelectedModel();

  // Non-agent or no model selected: behave as a simple chat, no queueing.
  if (!useAgent || !selected) {
    appendMessage(text);
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
        if (selected && data.responses[0]?.content) appendMessage(data.responses[0].content, false);
        else data.responses.forEach((r) => { if (r?.content) appendMessage(`${r.provider}: ${r.content}`, false); });
      }
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Request timed out' : (err.message || 'Backend unreachable');
      appendMessage(`Error: ${msg}`, false);
    } finally {
      hideTypingBubble();
      input.focus();
      updateSendState();
    }
    return;
  }

  // Agent mode with a selected model: support queueing.
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

  const requestPayload = {
    id: nextQueueId++,
    text,
    provider: selected.provider,
    model: selected.model,
    context,
  };

  if (!activeAgentWorkflow) {
    // First / only active workflow: show immediately in chat.
    appendMessage(text);
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
        },
      }));
    } catch (err) {
      activeAgentWorkflow = false;
      hideTypingBubble();
      appendMessage(`Error: ${err.message || 'WebSocket failed'}`, false);
      updateSendState();
    }
  } else {
    // Already running: just enqueue; don't show user bubble yet.
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
      // While a task is running, any text means "queue this" (send mode with arrow).
      sendBtn.disabled = false;
      sendBtn.dataset.mode = 'send';
      sendBtn.classList.remove('cancel-mode');
      sendBtn.classList.add('send-mode');
      if (sendIconSend) sendIconSend.style.display = 'inline-flex';
      if (sendIconCancel) sendIconCancel.style.display = 'none';
    } else {
      // No text while a task is running: show cancel/stop button.
      sendBtn.disabled = false;
      sendBtn.dataset.mode = 'cancel';
      sendBtn.classList.remove('send-mode');
      sendBtn.classList.add('cancel-mode');
      if (sendIconSend) sendIconSend.style.display = 'none';
      if (sendIconCancel) sendIconCancel.style.display = 'inline-flex';
    }
    return;
  }

  // No active agent workflow: standard send behavior with up-arrow.
  sendBtn.dataset.mode = 'send';
  sendBtn.classList.remove('cancel-mode');
  sendBtn.classList.add('send-mode');
  if (sendIconSend) sendIconSend.style.display = 'inline-flex';
  if (sendIconCancel) sendIconCancel.style.display = 'none';
  sendBtn.disabled = !hasText;
}

function cancelCurrentWorkflow() {
  if (!activeAgentWorkflow) return;

  // Immediately update UI — don't wait for backend confirmation.
  cancellingWorkflow = true;
  activeAgentWorkflow = false;
  hideTypingBubble();

  const d = document.createElement('div');
  d.className = 'workflow-stopped';
  d.textContent = 'Stopped.';
  messagesEl.appendChild(d);
  messagesEl.scrollTop = messagesEl.scrollHeight;

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
updateSendState();

// Default to Agent mode on app open
const useAgentCheckbox = document.getElementById('use-agent');
if (useAgentCheckbox) {
  useAgentCheckbox.checked = true;
}

loadModels();
