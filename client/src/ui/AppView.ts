import { getProfile, PROFILE_IDS, type TransportProfileId } from "../config/profiles";
import { SessionController } from "../session/SessionController";
import type { SessionViewState, TransferView } from "../session/types";
import { formatBytes } from "../utils/bytes";
import { normalizeRoomCode, roomCodeFromUrl, roomLink } from "../utils/ids";
import { button, clear, el } from "./dom";

type SheetName = "room" | "transfers" | "verify" | "about" | "leave" | null;

export class AppView {
  private controller = new SessionController();
  private root: HTMLElement;
  private state: SessionViewState | null = null;
  private activeSheet: SheetName = null;
  private menuOpen = false;
  private messageInput: HTMLInputElement | null = null;
  private roomInput: HTMLInputElement | null = null;
  private lastError: string | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.controller.subscribe((state) => {
      this.state = state;
      this.render();
    });
  }

  private render(): void {
    if (!this.state) return;

    const hasIncomingOffer = this.state.transfers.some(
      (transfer) => transfer.direction === "receive" && transfer.state === "offered",
    );

    if (hasIncomingOffer) {
      this.activeSheet = "transfers";
    }

    clear(this.root);

    const shell = el("main", "app-shell");
    if (this.isPreChat()) {
      shell.append(this.renderStart());
    } else {
      shell.append(this.renderChat());
    }

    this.root.append(shell);
    this.scrollTranscript();
  }

  private isPreChat(): boolean {
    if (!this.state) return true;
    return this.state.phase === "idle" || this.state.phase === "creating" || this.state.phase === "joining";
  }

  private renderStart(): HTMLElement {
    const page = el("section", "start-screen");

    const card = el("div", "start-card");
    card.append(el("div", "brand", "OnlyTwo"));
    card.append(el("h1", undefined, "Private room for two"));
    card.append(
      el(
        "p",
        "start-copy",
        "No account. No history. Messages, files, and voice are encrypted before leaving your device.",
      ),
    );

    const create = button("Create room", "btn primary wide");
    create.onclick = () => void this.controller.createRoom().catch((err) => this.showError(err));
    card.append(create);

    const divider = el("div", "divider", "or join with code");
    card.append(divider);

    const join = el("form", "join-form");
    this.roomInput = document.createElement("input");
    this.roomInput.className = "input room-input";
    this.roomInput.placeholder = "ABCD-EFGH";
    this.roomInput.autocomplete = "off";
    this.roomInput.inputMode = "text";
    this.roomInput.value = roomCodeFromUrl();
    this.roomInput.oninput = () => {
      if (!this.roomInput) return;
      this.roomInput.value = normalizeRoomCode(this.roomInput.value);
    };

    const joinButton = button("Join", "btn wide");
    joinButton.type = "submit";
    join.onsubmit = (event) => {
      event.preventDefault();
      void this.controller.joinRoom(this.roomInput?.value ?? "").catch((err) => this.showError(err));
    };
    join.append(this.roomInput, joinButton);
    card.append(join);

    card.append(this.renderProfileSelect());

    const help = button("How OnlyTwo works", "link-btn");
    help.onclick = () => {
      this.activeSheet = "about";
      this.render();
    };
    card.append(help);

    if (this.lastError) {
      card.append(el("div", "error-line", this.lastError));
    }

    page.append(card);

    if (this.activeSheet === "about") {
      page.append(this.renderSheet("How OnlyTwo works", this.renderAboutBody()));
    }

    return page;
  }

  private renderProfileSelect(): HTMLElement {
    const box = el("div", "profile-select");
    const label = el("label", undefined, "Mode");
    const select = document.createElement("select");
    select.className = "input";

    for (const id of PROFILE_IDS) {
      const profile = getProfile(id);
      const option = document.createElement("option");
      option.value = id;
      option.textContent = profile.label;
      option.selected = this.state?.profileId === id;
      select.append(option);
    }

    select.onchange = () => this.controller.setProfile(select.value as TransportProfileId);

    const current = getProfile(this.state?.profileId ?? "balanced");
    const note = el("p", "profile-note", profilePlainDescription(current.id));

    box.append(label, select, note);
    return box;
  }

  private renderChat(): HTMLElement {
    const chat = el("section", "chat-screen");
    chat.append(this.renderHeader());
    chat.append(this.renderSecurityLine());

    const activity = this.renderActivityLine();
    if (activity) chat.append(activity);

    chat.append(this.renderTranscript());
    chat.append(this.renderComposer());

    const sheet = this.renderActiveSheet();
    if (sheet) chat.append(sheet);

    return chat;
  }

  private renderHeader(): HTMLElement {
    const header = el("header", "topbar");

    const left = el("div", "topbar-left");
    left.append(el("div", "brand small", "OnlyTwo"));

    const codeLine = el("button", "room-code-button", this.state?.roomCode || "No room");
    codeLine.type = "button";
    codeLine.onclick = () => {
      this.activeSheet = "room";
      this.menuOpen = false;
      this.render();
    };
    left.append(codeLine);

    const actions = el("nav", "topbar-actions");

    const room = button("Room", "btn ghost compact");
    room.onclick = () => this.openSheet("room");
    actions.append(room);

    const transfers = button(this.transferButtonLabel(), "btn ghost compact");
    transfers.onclick = () => this.openSheet("transfers");
    actions.append(transfers);

    const voice = button(this.voiceButtonLabel(), this.isVoiceActive() ? "btn compact" : "btn ghost compact");
    voice.onclick = () => this.toggleVoice();
    actions.append(voice);

    const leave = button("Leave", "btn danger compact");
    leave.onclick = () => this.requestLeave();
    actions.append(leave);

    const more = button("Menu", "btn ghost compact more-btn");
    more.onclick = () => {
      this.menuOpen = !this.menuOpen;
      this.render();
    };

    const menu = el("div", this.menuOpen ? "mobile-menu open" : "mobile-menu");
    menu.append(
      this.menuAction("Room", () => this.openSheet("room")),
      this.menuAction("Transfers", () => this.openSheet("transfers")),
      this.menuAction(this.voiceButtonLabel(), () => this.toggleVoice()),
      this.menuAction("Leave", () => this.requestLeave()),
    );

    header.append(left, actions, more, menu);
    return header;
  }

  private menuAction(label: string, action: () => void): HTMLElement {
    const item = button(label, "menu-item");
    item.onclick = () => {
      this.menuOpen = false;
      action();
    };
    return item;
  }

  private renderSecurityLine(): HTMLElement {
    const line = el("div", `security-line ${this.state?.security ?? "none"}`);

    const text = el("span", undefined, this.securityText());
    line.append(text);

    if (this.state?.security === "encrypted_unverified" && this.state.safetyPhrase) {
      const verify = button("Verify", "link-btn small");
      verify.onclick = () => this.openSheet("verify");
      line.append(verify);
    }

    if (this.state?.security === "verified") {
      const room = button("Details", "link-btn small");
      room.onclick = () => this.openSheet("room");
      line.append(room);
    }

    return line;
  }

  private securityText(): string {
    if (!this.state) return "Disconnected";
    if (this.state.connection === "reconnecting") return "Reconnecting securely…";
    if (this.state.connection === "failed") return "Connection lost";

    switch (this.state.security) {
      case "verified":
        return "Verified private chat";
      case "encrypted_unverified":
        return "Encrypted · Not verified";
      case "verification_failed":
        return "Verification mismatch. Leave this room.";
      case "none":
      default:
        if (this.state.phase === "waiting") return "Waiting for the other person";
        return this.state.connection === "connected" ? "Connected" : "Disconnected";
    }
  }

  private renderActivityLine(): HTMLElement | null {
    if (!this.state) return null;

    const active = this.primaryActiveTransfer();
    const line = el("div", "activity-line");

    if (this.isVoiceActive()) {
      const status = this.state.voice === "muted" ? "Voice active · muted" : "Voice active";
      line.append(el("span", undefined, `${status}. Files are paused.`));

      const mute = button(this.state.voice === "muted" ? "Unmute" : "Mute", "link-btn small");
      mute.onclick = () => this.controller.toggleMute();
      line.append(mute);

      const end = button("End", "link-btn small danger-text");
      end.onclick = () => void this.controller.stopVoice().catch((err) => this.showError(err));
      line.append(end);
      return line;
    }

    if (active) {
      line.append(el("span", undefined, `${active.name} · ${transferStateLabel(active)} · ${Math.round(active.progress)}%`));
      const open = button("Transfers", "link-btn small");
      open.onclick = () => this.openSheet("transfers");
      line.append(open);
      return line;
    }

    if (this.state.notice) {
      line.append(el("span", undefined, this.state.notice));
      return line;
    }

    return null;
  }

  private renderTranscript(): HTMLElement {
    const area = el("div", "transcript");

    if (!this.state || this.state.transcript.length === 0) {
      const empty = el("div", "empty-chat");
      empty.append(el("div", undefined, this.emptyTitle()));
      empty.append(el("p", undefined, this.emptyCopy()));
      area.append(empty);
      return area;
    }

    for (const item of this.state.transcript) {
      if (item.kind === "system") {
        const sys = el("div", "system-line", item.text);
        area.append(sys);
        continue;
      }

      const row = el("article", `message-row ${item.from === "me" ? "me" : "peer"}`);
      const meta = el("div", "message-meta", item.from === "me" ? "You" : "Other person");
      const body = el("div", "message-text", item.text);
      row.append(meta, body);

      if (item.status && item.from === "me") {
        row.append(el("div", `message-status ${item.status}`, statusLabel(item.status)));
      }

      area.append(row);
    }

    return area;
  }

  private emptyTitle(): string {
    if (!this.state) return "OnlyTwo";
    if (this.state.phase === "waiting") return "Waiting for the other person.";
    if (this.state.security === "encrypted_unverified") return "Encrypted chat is ready.";
    if (this.state.security === "verified") return "Verified private chat.";
    return "No messages yet.";
  }

  private emptyCopy(): string {
    if (!this.state) return "";
    if (this.state.phase === "waiting") return "Share the room code or link with one person.";
    if (this.state.security === "encrypted_unverified") return "Send a message, or verify the phrase first.";
    return "Say hello.";
  }

  private renderComposer(): HTMLElement {
    const wrap = el("div", "composer-wrap");

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.className = "hidden-input";
    fileInput.onchange = () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file) void this.controller.offerFile(file).catch((err) => this.showError(err));
    };

    const attach = button("+", "btn icon");
    attach.title = "Attach file";
    attach.disabled = !this.canUseChat();
    attach.onclick = () => fileInput.click();

    const form = el("form", "composer") as HTMLFormElement;
    form.onsubmit = (event) => {
      event.preventDefault();
      const text = this.messageInput?.value ?? "";
      if (!text.trim()) return;
      if (this.messageInput) this.messageInput.value = "";
      void this.controller.sendText(text).catch((err) => this.showError(err));
    };

    this.messageInput = document.createElement("input");
    this.messageInput.className = "input message-input";
    this.messageInput.placeholder = this.canUseChat() ? "Message…" : "Waiting for encryption…";
    this.messageInput.autocomplete = "off";
    this.messageInput.disabled = !this.canUseChat();

    const send = button("Send", "btn primary");
    send.type = "submit";
    send.disabled = !this.canUseChat();

    form.append(attach, this.messageInput, send, fileInput);
    wrap.append(form);
    return wrap;
  }

  private renderActiveSheet(): HTMLElement | null {
    switch (this.activeSheet) {
      case "room":
        return this.renderSheet("Room", this.renderRoomBody());
      case "transfers":
        return this.renderSheet("Transfers", this.renderTransfersBody());
      case "verify":
        return this.renderSheet("Verify chat", this.renderVerifyBody());
      case "about":
        return this.renderSheet("How OnlyTwo works", this.renderAboutBody());
      case "leave":
        return this.renderSheet("Leave room?", this.renderLeaveBody(), "danger-sheet");
      default:
        return null;
    }
  }

  private renderSheet(title: string, body: HTMLElement, extraClass = ""): HTMLElement {
    const overlay = el("div", "sheet-overlay");
    overlay.onclick = (event) => {
      if (event.target === overlay) this.closeSheet();
    };

    const sheet = el("section", `sheet ${extraClass}`.trim());
    const head = el("div", "sheet-head");
    head.append(el("h2", undefined, title));
    const close = button("Close", "btn ghost compact");
    close.onclick = () => this.closeSheet();
    head.append(close);

    sheet.append(head, body);
    overlay.append(sheet);
    return overlay;
  }

  private renderRoomBody(): HTMLElement {
    const body = el("div", "sheet-body");
    const code = this.state?.roomCode ?? "";
    const profile = getProfile(this.state?.profileId ?? "balanced");

    const codeBlock = el("div", "info-block");
    codeBlock.append(el("div", "info-label", "Room code"));
    codeBlock.append(el("div", "room-code-large", code || "No room"));

    const codeActions = el("div", "button-row");
    const copyCode = button("Copy code", "btn compact");
    copyCode.onclick = () => void this.copyText(code, "Room code copied.");
    const copyLink = button("Copy link", "btn compact");
    copyLink.onclick = () => void this.copyText(roomLink(code), "Room link copied.");
    const share = button("Share", "btn compact");
    share.onclick = () => void this.shareRoom();
    codeActions.append(copyCode, copyLink, share);
    codeBlock.append(codeActions);

    const status = this.renderKeyValueBlock("Status", [
      ["Connection", connectionLabel(this.state?.connection ?? "disconnected")],
      ["Encryption", encryptionLabel(this.state?.security ?? "none")],
      ["Profile", profile.label],
    ]);

    const security = el("div", "info-block");
    security.append(el("div", "info-label", "Security"));
    security.append(
      el(
        "p",
        undefined,
        "Messages, files, and voice are encrypted before leaving this device. The relay forwards encrypted data and cannot read the content.",
      ),
    );
    security.append(
      el(
        "p",
        undefined,
        "Verify the phrase to confirm who you are talking to.",
      ),
    );

    const profileBlock = el("div", "info-block");
    profileBlock.append(el("div", "info-label", "Mode"));
    profileBlock.append(el("strong", undefined, profile.label));
    profileBlock.append(el("p", undefined, profilePlainDescription(profile.id)));

    const about = button("How OnlyTwo works", "link-btn");
    about.onclick = () => this.openSheet("about");

    body.append(codeBlock, status, security, profileBlock, about);
    return body;
  }

  private renderTransfersBody(): HTMLElement {
    const body = el("div", "sheet-body transfers-body");
    const transfers = this.state?.transfers ?? [];

    if (transfers.length === 0) {
      body.append(el("div", "empty-sheet", "No transfers yet."));
      return body;
    }

    for (const transfer of transfers) {
      body.append(this.renderTransfer(transfer));
    }

    return body;
  }

  private renderTransfer(transfer: TransferView): HTMLElement {
    const row = el("div", "transfer-row");

    const top = el("div", "transfer-top");
    const title = el("div", "transfer-title", transfer.name);
    const size = el("div", "transfer-size", formatBytes(transfer.size));
    top.append(title, size);

    const meta = el("div", "transfer-meta", transferMeta(transfer));
    const progress = el("div", "progress");
    const bar = el("div", "progress-bar");
    bar.style.width = `${clamp(transfer.progress, 0, 100)}%`;
    progress.append(bar);

    const actions = el("div", "transfer-actions");

    if (transfer.direction === "receive" && transfer.state === "offered") {
      const accept = button("Accept", "btn compact primary");
      accept.onclick = () => void this.controller.acceptFile(transfer.fileId).catch((err) => this.showError(err));
      const decline = button("Decline", "btn compact");
      decline.onclick = () => void this.controller.rejectFile(transfer.fileId).catch((err) => this.showError(err));
      actions.append(accept, decline);
    }

    if (isTransferCancellable(transfer.state)) {
      const cancel = button("Cancel", "btn compact danger");
      cancel.onclick = () => void this.controller.cancelFile(transfer.fileId).catch((err) => this.showError(err));
      actions.append(cancel);
    }

    if (transfer.state === "completed" && transfer.blobUrl) {
      const link = document.createElement("a");
      link.className = "btn compact";
      link.href = transfer.blobUrl;
      link.download = transfer.name;
      link.textContent = "Download";
      actions.append(link);
    }

    row.append(top, meta);
    if (!isTerminalTransfer(transfer.state)) row.append(progress);
    if (actions.childElementCount > 0) row.append(actions);
    return row;
  }

  private renderVerifyBody(): HTMLElement {
    const body = el("div", "sheet-body");
    body.append(el("p", undefined, "Compare this phrase with the other person using a different channel or by speaking it aloud."));

    const phrase = el("div", "safety-phrase");
    const words = (this.state?.safetyPhrase ?? "").split(" ").filter(Boolean);
    const lineA = words.slice(0, Math.ceil(words.length / 2)).join(" ");
    const lineB = words.slice(Math.ceil(words.length / 2)).join(" ");
    phrase.append(el("div", undefined, lineA));
    if (lineB) phrase.append(el("div", undefined, lineB));
    body.append(phrase);

    const actions = el("div", "button-row");
    const yes = button("Matches", "btn primary");
    yes.onclick = () => {
      this.closeSheet();
      void this.controller.markVerified(true).catch((err) => this.showError(err));
    };
    const no = button("Does not match", "btn danger");
    no.onclick = () => {
      this.closeSheet();
      void this.controller.markVerified(false).catch((err) => this.showError(err));
    };
    actions.append(yes, no);
    body.append(actions);

    return body;
  }

  private renderAboutBody(): HTMLElement {
    const body = el("div", "sheet-body about-body");
    body.append(
      this.aboutSection(
        "Encryption",
        "Your browser encrypts messages, files, and voice before sending them. The server only relays encrypted data.",
      ),
      this.aboutSection(
        "Verification",
        "Encryption starts automatically. Compare the safety phrase to confirm you are talking to the right person.",
      ),
      this.aboutSection(
        "Transport",
        "OnlyTwo sends encrypted data over a WebSocket relay. Text, files, and voice use separate internal lanes so calls can stay responsive.",
      ),
      this.aboutSection(
        "Files",
        "Files are sent in chunks. Large files may pause during voice to keep the call stable.",
      ),
      this.aboutSection(
        "Voice",
        "Voice is encrypted and sent as realtime audio frames. Late audio is dropped instead of delayed.",
      ),
    );

    const modes = el("div", "info-block");
    modes.append(el("div", "info-label", "Modes"));
    for (const id of PROFILE_IDS) {
      const profile = getProfile(id);
      const row = el("div", "mode-row");
      row.append(el("strong", undefined, profile.label));
      row.append(el("p", undefined, profilePlainDescription(id)));
      modes.append(row);
    }
    body.append(modes);

    return body;
  }

  private aboutSection(title: string, text: string): HTMLElement {
    const section = el("div", "info-block");
    section.append(el("div", "info-label", title));
    section.append(el("p", undefined, text));
    return section;
  }

  private renderLeaveBody(): HTMLElement {
    const body = el("div", "sheet-body");
    body.append(el("p", undefined, this.hasActiveSessionWork() ? "Voice and file transfers will stop. Messages are not saved." : "This closes the room on this device."));

    const actions = el("div", "button-row");
    const leave = button("Leave", "btn danger");
    leave.onclick = () => {
      this.closeSheet();
      this.controller.disconnect(false);
    };
    const stay = button("Stay", "btn");
    stay.onclick = () => this.closeSheet();
    actions.append(leave, stay);
    body.append(actions);
    return body;
  }

  private renderKeyValueBlock(title: string, rows: Array<[string, string]>): HTMLElement {
    const block = el("div", "info-block");
    block.append(el("div", "info-label", title));
    for (const [key, value] of rows) {
      const row = el("div", "key-value");
      row.append(el("span", undefined, key), el("strong", undefined, value));
      block.append(row);
    }
    return block;
  }

  private openSheet(sheet: Exclude<SheetName, null>): void {
    this.activeSheet = sheet;
    this.menuOpen = false;
    this.render();
  }

  private closeSheet(): void {
    this.activeSheet = null;
    this.render();
  }

  private requestLeave(): void {
    if (this.hasActiveSessionWork()) {
      this.openSheet("leave");
      return;
    }
    this.controller.disconnect(false);
  }

  private toggleVoice(): void {
    if (this.isVoiceActive()) {
      void this.controller.stopVoice().catch((err) => this.showError(err));
    } else {
      void this.controller.startVoice().catch((err) => this.showError(err));
    }
  }

  private transferButtonLabel(): string {
    const active = this.state?.transfers.filter((transfer) => !isTerminalTransfer(transfer.state)).length ?? 0;
    return active > 0 ? `Transfers · ${active}` : "Transfers";
  }

  private voiceButtonLabel(): string {
    if (!this.state) return "Voice";
    if (this.state.voice === "starting") return "Starting";
    if (this.isVoiceActive()) return "End voice";
    return "Voice";
  }

  private primaryActiveTransfer(): TransferView | null {
    return this.state?.transfers.find((transfer) => !isTerminalTransfer(transfer.state)) ?? null;
  }

  private isVoiceActive(): boolean {
    return this.state?.voice === "starting" || this.state?.voice === "active" || this.state?.voice === "muted";
  }

  private hasActiveSessionWork(): boolean {
    return this.isVoiceActive() || (this.state?.transfers.some((transfer) => !isTerminalTransfer(transfer.state)) ?? false);
  }

  private canUseChat(): boolean {
    return this.state?.security === "encrypted_unverified" || this.state?.security === "verified";
  }

  private async shareRoom(): Promise<void> {
    const code = this.state?.roomCode ?? "";
    const url = roomLink(code);
    const text = `Join my OnlyTwo room: ${code}\n${url}`;

    if (navigator.share) {
      try {
        await navigator.share({ title: "OnlyTwo room", text, url });
        return;
      } catch {
        // User cancelled or browser rejected; clipboard fallback below.
      }
    }

    await this.copyText(text, "Room link copied.");
  }

  private async copyText(text: string, confirmation: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.lastError = null;
      if (this.state) this.state.notice = confirmation;
      this.render();
    } catch (err) {
      this.showError(err);
    }
  }

  private showError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    if (this.state) {
      this.state.notice = this.lastError;
    }
    this.render();
  }

  private scrollTranscript(): void {
    const transcript = this.root.querySelector(".transcript");
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }
}

