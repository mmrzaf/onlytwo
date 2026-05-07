import { escapeHtml } from "../utils/escapeHtml";

export type Message = {
  text: string;
  timestamp: number;
  isSelf: boolean;
  isHtml?: boolean;
  isProgress?: boolean;
};

export class MessageStore {
  private messages: Message[] = [];

  constructor(private container: HTMLDivElement) {}

  add(message: Message) {
    this.messages.push(message);
    this.render();
  }

  updateLast(updater: (msg: Message) => void) {
    const last = this.messages[this.messages.length - 1];
    if (!last) return;
    updater(last);
    this.render();
  }

  clear() {
    this.messages.length = 0;
    this.render();
  }

  render() {
    this.container.innerHTML = "";
    for (const m of this.messages) {
      const div = document.createElement("div");
      div.className = `message-item ${m.isSelf ? "self" : ""}`;

      const timeStr = new Date(m.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      const timeEl = `<span class="message-time">${m.isSelf ? "You" : "Peer"} • ${timeStr}</span>`;
      const contentEl = m.isHtml ? m.text : escapeHtml(m.text);

      div.innerHTML = `${timeEl}<span>${contentEl}</span>`;
      this.container.appendChild(div);
    }
    this.container.scrollTop = this.container.scrollHeight;
  }
}
