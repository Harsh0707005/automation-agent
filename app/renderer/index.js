const BACKEND_URL = 'http://127.0.0.1:8765';

const input = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const messagesEl = document.getElementById('messages');
const modelSelect = document.getElementById('model-select');

let availableModels = [];
let typingBubble = null;

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

async function loadModels() {
  try {
    const res = await fetch(`${BACKEND_URL}/models`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || res.statusText);
    }
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

async function send() {
  const text = input.value.trim();
  if (!text) return;
  appendMessage(text);
  input.value = '';
  sendBtn.disabled = true;
  showTypingBubble();
  const selected = getSelectedModel();
  const body = {
    message: text,
  };
  if (selected) {
    body.provider = selected.provider;
    body.model = selected.model;
  }
  try {
    const res = await fetch(`${BACKEND_URL}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      appendMessage(`Error: ${data.error || res.statusText}`, false);
    } else if (!data.ok) {
      appendMessage(`Error: ${data.error || 'Unknown'}`, false);
    } else if (Array.isArray(data.responses)) {
      if (selected) {
        const r = data.responses[0];
        if (r && r.content) appendMessage(r.content, false);
      } else {
        for (const r of data.responses) {
          if (r && r.content) {
            appendMessage(`${r.provider}: ${r.content}`, false);
          }
        }
      }
    }
  } catch (err) {
    appendMessage(`Error: ${err.message || 'Backend unreachable'}`, false);
  } finally {
    hideTypingBubble();
    sendBtn.disabled = false;
    input.focus();
  }
}

function updateSendState() {
  sendBtn.disabled = !input.value.trim();
}

input.addEventListener('input', updateSendState);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
sendBtn.addEventListener('click', send);
updateSendState();
loadModels();
