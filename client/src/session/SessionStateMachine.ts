import type { Phase } from "./types";

export class SessionStateMachine {
  private phaseValue: Phase = "idle";
  get phase(): Phase { return this.phaseValue; }
  set(phase: Phase): void { this.phaseValue = phase; }
  canSendEncrypted(): boolean { return this.phaseValue === "active" || this.phaseValue === "waiting"; }
}
