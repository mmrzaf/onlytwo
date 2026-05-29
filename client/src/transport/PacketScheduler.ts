import type { LaneBudget, LaneName, TransportProfile } from "../config/profiles";

export interface QueuedPacket { lane: LaneName; bytes: Uint8Array }
interface LaneQueue { packets: QueuedPacket[]; bytes: number }
export interface EnqueueResult { ok: boolean; dropped: number; reason?: string }
export interface QueueSnapshot { packets: number; bytes: number; lanePackets: Record<LaneName, number>; laneBytes: Record<LaneName, number> }

const LANES: LaneName[] = ["control", "voice", "text", "file"];

export class PacketScheduler {
  private queues: Record<LaneName, LaneQueue> = {
    control: { packets: [], bytes: 0 },
    voice: { packets: [], bytes: 0 },
    text: { packets: [], bytes: 0 },
    file: { packets: [], bytes: 0 }
  };
  private totalPackets = 0;
  private totalBytes = 0;

  constructor(private profile: TransportProfile) {}

  setProfile(profile: TransportProfile): void { this.profile = profile; }

  enqueue(packet: QueuedPacket): EnqueueResult {
    if (packet.bytes.byteLength > this.profile.maxFrameBytes) return { ok: false, dropped: 0, reason: "frame_too_large" };
    const q = this.queues[packet.lane];
    const cfg = this.profile.lanes[packet.lane];
    let dropped = 0;
    while (this.wouldOverflow(q, cfg, packet.bytes.byteLength)) {
      if (cfg.dropPolicy !== "drop-oldest" || q.packets.length === 0) return { ok: false, dropped, reason: "queue_full" };
      const removed = q.packets.shift()!;
      q.bytes -= removed.bytes.byteLength;
      this.totalPackets -= 1;
      this.totalBytes -= removed.bytes.byteLength;
      dropped += 1;
    }
    q.packets.push(packet);
    q.bytes += packet.bytes.byteLength;
    this.totalPackets += 1;
    this.totalBytes += packet.bytes.byteLength;
    return { ok: true, dropped };
  }

  next(): QueuedPacket | null {
    const lane = LANES.filter((name) => this.queues[name].packets.length > 0).sort((a, b) => this.profile.lanes[b].priority - this.profile.lanes[a].priority)[0];
    if (!lane) return null;
    const q = this.queues[lane];
    const packet = q.packets.shift();
    if (!packet) return null;
    q.bytes -= packet.bytes.byteLength;
    this.totalPackets -= 1;
    this.totalBytes -= packet.bytes.byteLength;
    return packet;
  }

  clearVolatile(): void { this.clearLane("voice"); }
  clear(): void { for (const lane of LANES) this.clearLane(lane); }

  snapshot(): QueueSnapshot {
    return {
      packets: this.totalPackets,
      bytes: this.totalBytes,
      lanePackets: { control: this.queues.control.packets.length, text: this.queues.text.packets.length, file: this.queues.file.packets.length, voice: this.queues.voice.packets.length },
      laneBytes: { control: this.queues.control.bytes, text: this.queues.text.bytes, file: this.queues.file.bytes, voice: this.queues.voice.bytes }
    };
  }

  private wouldOverflow(q: LaneQueue, cfg: LaneBudget, nextBytes: number): boolean {
    return q.packets.length >= cfg.maxPackets || q.bytes + nextBytes > cfg.maxBytes || this.totalPackets >= this.profile.outbox.maxPackets || this.totalBytes + nextBytes > this.profile.outbox.maxBytes;
  }

  private clearLane(lane: LaneName): void {
    const q = this.queues[lane];
    this.totalPackets -= q.packets.length;
    this.totalBytes -= q.bytes;
    q.packets = [];
    q.bytes = 0;
  }
}
