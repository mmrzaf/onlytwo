import "./style.css";
import { WsClient } from "./transport/wsClient";
import { createClientState } from "./state/clientState";
import { SessionController } from "./session/SessionController";
import { cryptoClient } from "./crypto/keys";

import { createAppDom } from "./ui/dom";
import { MessageStore } from "./ui/messages";
import { renderUIState } from "./ui/statusBar";
import { setupModalHandlers } from "./ui/modal";
import { setupKeyboardShortcuts } from "./ui/shortcuts";
import { escapeHtml } from "./utils/escapeHtml";
import { generateSessionId } from "./utils/sessionId";

// Attach to root
const appEl = document.querySelector<HTMLDivElement>("#app");
if (!appEl) throw new Error("No #app container found");

const dom = createAppDom();
appEl.appendChild(dom.root);

// Core state
const state = createClientState();
const ws = new WsClient();

let currentSessionCode = "";

// Messages
const messageStore = new MessageStore(dom.messagesContainer);

// Session controller and callbacks
const sessionCtrl = new SessionController(ws, state, {
  onPhaseChange: () => {
    render();
  },
  onError: () => {
    render();
  },
  onFingerprintAvailable: () => {
    render();
  },
  onMessageDecrypted: (text) => {
    messageStore.add({
      text,
      timestamp: Date.now(),
      isSelf: false,
    });
  },
  onFileReceived: (fileBlob, fileName) => {
    const url = URL.createObjectURL(fileBlob);
    messageStore.add({
      text: `Attachment: <a href="${url}" download="${escapeHtml(
        fileName,
      )}" style="color: var(--tactical-green); text-decoration: none;">Download ${escapeHtml(
        fileName,
      )}</a>`,
      timestamp: Date.now(),
      isSelf: false,
      isHtml: true,
    });
  },
  onFileProgress: (received, total) => {
    const pct = Math.round((received / total) * 100);
    messageStore.updateLast((last) => {
      if (last.isProgress) {
        last.text = `Sending file… ${pct}%`;
      }
    });
  },
  onDecryptionError: (msg) => {
    messageStore.add({
      text: `A message from your peer could not be decrypted (tampered or replay).`,
      timestamp: Date.now(),
      isSelf: false,
      isHtml: false,
    });
  },
});

// Rendering wrapper
function render() {
  renderUIState({
    state,
    securityBar: dom.securityBar,
    messageInput: dom.messageInput,
    sendBtn: dom.sendBtn,
    fileInput: dom.fileInput,
    infoPanel: dom.infoPanel,
    sessionSection: dom.sessionSection,
    chatSection: dom.chatSection,
    getCurrentSessionCode: () => currentSessionCode,
  });
}

// Modal/docs
setupModalHandlers(
  dom.infoPanel,
  dom.modal,
  dom.modalTitle,
  dom.modalBody,
  dom.modalClose,
);

// Session actions
dom.createBtn.addEventListener("click", () => {
  currentSessionCode = generateSessionId();
  sessionCtrl.startSession(currentSessionCode);
  render();
});

dom.joinBtn.addEventListener("click", () => {
  const code = dom.joinInput.value.trim();
  if (!code) return;
  currentSessionCode = code;
  sessionCtrl.startSession(code);
  render();
});

dom.joinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") dom.joinBtn.click();
});

dom.disconnectBtn.addEventListener("click", () => {
  sessionCtrl.endSession();
  messageStore.clear();
  currentSessionCode = "";
  render();
});

// Chat form
dom.chatForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = dom.messageInput.value.trim();
  if (!text || state.phase !== "chatting") return;

  try {
    await sessionCtrl.sendMessage(text);
    messageStore.add({
      text,
      timestamp: Date.now(),
      isSelf: true,
    });
    dom.messageInput.value = "";
  } catch (err) {
    console.error("Encryption error:", err);
  }
});

// File transfer
dom.fileInput.addEventListener("change", async () => {
  if (!dom.fileInput.files || dom.fileInput.files.length === 0) return;
  const file = dom.fileInput.files[0];

  messageStore.add({
    text: `Sending file: ${file.name}…`,
    timestamp: Date.now(),
    isSelf: true,
    isProgress: true,
  });

  try {
    await sessionCtrl.sendFile(file);
    messageStore.updateLast((last) => {
      if (last.isProgress) {
        last.text = `File sent: ${file.name}`;
        last.isProgress = false;
      }
    });
  } catch (err) {
    console.error("File transfer failed:", err);
    messageStore.add({
      text: "File transfer failed.",
      timestamp: Date.now(),
      isSelf: true,
    });
  } finally {
    dom.fileInput.value = "";
  }
});

// Keyboard shortcuts
setupKeyboardShortcuts({
  chatForm: dom.chatForm,
  messageInput: dom.messageInput,
  modal: dom.modal,
  joinInput: dom.joinInput,
});

// Initial render
render();
