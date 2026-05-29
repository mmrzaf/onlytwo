export type LaneName = "control" | "text" | "file" | "voice";
export type TransportProfileId = "balanced" | "low_data" | "voice_first" | "maximum_privacy";

export interface LaneBudget {
  priority: number;
  maxPackets: number;
  maxBytes: number;
  dropPolicy: "fail" | "drop-oldest";
}

export interface TransportProfile {
  id: TransportProfileId;
  label: string;
  description: string;
  protocolVersion: number;
  maxFrameBytes: number;
  paddingBuckets: number[];
  maxSkippedMessageKeys: number;
  outbox: { maxPackets: number; maxBytes: number };
  lanes: Record<LaneName, LaneBudget>;
  reconnect: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; jitterMs: number };
  files: {
    smallBytes: number;
    mediumBytes: number;
    maxFileBytes: number;
    maxMemoryReceiveBytes: number;
    chunkBytes: number;
    windowChunks: number;
    ackTimeoutMs: number;
    maxRetries: number;
  };
  voice: {
    frameMs: number;
    jitterTargetMs: number;
    jitterMaxFrames: number;
  };
}

const MB = 1024 * 1024;
const COMMON_LANES: Record<LaneName, LaneBudget> = {
  control: { priority: 100, maxPackets: 128, maxBytes: 2 * MB, dropPolicy: "fail" },
  voice: { priority: 80, maxPackets: 12, maxBytes: 768 * 1024, dropPolicy: "drop-oldest" },
  text: { priority: 60, maxPackets: 256, maxBytes: 4 * MB, dropPolicy: "fail" },
  file: { priority: 10, maxPackets: 16, maxBytes: 2 * MB, dropPolicy: "fail" }
};

export const PROFILES: Record<TransportProfileId, TransportProfile> = {
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "Best default for normal text, voice, and files.",
    protocolVersion: 4,
    maxFrameBytes: 256 * 1024,
    paddingBuckets: [4 * 1024, 16 * 1024, 64 * 1024, 128 * 1024],
    maxSkippedMessageKeys: 4096,
    outbox: { maxPackets: 384, maxBytes: 16 * MB },
    lanes: COMMON_LANES,
    reconnect: { maxAttempts: 18, baseDelayMs: 400, maxDelayMs: 5000, jitterMs: 350 },
    files: {
      smallBytes: 25 * MB,
      mediumBytes: 100 * MB,
      maxFileBytes: 512 * MB,
      maxMemoryReceiveBytes: 512 * MB,
      chunkBytes: 32 * 1024,
      windowChunks: 4,
      ackTimeoutMs: 12_000,
      maxRetries: 8
    },
    voice: { frameMs: 40, jitterTargetMs: 120, jitterMaxFrames: 12 }
  },
  low_data: {
    id: "low_data",
    label: "Low Data",
    description: "Uses less bandwidth and lower queue sizes.",
    protocolVersion: 4,
    maxFrameBytes: 128 * 1024,
    paddingBuckets: [4 * 1024, 16 * 1024, 64 * 1024],
    maxSkippedMessageKeys: 2048,
    outbox: { maxPackets: 192, maxBytes: 8 * MB },
    lanes: COMMON_LANES,
    reconnect: { maxAttempts: 20, baseDelayMs: 600, maxDelayMs: 6000, jitterMs: 450 },
    files: {
      smallBytes: 10 * MB,
      mediumBytes: 50 * MB,
      maxFileBytes: 256 * MB,
      maxMemoryReceiveBytes: 256 * MB,
      chunkBytes: 16 * 1024,
      windowChunks: 2,
      ackTimeoutMs: 16_000,
      maxRetries: 10
    },
    voice: { frameMs: 60, jitterTargetMs: 180, jitterMaxFrames: 10 }
  },
  voice_first: {
    id: "voice_first",
    label: "Voice First",
    description: "Keeps calls responsive. Files pause during calls.",
    protocolVersion: 4,
    maxFrameBytes: 256 * 1024,
    paddingBuckets: [4 * 1024, 16 * 1024, 64 * 1024],
    maxSkippedMessageKeys: 4096,
    outbox: { maxPackets: 256, maxBytes: 10 * MB },
    lanes: {
      ...COMMON_LANES,
      voice: { priority: 95, maxPackets: 10, maxBytes: 640 * 1024, dropPolicy: "drop-oldest" },
      file: { priority: 5, maxPackets: 8, maxBytes: 1 * MB, dropPolicy: "fail" }
    },
    reconnect: { maxAttempts: 18, baseDelayMs: 350, maxDelayMs: 4000, jitterMs: 250 },
    files: {
      smallBytes: 10 * MB,
      mediumBytes: 50 * MB,
      maxFileBytes: 256 * MB,
      maxMemoryReceiveBytes: 256 * MB,
      chunkBytes: 24 * 1024,
      windowChunks: 2,
      ackTimeoutMs: 12_000,
      maxRetries: 8
    },
    voice: { frameMs: 30, jitterTargetMs: 100, jitterMaxFrames: 14 }
  },
  maximum_privacy: {
    id: "maximum_privacy",
    label: "Maximum Privacy",
    description: "More padding. Higher bandwidth. Files and voice are more conservative.",
    protocolVersion: 4,
    maxFrameBytes: 256 * 1024,
    paddingBuckets: [64 * 1024, 128 * 1024],
    maxSkippedMessageKeys: 4096,
    outbox: { maxPackets: 192, maxBytes: 24 * MB },
    lanes: COMMON_LANES,
    reconnect: { maxAttempts: 18, baseDelayMs: 500, maxDelayMs: 5000, jitterMs: 400 },
    files: {
      smallBytes: 10 * MB,
      mediumBytes: 75 * MB,
      maxFileBytes: 256 * MB,
      maxMemoryReceiveBytes: 256 * MB,
      chunkBytes: 24 * 1024,
      windowChunks: 2,
      ackTimeoutMs: 16_000,
      maxRetries: 10
    },
    voice: { frameMs: 60, jitterTargetMs: 180, jitterMaxFrames: 10 }
  }
};

export const PROFILE_IDS = Object.keys(PROFILES) as TransportProfileId[];

export function getProfile(id: TransportProfileId): TransportProfile {
  return PROFILES[id] ?? PROFILES.balanced;
}

export function supportedProfileIds(): TransportProfileId[] {
  return [...PROFILE_IDS];
}

export function profileHashInput(profile: TransportProfile): string {
  return JSON.stringify({
    id: profile.id,
    protocolVersion: profile.protocolVersion,
    maxFrameBytes: profile.maxFrameBytes,
    paddingBuckets: profile.paddingBuckets,
    maxSkippedMessageKeys: profile.maxSkippedMessageKeys
  });
}
