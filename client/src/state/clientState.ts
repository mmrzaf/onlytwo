export type ClientPhase =
  | "idle"
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "handshaking"
  | "session_ready"
  | "chatting";

export type ClientState = {
  phase: ClientPhase;
  lastError: string | null;

  identityKeyReady: boolean;
  handshakeComplete: boolean;
  fingerprintPhrase: string | null;

  sessionCode: string;
  participantCount: number;
};

export function createClientState(): ClientState {
  return {
    phase: "disconnected",
    lastError: null,
    identityKeyReady: false,
    handshakeComplete: false,
    fingerprintPhrase: null,
    sessionCode: "",
    participantCount: 0,
  };
}