function profilePlainDescription(id: TransportProfileId): string {
  switch (id) {
    case "balanced":
      return "Best default for normal chat, files, and voice.";
    case "low_data":
      return "Uses less bandwidth. Voice may feel less responsive.";
    case "voice_first":
      return "Keeps calls more stable. File transfer may slow down.";
    case "maximum_privacy":
      return "Uses larger fixed-size traffic. More private against traffic patterns, but uses more bandwidth.";
  }
}

function connectionLabel(value: string): string {
  switch (value) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "failed":
      return "Failed";
    default:
      return "Disconnected";
  }
}

function encryptionLabel(value: string): string {
  switch (value) {
    case "verified":
      return "Verified";
    case "encrypted_unverified":
      return "Encrypted, not verified";
    case "verification_failed":
      return "Verification failed";
    default:
      return "Not ready";
  }
}

function transferStateLabel(transfer: TransferView): string {
  switch (transfer.state) {
    case "queued":
      return "Queued";
    case "offered":
      return transfer.direction === "receive" ? "Incoming" : "Offered";
    case "waiting":
      return "Waiting";
    case "sending":
      return "Sending";
    case "receiving":
      return "Receiving";
    case "paused":
      return transfer.reason || "Paused";
    case "completed":
      return transfer.direction === "receive" ? "Ready" : "Sent";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return transfer.reason || "Failed";
  }
}

function transferMeta(transfer: TransferView): string {
  const parts = [transferStateLabel(transfer), `${Math.round(transfer.progress)}%`];
  if (transfer.reason && transfer.state !== "paused" && transfer.state !== "failed") {
    parts.push(transfer.reason);
  }
  return parts.join(" · ");
}

function isTerminalTransfer(state: TransferView["state"]): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

function isTransferCancellable(state: TransferView["state"]): boolean {
  return !isTerminalTransfer(state);
}

function statusLabel(status: "sending" | "sent" | "failed"): string {
  switch (status) {
    case "sending":
      return "Sending";
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

