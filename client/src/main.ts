import "./style.css";
import { WsClient } from "./transport/wsClient";
import { createClientState } from "./state/clientState";
import { SessionController } from "./session/SessionController";
import { cryptoClient } from "./crypto/keys";

const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) throw new Error("No #app container found");

const state = createClientState();
const ws = new WsClient();

let currentSessionCode = ""; // Track the active auto-generated or joined code

const sessionCtrl = new SessionController(ws, state, {
  onPhaseChange: () => renderUIState(),
  onError: () => renderUIState(),
  onFingerprintAvailable: () => renderUIState(),
  onMessageDecrypted: (text) => {
    messages.push({ text, timestamp: Date.now(), isSelf: false });
    renderMessages();
  },
  onFileReceived: (fileBlob, fileName) => {
    const url = URL.createObjectURL(fileBlob);
    const html = `Attachment: <a href="${url}" download="${escapeHtml(
      fileName,
    )}" style="color: var(--tactical-green); text-decoration: none;">Download ${escapeHtml(
      fileName,
    )}</a>`;
    messages.push({
      text: html,
      timestamp: Date.now(),
      isSelf: false,
      isHtml: true,
    });
    renderMessages();
  },
});

// --- Professional & Accessible Articles ---
const articles = {
  protection: {
    title: "How Your Data is Protected",
    content: `
      <p>OnlyTwo uses strict <strong>End-to-End Encryption</strong>. Before any message or file leaves your device, it is locked using a highly secure key.</p>
      <p>The only key that can unlock it exists exclusively on your peer's device. We do not have the keys, meaning it is physically impossible for our servers, our developers, or network providers to read your messages or view your files.</p>
      <p>Furthermore, the lock changes after every single message. Even if someone were to compromise your device in the future, they cannot decipher messages you sent in the past.</p>
    `,
  },
  retention: {
    title: "Data Retention & Storage",
    content: `
      <p>Traditional chat apps store your message history in cloud databases. <strong>We do not.</strong></p>
      <p>Our server operates purely as a relay—a digital pipe. It receives an encrypted message from you and immediately pushes it to your peer. We do not use databases, and we do not save your files.</p>
      <p>The moment you close this app or end the session, all connection data is instantly erased from our server's memory. Your chat history lives solely on your screen and vanishes when you leave.</p>
    `,
  },
  verification: {
    title: "Verifying Your Connection",
    content: `
      <p>How do you know you are actually talking to your peer and not an imposter intercepting the connection?</p>
      <p>Once connected, a <strong>Security Code</strong> appears at the top of your chat. This code is mathematically generated based on your secure connection. If your code and your peer's code match exactly, your connection is guaranteed to be secure and strictly between the two of you.</p>
      <p>We recommend verifying this code with your peer over a phone call or in person before sharing sensitive information.</p>
    `,
  },
  privacy: {
    title: "Privacy & Anonymity",
    content: `
      <p>We believe privacy is a fundamental right. Because of this, OnlyTwo is designed to require absolutely <strong>no personal information</strong>.</p>
      <p>We do not ask for your phone number, email address, or name. There are no accounts to register, and no profiles to create. You are entirely anonymous.</p>
      <p>To further protect your identity, we recommend using this service while connected to a trusted VPN, which will hide your personal IP address from your network provider.</p>
    `,
  },
};

// --- DOM Assembly ---
const root = document.createElement("div");
root.className = "onlytwo-root";

const header = document.createElement("header");
header.className = "onlytwo-header";
header.innerHTML = `<h1>OnlyTwo</h1><div class="status-badge" id="status-badge">Waiting...</div>`;

const infoPanel = document.createElement("div");
infoPanel.className = "info-panel";
infoPanel.innerHTML = `
  <h3>Security Documentation</h3>
  <div style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 8px;">Learn how OnlyTwo guarantees your privacy before connecting.</div>
  <div class="doc-links">
    <button class="doc-btn" data-article="protection">Data Protection</button>
    <button class="doc-btn" data-article="retention">Data Storage</button>
    <button class="doc-btn" data-article="verification">Connection Verification</button>
    <button class="doc-btn" data-article="privacy">Anonymity Policy</button>
  </div>
`;

