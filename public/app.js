const form = document.getElementById('transfer-form');
const logOutput = document.getElementById('log-output');
const statusBadge = document.getElementById('session-status');
const sendButton = document.getElementById('send-button');
const clearButton = document.getElementById('clear-console');

let eventSource;

function setStatus(text, variant = 'idle') {
  statusBadge.textContent = text;
  statusBadge.dataset.variant = variant;
}

function appendLog({ level = 'info', message, timestamp = new Date().toISOString() }) {
  const entry = document.createElement('div');
  entry.className = `entry level-${level}`;

  const time = document.createElement('span');
  time.className = 'timestamp';
  const date = new Date(timestamp);
  time.textContent = date.toLocaleTimeString();

  const text = document.createElement('span');
  const safeMessage = typeof message === 'string' ? message : String(message ?? '');
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  let lastIndex = 0;
  let match;
  while ((match = urlRegex.exec(safeMessage)) !== null) {
    if (match.index > lastIndex) {
      text.appendChild(document.createTextNode(safeMessage.slice(lastIndex, match.index)));
    }
    const link = document.createElement('a');
    link.href = match[0];
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = match[0];
    text.appendChild(link);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < safeMessage.length) {
    text.appendChild(document.createTextNode(safeMessage.slice(lastIndex)));
  }

  entry.appendChild(time);
  entry.appendChild(text);
  logOutput.appendChild(entry);
  logOutput.scrollTop = logOutput.scrollHeight;
}

function clearLogs() {
  logOutput.innerHTML = '';
}

function closeEventSource() {
  if (eventSource) {
    eventSource.close();
    eventSource = undefined;
  }
}

async function submitForm(event) {
  event.preventDefault();
  closeEventSource();
  clearLogs();
  setStatus('Sending…', 'running');
  sendButton.disabled = true;

  const formData = new FormData(form);
  const payload = {};

  for (const [key, value] of formData.entries()) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      payload[key] = trimmed;
    }
  }

  try {
    const response = await fetch('/api/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      appendLog({ level: 'error', message: `Failed to start session: ${errorText}` });
      setStatus('Error', 'error');
      sendButton.disabled = false;
      return;
    }

    const { sessionId } = await response.json();
    appendLog({ level: 'info', message: `Session started. ID: ${sessionId}` });

    eventSource = new EventSource(`/api/events/${sessionId}`);

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        appendLog(payload);
        if (payload.level === 'success' && payload.message.includes('Transaction submitted')) {
          setStatus('Pending…', 'running');
        }
        if (payload.level === 'success' && payload.message.includes('confirmed')) {
          setStatus('Confirmed', 'idle');
        }
        if (payload.level === 'error') {
          setStatus('Error', 'error');
        }
      } catch (error) {
        appendLog({ level: 'error', message: `Failed to parse server message: ${error.message}` });
        setStatus('Error', 'error');
      }
    };

    eventSource.addEventListener('end', () => {
      appendLog({ level: 'info', message: 'Session complete.' });
      setStatus('Idle', 'idle');
      sendButton.disabled = false;
      closeEventSource();
    });

    eventSource.onerror = () => {
      appendLog({ level: 'warn', message: 'Lost connection to server. Check the terminal for details.' });
      setStatus('Disconnected', 'error');
      sendButton.disabled = false;
      closeEventSource();
    };
  } catch (error) {
    appendLog({ level: 'error', message: `Failed to submit request: ${error.message}` });
    setStatus('Error', 'error');
    sendButton.disabled = false;
  }
}

form.addEventListener('submit', submitForm);
clearButton.addEventListener('click', () => {
  clearLogs();
  appendLog({ level: 'info', message: 'Console cleared.' });
});

appendLog({
  level: 'info',
  message:
    'Ready. Fill in the form with your mainnet configuration. Values left blank fall back to the server .env file.',
});
setStatus('Idle', 'idle');
