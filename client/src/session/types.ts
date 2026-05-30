import type { TransportProfileId } from "../config/profiles";
import type { ConnectionStatus } from "../transport/WebSocketConnection";

export type Phase =
  | "idle"
  | "creating"
  | "joining"
  | "waiting"
  | "active"
  | "ended"
  | "failed";
export type SecurityState =
  | "none"
  | "encrypted_unverified"
  | "verified"
  | "verification_failed";
export type VoiceState = "idle" | "starting" | "active" | "muted" | "failed";
export type TransferDirection = "send" | "receive";
export type TransferState =
  | "queued"
  | "offered"
  | "waiting"
  | "sending"
  | "receiving"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export interface TranscriptItem {
  id: string;
  kind: "text" | "system" | "file";
  from: "me" | "peer" | "system";
  text: string;
  at: number;
  status?: "sending" | "sent" | "failed";
  severity?: "info" | "error";
  fileId?: string;
}

export interface TransferView {
  fileId: string;
  direction: TransferDirection;
  name: string;
  size: number;
  progress: number;
  state: TransferState;
  reason?: string;
  blobUrl?: string;
}

export interface SessionViewState {
  phase: Phase;
  roomCode: string;
  profileId: TransportProfileId;
  connection: ConnectionStatus;
  security: SecurityState;
  safetyPhrase: string | null;
  notice: string | null;
  voice: VoiceState;
  muted: boolean;
  audioPlaybackBlocked: boolean;
  invalidPackets: number;
  transcript: TranscriptItem[];
  transfers: TransferView[];
}

export type StateListener = (state: SessionViewState) => void;