const securityBar = document.createElement("div");
securityBar.className = "onlytwo-security-bar";
securityBar.style.display = "none";

const sessionSection = document.createElement("section");
sessionSection.className = "session-form";
sessionSection.style.flexDirection = "column";

const createBtn = document.createElement("button");
createBtn.type = "button";
createBtn.textContent = "Create New Secure Chat";
createBtn.style.marginBottom = "1rem";

const divider = document.createElement("div");
divider.textContent = "— OR —";
divider.style.marginBottom = "1rem";
divider.style.textAlign = "center";
divider.style.color = "var(--text-muted)";

const joinContainer = document.createElement("div");
joinContainer.style.display = "flex";
joinContainer.style.gap = "8px";
joinContainer.style.width = "100%";

const joinInput = document.createElement("input");
joinInput.type = "text";
joinInput.placeholder = "Enter Invite Code";
joinInput.style.flex = "1";

const joinBtn = document.createElement("button");
joinBtn.type = "button";
joinBtn.textContent = "Join";

joinContainer.append(joinInput, joinBtn);
sessionSection.append(createBtn, divider, joinContainer);

const chatSection = document.createElement("section");
chatSection.className = "onlytwo-chat";
chatSection.style.display = "none";

const messagesContainer = document.createElement("div");
messagesContainer.className = "messages";

const chatForm = document.createElement("form");
chatForm.className = "chat-form";
const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.id = "fileInput";
fileInput.style.display = "none";
const fileLabelBtn = document.createElement("label");
fileLabelBtn.htmlFor = "fileInput";
fileLabelBtn.className = "file-btn";
fileLabelBtn.textContent = "Attach File";
const messageInput = document.createElement("input");
messageInput.type = "text";
messageInput.placeholder = "Type a message...";
const sendBtn = document.createElement("button");
sendBtn.type = "submit";
sendBtn.textContent = "Send";
const disconnectBtn = document.createElement("button");
disconnectBtn.type = "button";
disconnectBtn.className = "btn-danger";
disconnectBtn.textContent = "End Session";

chatForm.append(fileLabelBtn, fileInput, messageInput, sendBtn, disconnectBtn);
chatSection.append(messagesContainer, chatForm);

// Modal Container
const modal = document.createElement("div");
modal.className = "modal-overlay";
modal.style.display = "none";
modal.innerHTML = `
  <div class="modal-content">
    <h2 id="modal-title"></h2>
    <div id="modal-body"></div>
    <button class="close-modal" id="close-modal">Close</button>
  </div>
`;

root.append(header, infoPanel, securityBar, sessionSection, chatSection, modal);
appEl.appendChild(root);

const messages: {
  text: string;
  timestamp: number;
  isSelf: boolean;
  isHtml?: boolean;
}[] = [];

// --- Logic & Events ---

document.querySelectorAll(".doc-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const key = (e.target as HTMLElement).getAttribute(
      "data-article",
    ) as keyof typeof articles;
    document.getElementById("modal-title")!.innerHTML = articles[key].title;
    document.getElementById("modal-body")!.innerHTML = articles[key].content;
    modal.style.display = "flex";
  });
});
document.getElementById("close-modal")!.addEventListener("click", () => {
  modal.style.display = "none";
});

