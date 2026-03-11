const BACKEND_URL = 'http://127.0.0.1:8765';

const input = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const messagesEl = document.getElementById('messages');

function appendMessage(text, isUser = true) {
  const div = document.createElement('div');
  div.className = 'message user';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function send() {
  const text = input.value.trim();
  if (!text) return;
  appendMessage(text);
  input.value = '';
  sendBtn.disabled = true;
  try {
    const res = await fetch(`${BACKEND_URL}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) appendMessage(`Error: ${data.error || res.statusText}`);
    else if (!data.ok) appendMessage(`Error: ${data.error || 'Unknown'}`);
  } catch (err) {
    appendMessage(`Error: ${err.message || 'Backend unreachable'}`);
  } finally {
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
