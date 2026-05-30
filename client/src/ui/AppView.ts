import {
  getProfile,
  PROFILE_IDS,
  type TransportProfileId,
} from "../config/profiles";
import { MAX_TEXT_MESSAGE_CHARS } from "../protocol/appMessages";
import { SessionController } from "../session/SessionController";
import type {
  SessionViewState,
  TranscriptItem,
  TransferView,
} from "../session/types";
import { formatBytes } from "../utils/bytes";
import { normalizeRoomCode, roomCodeFromUrl, roomLink } from "../utils/ids";
import { button, clear, el } from "./dom";

type SheetName = "room" | "verify" | "about" | "leave" | null;
type ToastTone = "info" | "error";

interface RenderPosition {
  messageFocused: boolean;
  roomFocused: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  transcriptScrollTop: number;
  transcriptNearBottom: boolean;
}

export class AppView {
  private controller = new SessionController();
  private root: HTMLElement;
  private state: SessionViewState | null = null;
  private activeSheet: SheetName = null;
  private menuOpen = false;
  private messageInput: HTMLInputElement | null = null;
  private roomInput: HTMLInputElement | null = null;
  private messageDraft = "";
  private roomDraft = roomCodeFromUrl();
  private lastError: string | null = null;
  private toast: { message: string; tone: ToastTone } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private codeCopied = false;
  private announcedIncomingOffers = new Set<string>();
  private renderScheduled = false;
  private lastNoticeShown: string | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.controller.subscribe((state) => {
      this.syncLocalState(this.state, state);
      this.state = state;
      this.surfaceNotice(state.notice);
      this.scheduleRender();
    });
  }

  private syncLocalState(
    previous: SessionViewState | null,
    next: SessionViewState,
  ): void {
    const roomChanged =
      previous !== null && previous.roomCode !== next.roomCode;
    const leftChat =
      previous !== null &&
      !["idle", "ended"].includes(previous.phase) &&
      ["idle", "ended"].includes(next.phase);
    if (roomChanged || leftChat) {
      this.messageDraft = "";
      this.announcedIncomingOffers.clear();
      this.activeSheet = null;
      this.menuOpen = false;
      this.codeCopied = false;
      this.lastError = null;
      if (leftChat) this.roomDraft = "";
    }
    if (["waiting", "active"].includes(next.phase)) this.lastError = null;
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  private surfaceNotice(notice: string | null): void {
    if (!notice) {
      this.lastNoticeShown = null;
      return;
    }
    if (notice === this.lastNoticeShown) return;
    this.lastNoticeShown = notice;
    const tone = noticeToastTone(notice);
    if (tone) this.setToast(notice, tone, false);
  }

  private render(): void {
    if (!this.state) return;
    this.announceIncomingOffers();
    const position = this.captureRenderPosition();
    clear(this.root);

    const shell = el("main", "app-shell");
    shell.append(this.isPreChat() ? this.renderStart() : this.renderChat());
    const toast = this.renderToast();
    if (toast) shell.append(toast);
    this.root.append(shell);
    this.restoreRenderPosition(position);
  }

  private announceIncomingOffers(): void {
    if (!this.state) return;
    for (const transfer of this.state.transfers) {
      if (
        transfer.direction === "receive" &&
        transfer.state === "offered" &&
        !this.announcedIncomingOffers.has(transfer.fileId)
      ) {
        this.announcedIncomingOffers.add(transfer.fileId);
        this.setToast(`Incoming file: ${transfer.name}`, "info", false);
      }
    }
  }

  private isPreChat(): boolean {
    if (!this.state) return true;
    return ["idle", "creating", "joining", "ended"].includes(this.state.phase);
  }

  private isStarting(): boolean {
    return this.state?.phase === "creating" || this.state?.phase === "joining";
  }

  private renderStart(): HTMLElement {
    const page = el("section", "start-screen");
    const card = el("div", "start-card");
    const busy = this.isStarting();

    card.append(el("div", "brand", "OnlyTwo"));
    card.append(el("h1", undefined, "Private room for two"));
    card.append(
      el(
        "p",
        "start-copy",
        "No account. No history. Messages, files, and voice are encrypted before leaving your device.",
      ),
    );

    card.append(el("div", "section-label", "Create a room"));
    card.append(this.renderProfileSelect(busy));
    const create = button(
      this.state?.phase === "creating" ? "Creating room…" : "Create room",
      "btn primary wide",
    );
    create.disabled = busy;
    create.onclick = () =>
      void this.controller.createRoom().catch((err) => this.showError(err));
    card.append(create);

    card.append(el("div", "divider", "or join with code"));
    const join = el("form", "join-form") as HTMLFormElement;
    this.roomInput = document.createElement("input");
    this.roomInput.className = "input room-input";
    this.roomInput.placeholder = "ABCD-EFGH";
    this.roomInput.autocomplete = "off";
    this.roomInput.inputMode = "text";
    this.roomInput.maxLength = 9;
    this.roomInput.disabled = busy;
    this.roomInput.value = this.roomDraft;
    this.roomInput.oninput = () => {
      if (!this.roomInput) return;
      this.roomDraft = normalizeRoomCode(this.roomInput.value);
      this.roomInput.value = this.roomDraft;
    };

    const joinButton = button(
      this.state?.phase === "joining" ? "Joining…" : "Join",
      "btn wide",
    );
    joinButton.type = "submit";
    joinButton.disabled = busy;
    join.onsubmit = (event) => {
      event.preventDefault();
      if (busy) return;
      void this.controller
        .joinRoom(this.roomDraft)
        .catch((err) => this.showError(err));
    };
    join.append(this.roomInput, joinButton);
    card.append(join);
    card.append(
      el(
        "p",
        "profile-note",
        "The person creating the room chooses its locked transport profile. Joining uses that room profile automatically.",
      ),
    );

    const help = button("How OnlyTwo works", "link-btn");
    help.onclick = () => this.openSheet("about");
    card.append(help);
    if (this.lastError) card.append(el("div", "error-line", this.lastError));

    page.append(card);
    if (this.activeSheet === "about") {
      page.append(
        this.renderSheet("How OnlyTwo works", this.renderAboutBody()),
      );
    }
    return page;
  }

  private renderProfileSelect(disabled: boolean): HTMLElement {
    const box = el("div", "profile-select");
    const select = document.createElement("select");
    select.className = "input";
    select.disabled = disabled;
    for (const id of PROFILE_IDS) {
      const profile = getProfile(id);
      const option = document.createElement("option");
      option.value = id;
      option.textContent = profile.label;
      option.selected = this.state?.profileId === id;
      select.append(option);
    }
    select.onchange = () => {
      this.controller.setProfile(select.value as TransportProfileId);
    };
    const current = getProfile(this.state?.profileId ?? "balanced");
    box.append(
      el("label", undefined, "Room transport profile"),
      select,
      el("p", "profile-note", profilePlainDescription(current.id)),
    );
    return box;
  }

  private renderChat(): HTMLElement {
    const chat = el("section", "chat-screen");
    chat.append(
      this.renderHeader(),
      this.renderTranscript(),
      this.renderComposer(),
    );
    const sheet = this.renderActiveSheet();
    if (sheet) chat.append(sheet);
    return chat;
  }

  private renderHeader(): HTMLElement {
    const header = el("header", "topbar");
    const left = el("div", "topbar-left");
    left.append(el("div", "brand small", "OnlyTwo"));
    const code = el(
      "button",
      `room-code-button${this.codeCopied ? " copied" : ""}`,
      this.codeCopied ? "Copied" : this.state?.roomCode || "No room",
    );
    code.type = "button";
    code.title = "Copy room code";
    code.setAttribute("aria-label", "Copy room code");
    code.onclick = () => void this.copyRoomCode();
    left.append(code);

    const actions = el("nav", "topbar-actions");
    const verify = button(
      this.securityButtonLabel(),
      this.securityButtonClass(),
    );
    verify.disabled = !this.canOpenSecuritySheet();
    verify.onclick = () => this.openSecuritySheet();
    actions.append(verify);

    const more = button("⋮", "btn ghost compact more-btn");
    more.title = "More actions";
    more.setAttribute("aria-label", "More actions");
    more.onclick = () => {
      this.menuOpen = !this.menuOpen;
      this.render();
    };

    const menu = el("div", this.menuOpen ? "mobile-menu open" : "mobile-menu");
    menu.append(
      this.menuAction("Room details", () => this.openSheet("room")),
      this.menuAction("Copy room code", () => void this.copyRoomCode()),
      this.menuAction("Share room", () => void this.shareRoom()),
      this.menuAction(
        "End chat for both",
        () => this.openSheet("leave"),
        "danger",
      ),
    );
    header.append(left, actions, more, menu);
    return header;
  }

  private menuAction(
    label: string,
    action: () => void,
    extraClass = "",
  ): HTMLElement {
    const item = button(label, `menu-item ${extraClass}`.trim());
    item.onclick = () => {
      this.menuOpen = false;
      action();
    };
    return item;
  }

  private securityButtonLabel(): string {
    if (!this.state) return "Connecting…";
    if (this.state.connection === "reconnecting") return "Reconnecting…";
    if (this.state.phase === "waiting") return "Peer offline";
    if (this.state.security === "verified") return "Verified";
    if (this.state.security === "encrypted_unverified") return "Verify chat";
    if (this.state.security === "verification_failed") return "Verify failed";
    return "Connecting…";
  }

  private securityButtonClass(): string {
    return `btn compact security-button ${this.state?.security ?? "none"}`;
  }

  private canOpenSecuritySheet(): boolean {
    return Boolean(this.state?.safetyPhrase) || Boolean(this.state?.roomCode);
  }

  private openSecuritySheet(): void {
    this.openSheet(this.state?.safetyPhrase ? "verify" : "room");
  }

  private renderTranscript(): HTMLElement {
    const area = el("div", "transcript");
    if (!this.state || this.state.transcript.length === 0) {
      const empty = el("div", "empty-chat");
      empty.append(
        el("div", undefined, this.emptyTitle()),
        el("p", undefined, this.emptyCopy()),
      );
      area.append(empty);
      return area;
    }
    for (const item of this.state.transcript) {
      if (item.kind === "system") {
        area.append(this.renderSystemItem(item));
      } else if (item.kind === "file") {
        const transfer = this.state.transfers.find(
          (candidate) => candidate.fileId === item.fileId,
        );
        if (transfer) area.append(this.renderTransfer(transfer));
      } else {
        area.append(this.renderTextBubble(item));
      }
    }
    return area;
  }

  private renderTextBubble(item: TranscriptItem): HTMLElement {
    const row = el(
      "article",
      `message-row ${item.from === "me" ? "me" : "peer"}`,
    );
    const bubble = el("div", "message-bubble");
    bubble.append(el("div", "message-text", item.text));
    const meta = el("div", "message-meta");
    meta.append(el("span", undefined, formatTime(item.at)));
    if (item.status && item.from === "me") {
      meta.append(
        el("span", `message-status ${item.status}`, statusLabel(item.status)),
      );
    }
    bubble.append(meta);
    row.append(bubble);
    return row;
  }

  private renderSystemItem(item: TranscriptItem): HTMLElement {
    const row = el("div", `system-line ${item.severity ?? "info"}`);
    row.append(
      el("span", "system-text", item.text),
      el("time", undefined, formatTime(item.at)),
    );
    return row;
  }

  private renderTransfer(transfer: TransferView): HTMLElement {
    const row = el(
      "article",
      `file-event ${transfer.direction === "send" ? "me" : "peer"}`,
    );
    const card = el("div", "transfer-card");
    const top = el("div", "transfer-top");
    top.append(
      el("div", "transfer-title", transfer.name),
      el("div", "transfer-size", formatBytes(transfer.size)),
    );
    card.append(top, el("div", "transfer-meta", transferMeta(transfer)));

    if (!isTerminalTransfer(transfer.state) && transfer.state !== "offered") {
      const progress = el("div", "progress");
      const bar = el("div", "progress-bar");
      bar.style.width = `${progressPercent(transfer.progress)}%`;
      progress.append(bar);
      card.append(progress);
    }

    const actions = el("div", "transfer-actions");
    if (transfer.direction === "receive" && transfer.state === "offered") {
      const accept = button("Accept", "btn compact primary");
      accept.onclick = () =>
        void this.controller
          .acceptFile(transfer.fileId)
          .catch((err) => this.showError(err));
      const decline = button("Decline", "btn compact");
      decline.onclick = () =>
        void this.controller
          .rejectFile(transfer.fileId)
          .catch((err) => this.showError(err));
      actions.append(accept, decline);
    } else if (!isTerminalTransfer(transfer.state)) {
      const cancel = button("Cancel", "btn compact danger");
      cancel.onclick = () =>
        void this.controller
          .cancelFile(transfer.fileId)
          .catch((err) => this.showError(err));
      actions.append(cancel);
    }

    if (transfer.state === "completed" && transfer.blobUrl) {
      const download = document.createElement("a");
      download.className = "btn compact";
      download.href = transfer.blobUrl;
      download.download = transfer.name;
      download.textContent = "Download";
      actions.append(download);
    }
    if (isTerminalTransfer(transfer.state)) {
      const remove = button("Remove", "btn ghost compact");
      remove.onclick = () => this.controller.removeFile(transfer.fileId);
      actions.append(remove);
    }
    if (actions.childElementCount) card.append(actions);
    row.append(card);
    return row;
  }

  private emptyTitle(): string {
    if (this.state?.phase === "waiting") return "Waiting for the other person.";
    if (this.state?.security === "encrypted_unverified")
      return "Encrypted chat is ready.";
    if (this.state?.security === "verified") return "Verified private chat.";
    return "No messages yet.";
  }

  private emptyCopy(): string {
    if (this.state?.phase === "waiting")
      return "Share the room code with one person.";
    if (this.state?.security === "encrypted_unverified")
      return "Send a message, or verify the phrase first.";
    return "Say hello.";
  }

  private renderComposer(): HTMLElement {
    const wrap = el("div", "composer-wrap");
    if (this.state?.audioPlaybackBlocked) {
      const blocked = el("div", "composer-activity error");
      blocked.append(
        el("span", undefined, "Incoming voice is blocked by this browser."),
      );
      const enable = button("Enable audio", "link-btn small");
      enable.onclick = () =>
        void this.controller
          .enableAudioPlayback()
          .catch((err) => this.showError(err));
      blocked.append(enable);
      wrap.append(blocked);
    }

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.className = "hidden-input";
    fileInput.onchange = () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file)
        void this.controller
          .offerFile(file)
          .catch((err) => this.showError(err));
    };

    const form = el("form", "composer") as HTMLFormElement;
    form.onsubmit = (event) => {
      event.preventDefault();
      const text = this.messageDraft.trim();
      if (!text) return;
      this.messageDraft = "";
      if (this.messageInput) this.messageInput.value = "";
      void this.controller.sendText(text).catch((err) => this.showError(err));
    };

    const attach = button("+", "btn icon");
    attach.title = "Attach file";
    attach.setAttribute("aria-label", "Attach file");
    attach.disabled = !this.canUseChat();
    attach.onclick = () => fileInput.click();

    this.messageInput = document.createElement("input");
    this.messageInput.className = "input message-input";
    this.messageInput.placeholder = this.canUseChat()
      ? "Message…"
      : "Waiting for peer…";
    this.messageInput.autocomplete = "off";
    this.messageInput.maxLength = MAX_TEXT_MESSAGE_CHARS;
    this.messageInput.disabled = !this.canUseChat();
    this.messageInput.value = this.messageDraft;
    this.messageInput.oninput = () => {
      this.messageDraft = this.messageInput?.value ?? "";
    };

    const send = button("Send", "btn primary composer-send");
    send.type = "submit";
    send.disabled = !this.canUseChat();
    form.append(
      attach,
      this.messageInput,
      ...this.renderInlineVoiceControls(),
      send,
      fileInput,
    );
    wrap.append(form);
    return wrap;
  }

  private renderInlineVoiceControls(): HTMLElement[] {
    if (this.isVoiceActive()) {
      const mute = button(
        this.state?.voice === "muted" ? "Unmute" : "Mute",
        "btn ghost compact voice-control",
      );
      mute.onclick = () => this.controller.toggleMute();
      const stop = button("Stop", "btn danger compact voice-control");
      stop.onclick = () =>
        void this.controller.stopVoice().catch((err) => this.showError(err));
      return [mute, stop];
    }
    const voice = button(
      this.state?.voice === "starting" ? "…" : "🎙",
      "btn ghost compact voice-control mic",
    );
    voice.title = "Start voice";
    voice.setAttribute("aria-label", "Start voice");
    voice.disabled = !this.canUseChat() || this.state?.voice === "starting";
    voice.onclick = () =>
      void this.controller.startVoice().catch((err) => this.showError(err));
    return [voice];
  }

  private renderActiveSheet(): HTMLElement | null {
    switch (this.activeSheet) {
      case "room":
        return this.renderSheet("Room details", this.renderRoomBody());
      case "verify":
        return this.renderSheet("Verify chat", this.renderVerifyBody());
      case "about":
        return this.renderSheet("How OnlyTwo works", this.renderAboutBody());
      case "leave":
        return this.renderSheet(
          "End chat for both?",
          this.renderLeaveBody(),
          "danger-sheet",
        );
      default:
        return null;
    }
  }

  private renderSheet(
    title: string,
    body: HTMLElement,
    extraClass = "",
  ): HTMLElement {
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
    codeBlock.append(
      el("div", "info-label", "Room code"),
      el("div", "room-code-large", code),
    );
    const codeActions = el("div", "button-row");
    const copy = button("Copy code", "btn compact");
    copy.onclick = () => void this.copyRoomCode();
    const share = button("Share room", "btn compact");
    share.onclick = () => void this.shareRoom();
    codeActions.append(copy, share);
    codeBlock.append(codeActions);

    const status = this.renderKeyValueBlock("Status", [
      ["Connection", connectionLabel(this.state?.connection ?? "disconnected")],
      ["Encryption", encryptionLabel(this.state?.security ?? "none")],
      ["Profile", profile.label],
    ]);
    const profileBlock = el("div", "info-block");
    profileBlock.append(
      el("div", "info-label", "Locked room profile"),
      el("strong", undefined, profile.label),
      el("p", undefined, profilePlainDescription(profile.id)),
      el(
        "p",
        "profile-note",
        "The creator selected this profile when the room was created. Both peers use the same profile, including after refresh.",
      ),
    );
    const about = button("How OnlyTwo works", "link-btn");
    about.onclick = () => this.openSheet("about");
    body.append(codeBlock, status, profileBlock, about);
    return body;
  }

  private renderVerifyBody(): HTMLElement {
    const body = el("div", "sheet-body");
    body.append(
      el(
        "p",
        undefined,
        "Compare this phrase with the other person using a different channel or by speaking it aloud.",
      ),
    );
    const phrase = el("div", "safety-phrase");
    const words = (this.state?.safetyPhrase ?? "").split(" ").filter(Boolean);
    const split = Math.ceil(words.length / 2);
    phrase.append(el("div", undefined, words.slice(0, split).join(" ")));
    if (words.length > split)
      phrase.append(el("div", undefined, words.slice(split).join(" ")));
    body.append(phrase);
    const actions = el("div", "button-row");
    const yes = button(
      this.state?.security === "verified" ? "Verified" : "Mark as verified",
      "btn primary",
    );
    yes.disabled = this.state?.security === "verified";
    yes.onclick = () => {
      this.closeSheet();
      void this.controller
        .markVerified(true)
        .catch((err) => this.showError(err));
    };
    const no = button("Does not match", "btn danger");
    no.onclick = () => {
      this.closeSheet();
      void this.controller
        .markVerified(false)
        .catch((err) => this.showError(err));
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
        "Room profile",
        "The creator chooses one transport profile for the room. Both browsers use that locked profile, including after refresh.",
      ),
      this.aboutSection(
        "Verification",
        "Encryption starts automatically. Compare the safety phrase to confirm who you are talking to.",
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
    modes.append(el("div", "info-label", "Transport profiles"));
    for (const id of PROFILE_IDS) {
      const profile = getProfile(id);
      const row = el("div", "mode-row");
      row.append(
        el("strong", undefined, profile.label),
        el("p", undefined, profilePlainDescription(id)),
      );
      modes.append(row);
    }
    body.append(modes);
    return body;
  }

  private aboutSection(title: string, text: string): HTMLElement {
    const section = el("div", "info-block");
    section.append(el("div", "info-label", title), el("p", undefined, text));
    return section;
  }

  private renderLeaveBody(): HTMLElement {
    const body = el("div", "sheet-body");
    body.append(
      el(
        "p",
        undefined,
        "This ends the room for both people. Voice, transfers, local chat views, and cryptographic state are cleared. The old room code cannot be reused.",
      ),
    );
    const actions = el("div", "button-row");
    const leave = button("End chat for both", "btn danger");
    leave.onclick = () => {
      this.closeSheet();
      this.controller.endChatForBoth();
    };
    const stay = button("Stay", "btn");
    stay.onclick = () => this.closeSheet();
    actions.append(leave, stay);
    body.append(actions);
    return body;
  }

  private renderKeyValueBlock(
    title: string,
    rows: Array<[string, string]>,
  ): HTMLElement {
    const block = el("div", "info-block");
    block.append(el("div", "info-label", title));
    for (const [key, value] of rows) {
      const row = el("div", "key-value");
      row.append(el("span", undefined, key), el("strong", undefined, value));
      block.append(row);
    }
    return block;
  }

  private renderToast(): HTMLElement | null {
    return this.toast
      ? el("div", `toast ${this.toast.tone}`, this.toast.message)
      : null;
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

  private isVoiceActive(): boolean {
    return ["starting", "active", "muted"].includes(
      this.state?.voice ?? "idle",
    );
  }

  private canUseChat(): boolean {
    return (
      this.state?.connection === "connected" &&
      ["encrypted_unverified", "verified"].includes(
        this.state?.security ?? "none",
      )
    );
  }

  private async shareRoom(): Promise<void> {
    const code = this.state?.roomCode ?? "";
    const url = roomLink(code);
    const text = `Join my OnlyTwo room: ${code}\n${url}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "OnlyTwo room", text, url });
        return;
      } catch {}
    }
    await this.copyText(text, "Room link copied.");
  }

  private async copyRoomCode(): Promise<void> {
    const code = this.state?.roomCode ?? "";
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.codeCopied = true;
      this.showToast("Room code copied.");
      setTimeout(() => {
        this.codeCopied = false;
        this.scheduleRender();
      }, 1200);
    } catch (err) {
      this.showError(err);
    }
  }

  private async copyText(text: string, confirmation: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.lastError = null;
      this.showToast(confirmation);
    } catch (err) {
      this.showError(err);
    }
  }

  private showToast(message: string, tone: ToastTone = "info"): void {
    this.setToast(message, tone, true);
  }

  private setToast(message: string, tone: ToastTone, render: boolean): void {
    this.toast = { message, tone };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.toastTimer = null;
      this.scheduleRender();
    }, 2600);
    if (render) this.scheduleRender();
  }

  private showError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    this.showToast(this.lastError, "error");
  }

  private captureRenderPosition(): RenderPosition {
    const transcript = this.root.querySelector<HTMLElement>(".transcript");
    const active = document.activeElement;
    const isMessage = active === this.messageInput;
    const isRoom = active === this.roomInput;
    return {
      messageFocused: isMessage,
      roomFocused: isRoom,
      selectionStart:
        isMessage || isRoom
          ? (active as HTMLInputElement).selectionStart
          : null,
      selectionEnd:
        isMessage || isRoom ? (active as HTMLInputElement).selectionEnd : null,
      transcriptScrollTop: transcript?.scrollTop ?? 0,
      transcriptNearBottom: transcript
        ? transcript.scrollHeight -
            transcript.scrollTop -
            transcript.clientHeight <
          72
        : true,
    };
  }

  private restoreRenderPosition(position: RenderPosition): void {
    const transcript = this.root.querySelector<HTMLElement>(".transcript");
    if (transcript)
      transcript.scrollTop = position.transcriptNearBottom
        ? transcript.scrollHeight
        : position.transcriptScrollTop;
    const input = position.messageFocused
      ? this.messageInput
      : position.roomFocused
        ? this.roomInput
        : null;
    if (!input || input.disabled) return;
    input.focus();
    if (position.selectionStart !== null && position.selectionEnd !== null) {
      input.setSelectionRange(position.selectionStart, position.selectionEnd);
    }
  }
}

function noticeToastTone(notice: string): ToastTone | null {
  if (
    /denied|failed|could not|not ready|blocked|unstable|mismatch|lost|unavailable|incompatible/i.test(
      notice,
    )
  )
    return "error";
  if (/enabled|copied/i.test(notice)) return "info";
  return null;
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
      return transfer.direction === "receive" ? "Incoming file" : "Offered";
    case "waiting":
      return "Waiting for peer acceptance";
    case "sending":
      return "Uploading";
    case "receiving":
      return "Downloading";
    case "paused":
      return transfer.reason || "Paused";
    case "completed":
      return transfer.direction === "receive" ? "Received" : "Sent";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return transfer.reason || "Transfer failed";
  }
}

function transferMeta(transfer: TransferView): string {
  const parts = [transferStateLabel(transfer)];
  if (!isTerminalTransfer(transfer.state) && transfer.state !== "offered")
    parts.push(formatProgress(transfer.progress));
  return parts.join(" · ");
}

function isTerminalTransfer(state: TransferView["state"]): boolean {
  return ["completed", "cancelled", "failed"].includes(state);
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

function formatTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp);
  } catch {
    return "";
  }
}

function progressPercent(progress: number): number {
  return Math.max(0, Math.min(100, progress * 100));
}

function formatProgress(progress: number): string {
  return `${Math.round(progressPercent(progress))}%`;
}
