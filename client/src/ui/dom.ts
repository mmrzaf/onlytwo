export type AppDom = {
  root: HTMLDivElement;
  header: HTMLElement;
  infoPanel: HTMLDivElement;
  securityBar: HTMLDivElement;
  sessionSection: HTMLElement;
  createBtn: HTMLButtonElement;
  joinInput: HTMLInputElement;
  joinBtn: HTMLButtonElement;
  chatSection: HTMLElement;
  messagesContainer: HTMLDivElement;
  chatForm: HTMLFormElement;
  fileInput: HTMLInputElement;
  messageInput: HTMLInputElement;
  sendBtn: HTMLButtonElement;
  disconnectBtn: HTMLButtonElement;
  modal: HTMLDivElement;
  modalTitle: HTMLHeadingElement;
  modalBody: HTMLDivElement;
  modalClose: HTMLButtonElement;
};

export function createAppDom(): AppDom {
  const root = document.createElement("div");
  root.className = "onlytwo-root";

  const header = document.createElement("header");
  header.className = "onlytwo-header";
  header.innerHTML = `<h1>OnlyTwo</h1><div class="status-badge" id="status-badge">Waiting...</div>`;

  const infoPanel = document.createElement("div");
  infoPanel.className = "info-panel";
  infoPanel.innerHTML = `
    <h3>Security Documentation</h3>
    <div style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 8px;">
      Learn how OnlyTwo guarantees your privacy before connecting.
    </div>
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
  divider.style.cssText =
    "margin-bottom: 1rem; text-align: center; color: var(--text-muted);";

  const joinContainer = document.createElement("div");
  joinContainer.style.cssText = "display: flex; gap: 8px; width: 100%;";

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
  messageInput.placeholder = "Type a message…";

  const sendBtn = document.createElement("button");
  sendBtn.type = "submit";
  sendBtn.textContent = "Send";

  const disconnectBtn = document.createElement("button");
  disconnectBtn.type = "button";
  disconnectBtn.className = "btn-danger";
  disconnectBtn.textContent = "End Session";

  chatForm.append(
    fileLabelBtn,
    fileInput,
    messageInput,
    sendBtn,
    disconnectBtn,
  );
  chatSection.append(messagesContainer, chatForm);

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

  root.append(
    header,
    infoPanel,
    securityBar,
    sessionSection,
    chatSection,
    modal,
  );

  const modalTitle = modal.querySelector<HTMLHeadingElement>("#modal-title")!;
  const modalBody = modal.querySelector<HTMLDivElement>("#modal-body")!;
  const modalClose = modal.querySelector<HTMLButtonElement>("#close-modal")!;

  if (!modalTitle || !modalBody || !modalClose) {
    throw new Error("Modal elements not found");
  }

  return {
    root,
    header,
    infoPanel,
    securityBar,
    sessionSection,
    createBtn,
    joinInput,
    joinBtn,
    chatSection,
    messagesContainer,
    chatForm,
    fileInput,
    messageInput,
    sendBtn,
    disconnectBtn,
    modal,
    modalTitle,
    modalBody,
    modalClose,
  };
}
