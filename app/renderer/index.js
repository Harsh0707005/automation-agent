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

function send() {
  const text = input.value.trim();
  if (!text) return;
  appendMessage(text);
  input.value = '';
  sendBtn.disabled = true;
  input.focus();
  setTimeout(() => { sendBtn.disabled = false; }, 0);
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
