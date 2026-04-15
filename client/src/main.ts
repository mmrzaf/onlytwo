import "./style.css";
import { WsClient } from "./transport/wsClient";
import { createClientState } from "./state/clientState";
import { SessionController } from "./session/SessionController";
import { cryptoClient } from "./crypto/keys";

const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) throw new Error("No #app container found");

const state = createClientState();
const ws = new WsClient();

// Session Controller
const sessionCtrl = new SessionController(ws, state, {
  onPhaseChange: (phase) => {
    renderStatusBar();
    renderControls();
    if (phase === "session_ready") renderSecuritySection();
  },
  onError: () => renderStatusBar(),
  onFingerprintAvailable: () => renderSecuritySection(),
  onMessageDecrypted: (text) => {
    messages.push({ text, timestamp: Date.now() });
    renderMessages();
  },
});

// --- DOM elements ---
const root = document.createElement("div");
root.className = "onlytwo-root";

const header = document.createElement("header");
header.className = "onlytwo-header";
header.innerHTML = `<h1>OnlyTwo</h1>`;

const statusBar = document.createElement("div");
statusBar.className = "onlytwo-status-bar";

const securityBar = document.createElement("div");
securityBar.className = "onlytwo-security-bar";
securityBar.style.margin = "8px 0";

const sessionSection = document.createElement("section");
sessionSection.className = "onlytwo-session";

const chatSection = document.createElement("section");
chatSection.className = "onlytwo-chat";

const messages: { text: string; timestamp: number }[] = [];

// Session UI
const sessionForm = document.createElement("form");
sessionForm.className = "session-form";
sessionForm.autocomplete = "off";

const sessionLabel = document.createElement("label");
sessionLabel.textContent = "Session code";

const sessionInput = document.createElement("input");
sessionInput.type = "text";

const connectBtn = document.createElement("button");
connectBtn.type = "submit";
connectBtn.textContent = "Connect";

const disconnectBtn = document.createElement("button");
disconnectBtn.type = "button";
disconnectBtn.textContent = "Disconnect";
disconnectBtn.disabled = true;

sessionLabel.appendChild(sessionInput);
sessionForm.appendChild(sessionLabel);
sessionForm.appendChild(connectBtn);
sessionForm.appendChild(disconnectBtn);
sessionSection.appendChild(sessionForm);

// Chat UI
const messagesContainer = document.createElement("div");
messagesContainer.className = "messages";
const messageList = document.createElement("ul");
messageList.className = "message-list";
messagesContainer.appendChild(messageList);

const chatForm = document.createElement("form");
chatForm.className = "chat-form";

const messageInput = document.createElement("input");
messageInput.type = "text";
messageInput.placeholder = "Type a message and press Enter…";

const sendBtn = document.createElement("button");
sendBtn.type = "submit";
sendBtn.textContent = "Send";

chatForm.appendChild(messageInput);
chatForm.appendChild(sendBtn);

// Assemble DOM
chatSection.appendChild(messagesContainer);
chatSection.appendChild(chatForm);
root.appendChild(header);
root.appendChild(statusBar);
root.appendChild(securityBar);
root.appendChild(sessionSection);
root.appendChild(chatSection);
appEl.innerHTML = "";
appEl.appendChild(root);

// --- Rendering helpers ---
function renderStatusBar() {
  const phase = state.phase.toUpperCase();
  const err = state.lastError ? ` – ${state.lastError}` : "";
  statusBar.textContent = `Status: ${phase}${err}`;
}

function renderSecuritySection() {
  if (!state.handshakeComplete) {
    securityBar.textContent = "";
    return;
  }

  const fingerprint = state.fingerprintPhrase ?? "";
  securityBar.innerHTML = `
    <div>
      <strong>Secure session active</strong><br/>
      Fingerprint: <code>${fingerprint}</code>
    </div>
  `;
}

function renderControls() {
  const phase = state.phase;

  const connected =
    phase === "handshaking" ||
    phase === "session_ready" ||
    phase === "chatting";

  sessionInput.disabled = connected || phase === "connecting";
  connectBtn.disabled = connected || phase === "connecting";
  disconnectBtn.disabled = !connected;

  const chatting = phase === "chatting";
  messageInput.disabled = !chatting;
  sendBtn.disabled = !chatting;
}

function renderMessages() {
  messageList.innerHTML = "";
  for (const m of messages) {
    const li = document.createElement("li");
    const timeStr = new Date(m.timestamp).toLocaleTimeString();
    li.innerHTML = `<span class="message-time">[${timeStr}]</span> ${escapeHtml(m.text)}`;
    messageList.appendChild(li);
  }
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(s: string) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// --- Events ---
sessionForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const code = sessionInput.value.trim();
  if (!code) return alert("Enter a session code.");
  sessionCtrl.startSession(code);
  renderControls();
});

disconnectBtn.addEventListener("click", () => sessionCtrl.endSession());
chatForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  try {
    const { ciphertext, nonce, counter } =
      await cryptoClient.encryptMessage(text);
    ws.sendChat(ciphertext, nonce, counter);

    messages.push({ text, timestamp: Date.now() });
    renderMessages();
    messageInput.value = "";
  } catch (err) {
    console.error("Encryption error:", err);
  }
});

// Initial render
renderStatusBar();
renderControls();
renderMessages();
renderSecuritySection();
