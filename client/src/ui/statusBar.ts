import type { ClientState } from "../state/clientState"; // adjust type import if needed

export type StatusBarDeps = {
  state: ClientState;
  securityBar: HTMLDivElement;
  messageInput: HTMLInputElement;
  sendBtn: HTMLButtonElement;
  fileInput: HTMLInputElement;
  infoPanel: HTMLDivElement;
  sessionSection: HTMLElement;
  chatSection: HTMLElement;
  getCurrentSessionCode: () => string;
};

export function renderUIState({
  state,
  securityBar,
  messageInput,
  sendBtn,
  fileInput,
  infoPanel,
  sessionSection,
  chatSection,
  getCurrentSessionCode,
}: StatusBarDeps) {
  const badge = document.getElementById("status-badge")!;
  const phase = state.phase;

  const currentSessionCode = getCurrentSessionCode();
  const isActiveSession = currentSessionCode !== "";
  const isConnected = state.handshakeComplete;
  const isReconnecting = phase === "reconnecting";

  if (isReconnecting) {
    badge.textContent = "Reconnecting…";
    badge.className = "status-badge reconnecting";
  } else if (isConnected) {
    badge.textContent = "Connection Secure";
    badge.className = "status-badge secure";
  } else if (isActiveSession) {
    badge.textContent = "Waiting for Peer…";
    badge.className = "status-badge";
  } else {
    badge.textContent = state.lastError
      ? `Error: ${state.lastError}`
      : "Disconnected";
    badge.className = "status-badge";
  }

  infoPanel.style.display = isActiveSession ? "none" : "block";
  sessionSection.style.display = isActiveSession ? "none" : "flex";
  chatSection.style.display = isActiveSession ? "flex" : "none";

  const inputsEnabled = isConnected && !isReconnecting;
  messageInput.disabled = !inputsEnabled;
  sendBtn.disabled = !inputsEnabled;
  fileInput.disabled = !inputsEnabled;

  messageInput.placeholder = inputsEnabled
    ? "Type a message…"
    : isReconnecting
      ? "Reconnecting…"
      : "Waiting for peer to join…";

  if (isActiveSession && !isConnected && !isReconnecting) {
    securityBar.style.display = "block";
    securityBar.style.textAlign = "center";
    securityBar.innerHTML = `
      <div style="margin-bottom: 5px;">Waiting for peer… Share this code:</div>
      <div style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px;
                  user-select: all; word-break: break-all; font-family: monospace;
                  font-size: 1.2rem; font-weight: bold; color: white;">
        ${currentSessionCode}
      </div>
    `;
  } else if (isConnected && state.fingerprintPhrase) {
    securityBar.style.display = "flex";
    securityBar.style.textAlign = "left";
    securityBar.innerHTML = `
      <span>Security Code: <span class="fingerprint-code">${state.fingerprintPhrase}</span></span>
      <span style="color: var(--text-muted); font-size: 0.75rem;">(Verify with peer)</span>
    `;
  } else if (isReconnecting) {
    securityBar.style.display = "block";
    securityBar.style.textAlign = "center";
    securityBar.innerHTML = `<div>Reconnecting to session — please wait…</div>`;
  } else {
    securityBar.style.display = "none";
  }
}