function renderUIState() {
  const badge = document.getElementById("status-badge")!;
  const isActiveSession = currentSessionCode !== ""; // Enter chat view immediately upon generating code
  const isFullyConnected = state.handshakeComplete; // Only true when BOTH are connected

  if (isFullyConnected) {
    badge.textContent = "Connection Secure";
    badge.className = "status-badge secure";
  } else if (isActiveSession) {
    badge.textContent = "Waiting for Peer...";
    badge.className = "status-badge";
  } else {
    badge.textContent = state.lastError
      ? `Error: ${state.lastError}`
      : "Disconnected";
    badge.className = "status-badge";
  }

  // Toggle main views based on if we have started a session
  infoPanel.style.display = isActiveSession ? "none" : "block";
  sessionSection.style.display = isActiveSession ? "none" : "flex";
  chatSection.style.display = isActiveSession ? "flex" : "none";

  // Lock chat inputs while waiting for the peer
  messageInput.disabled = !isFullyConnected;
  sendBtn.disabled = !isFullyConnected;
  fileInput.disabled = !isFullyConnected;
  if (!isFullyConnected) {
    messageInput.placeholder = "Waiting for peer to join...";
  } else {
    messageInput.placeholder = "Type a message...";
  }

  // Security Bar UI states
  if (isActiveSession && !isFullyConnected) {
    // Show invite code prominently while waiting for the peer inside the chat view
    securityBar.style.display = "block";
    securityBar.style.textAlign = "center";
    securityBar.innerHTML = `
      <div style="margin-bottom: 5px;">Waiting for peer... Share this code:</div>
      <div style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; user-select: all; word-break: break-all; font-family: monospace; font-size: 1.2rem; font-weight: bold; color: white;">
        ${currentSessionCode}
      </div>
    `;
  } else if (isFullyConnected && state.fingerprintPhrase) {
    // Both joined -> display the verification string
    securityBar.style.display = "flex";
    securityBar.style.textAlign = "left";
    securityBar.innerHTML = `
      <span>Security Code: <span class="fingerprint-code">${state.fingerprintPhrase}</span></span>
      <span style="color: var(--text-muted); font-size: 0.75rem;">(Verify with peer)</span>
    `;
  } else {
    securityBar.style.display = "none";
  }
}

function renderMessages() {
  messagesContainer.innerHTML = "";
  for (const m of messages) {
    const div = document.createElement("div");
    div.className = `message-item ${m.isSelf ? "self" : ""}`;
    const timeStr = new Date(m.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    const timeEl = `<span class="message-time">${
      m.isSelf ? "You" : "Peer"
    } • ${timeStr}</span>`;
    const contentEl = m.isHtml ? m.text : escapeHtml(m.text);

    div.innerHTML = `${timeEl}<span>${contentEl}</span>`;
    messagesContainer.appendChild(div);
  }
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(s: string) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// Generate an alphanumeric string of length 12
function generateSessionId() {
  const array = new Uint32Array(3);
  crypto.getRandomValues(array);
  return Array.from(array, (dec) => dec.toString(36))
    .join("")
    .substring(0, 12);
}

createBtn.addEventListener("click", () => {
  currentSessionCode = generateSessionId();
  sessionCtrl.startSession(currentSessionCode);
  renderUIState();
});

joinBtn.addEventListener("click", () => {
  const code = joinInput.value.trim();
  if (!code) return;
  currentSessionCode = code;
  sessionCtrl.startSession(code);
  renderUIState();
});

disconnectBtn.addEventListener("click", () => {
  sessionCtrl.endSession();
  messages.length = 0;
  currentSessionCode = "";
  renderMessages();
  renderUIState();
});

chatForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  try {
    const { ciphertext, nonce, counter } =
      await cryptoClient.encryptMessage(text);
    ws.sendChat(ciphertext, nonce, counter);

    messages.push({ text, timestamp: Date.now(), isSelf: true });
    renderMessages();
    messageInput.value = "";
  } catch (err) {
    console.error("Encryption error:", err);
  }
});

fileInput.addEventListener("change", async () => {
  if (!fileInput.files || fileInput.files.length === 0) return;
  const file = fileInput.files[0];

  messages.push({
    text: `System: Encrypting and sending ${file.name}...`,
    timestamp: Date.now(),
    isSelf: true,
  });
  renderMessages();

  try {
    await sessionCtrl.sendFile(file);
    messages.push({
      text: `System: File sent securely.`,
      timestamp: Date.now(),
      isSelf: true,
    });
    renderMessages();
  } catch (err) {
    alert("File transfer failed.");
  } finally {
    fileInput.value = "";
  }
});

renderUIState();
