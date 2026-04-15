import type { ConnectionStatus } from "../transport/wsClient";

export type ConnectionState = {
  status: ConnectionStatus;
  lastError: string | null;
};

export const createConnectionState = (): ConnectionState => ({
  status: "disconnected",
  lastError: null,
});
