import type { LaneName } from "../config/profiles";

export interface TransportMetrics {
  queuedPackets: number;
  queuedBytes: number;
  sentPackets: number;
  sentBytes: number;
  droppedVoiceFrames: number;
  reconnects: number;
  backpressurePauses: number;
  lastError: string | null;
  lanePackets: Record<LaneName, number>;
  laneBytes: Record<LaneName, number>;
}

export function createTransportMetrics(): TransportMetrics {
  return {
    queuedPackets: 0,
    queuedBytes: 0,
    sentPackets: 0,
    sentBytes: 0,
    droppedVoiceFrames: 0,
    reconnects: 0,
    backpressurePauses: 0,
    lastError: null,
    lanePackets: { control: 0, text: 0, file: 0, voice: 0 },
    laneBytes: { control: 0, text: 0, file: 0, voice: 0 }
  };
}
