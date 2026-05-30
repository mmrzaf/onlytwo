export type LaneName = "control" | "text" | "file" | "voice";
export type TransportProfileId =
  | "balanced"
  | "low_data"
  | "voice_first"
  | "maximum_privacy";
export type VoicePrivacyMode = "efficient" | "maximum_privacy";
export type VoiceCodec = "pcm16";

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
  outbox: {
    maxPackets: number;
    maxBytes: number;
    maxBufferedAmountBytes: number;
    resumeBufferedAmountBytes: number;
    drainYieldMs: number;
  };
  lanes: Record<LaneName, LaneBudget>;
  reconnect: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterMs: number;
  };
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
    enabled: boolean;
    mode: VoicePrivacyMode;
    codec: VoiceCodec;
    frameMs: number;
    jitterTargetMs: number;
    jitterMaxFrames: number;
    vadEnabled: boolean;
    vadStartDb: number;
    vadStopDb: number;
    vadPreRollMs: number;
    vadHangoverMs: number;
    vadMinSpeechMs: number;
    maxQueuedLatencyMs: number;
  };
}

const KB = 1024;
const MB = 1024 * KB;

function cloneLaneBudgets(
  overrides: Partial<Record<LaneName, Partial<LaneBudget>>> = {},
): Record<LaneName, LaneBudget> {
  const base: Record<LaneName, LaneBudget> = {
    control: {
      priority: 100,
      maxPackets: 128,
      maxBytes: 2 * MB,
      dropPolicy: "fail",
    },
    voice: {
      priority: 80,
      maxPackets: 12,
      maxBytes: 768 * KB,
      dropPolicy: "drop-oldest",
    },
    text: {
      priority: 60,
      maxPackets: 256,
      maxBytes: 4 * MB,
      dropPolicy: "fail",
    },
    file: {
      priority: 10,
      maxPackets: 16,
      maxBytes: 2 * MB,
      dropPolicy: "fail",
    },
  };

  return {
    control: { ...base.control, ...overrides.control },
    voice: { ...base.voice, ...overrides.voice },
    text: { ...base.text, ...overrides.text },
    file: { ...base.file, ...overrides.file },
  };
}

const COMMON_RECONNECT = {
  maxAttempts: 18,
  baseDelayMs: 450,
  maxDelayMs: 5000,
  jitterMs: 350,
};

export const PROFILES: Record<TransportProfileId, TransportProfile> = {
  balanced: {
    id: "balanced",
    label: "Balanced",
    description:
      "Default profile with conservative beta file limits, VAD voice, and bounded queues.",
    protocolVersion: 2,
    maxFrameBytes: 256 * KB,
    paddingBuckets: [4 * KB, 16 * KB, 64 * KB, 128 * KB],
    maxSkippedMessageKeys: 512,
    outbox: {
      maxPackets: 384,
      maxBytes: 16 * MB,
      maxBufferedAmountBytes: 2 * MB,
      resumeBufferedAmountBytes: 768 * KB,
      drainYieldMs: 0,
    },
    lanes: cloneLaneBudgets(),
    reconnect: COMMON_RECONNECT,
    files: {
      smallBytes: 10 * MB,
      mediumBytes: 25 * MB,
      maxFileBytes: 50 * MB,
      maxMemoryReceiveBytes: 50 * MB,
      chunkBytes: 32 * KB,
      windowChunks: 4,
      ackTimeoutMs: 12_000,
      maxRetries: 8,
    },
    voice: {
      enabled: true,
      mode: "efficient",
      codec: "pcm16",
      frameMs: 40,
      jitterTargetMs: 120,
      jitterMaxFrames: 12,
      vadEnabled: true,
      vadStartDb: -45,
      vadStopDb: -52,
      vadPreRollMs: 120,
      vadHangoverMs: 250,
      vadMinSpeechMs: 60,
      maxQueuedLatencyMs: 400,
    },
  },
  low_data: {
    id: "low_data",
    label: "Low Data",
    description:
      "Lower bandwidth profile with smaller files and smaller queues.",
    protocolVersion: 2,
    maxFrameBytes: 128 * KB,
    paddingBuckets: [4 * KB, 16 * KB, 64 * KB],
    maxSkippedMessageKeys: 512,
    outbox: {
      maxPackets: 192,
      maxBytes: 8 * MB,
      maxBufferedAmountBytes: 1 * MB,
      resumeBufferedAmountBytes: 384 * KB,
      drainYieldMs: 0,
    },
    lanes: cloneLaneBudgets({
      voice: { maxPackets: 8, maxBytes: 384 * KB },
      file: { maxPackets: 8, maxBytes: 1 * MB },
    }),
    reconnect: {
      maxAttempts: 20,
      baseDelayMs: 600,
      maxDelayMs: 6000,
      jitterMs: 450,
    },
    files: {
      smallBytes: 5 * MB,
      mediumBytes: 10 * MB,
      maxFileBytes: 25 * MB,
      maxMemoryReceiveBytes: 25 * MB,
      chunkBytes: 16 * KB,
      windowChunks: 2,
      ackTimeoutMs: 16_000,
      maxRetries: 10,
    },
    voice: {
      enabled: true,
      mode: "efficient",
      codec: "pcm16",
      frameMs: 60,
      jitterTargetMs: 180,
      jitterMaxFrames: 10,
      vadEnabled: true,
      vadStartDb: -43,
      vadStopDb: -50,
      vadPreRollMs: 120,
      vadHangoverMs: 300,
      vadMinSpeechMs: 80,
      maxQueuedLatencyMs: 500,
    },
  },
  voice_first: {
    id: "voice_first",
    label: "Voice First",
    description:
      "Prioritizes low-latency voice; file transfer is intentionally conservative during calls.",
    protocolVersion: 2,
    maxFrameBytes: 256 * KB,
    paddingBuckets: [4 * KB, 16 * KB, 64 * KB],
    maxSkippedMessageKeys: 512,
    outbox: {
      maxPackets: 256,
      maxBytes: 10 * MB,
      maxBufferedAmountBytes: 1536 * KB,
      resumeBufferedAmountBytes: 512 * KB,
      drainYieldMs: 0,
    },
    lanes: cloneLaneBudgets({
      voice: {
        priority: 95,
        maxPackets: 10,
        maxBytes: 640 * KB,
        dropPolicy: "drop-oldest",
      },
      file: {
        priority: 5,
        maxPackets: 8,
        maxBytes: 1 * MB,
        dropPolicy: "fail",
      },
    }),
    reconnect: {
      maxAttempts: 18,
      baseDelayMs: 350,
      maxDelayMs: 4000,
      jitterMs: 250,
    },
    files: {
      smallBytes: 5 * MB,
      mediumBytes: 25 * MB,
      maxFileBytes: 50 * MB,
      maxMemoryReceiveBytes: 50 * MB,
      chunkBytes: 24 * KB,
      windowChunks: 2,
      ackTimeoutMs: 12_000,
      maxRetries: 8,
    },
    voice: {
      enabled: true,
      mode: "efficient",
      codec: "pcm16",
      frameMs: 30,
      jitterTargetMs: 100,
      jitterMaxFrames: 14,
      vadEnabled: true,
      vadStartDb: -47,
      vadStopDb: -54,
      vadPreRollMs: 120,
      vadHangoverMs: 220,
      vadMinSpeechMs: 50,
      maxQueuedLatencyMs: 250,
    },
  },
  maximum_privacy: {
    id: "maximum_privacy",
    label: "Maximum Privacy",
    description:
      "Higher bandwidth profile. Uses larger padding and constant-cadence voice.",
    protocolVersion: 2,
    maxFrameBytes: 256 * KB,
    paddingBuckets: [64 * KB, 128 * KB],
    maxSkippedMessageKeys: 512,
    outbox: {
      maxPackets: 192,
      maxBytes: 24 * MB,
      maxBufferedAmountBytes: 2 * MB,
      resumeBufferedAmountBytes: 768 * KB,
      drainYieldMs: 0,
    },
    lanes: cloneLaneBudgets({
      voice: {
        priority: 85,
        maxPackets: 16,
        maxBytes: 1 * MB,
        dropPolicy: "drop-oldest",
      },
      file: { maxPackets: 8, maxBytes: 1 * MB },
    }),
    reconnect: {
      maxAttempts: 18,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      jitterMs: 400,
    },
    files: {
      smallBytes: 5 * MB,
      mediumBytes: 10 * MB,
      maxFileBytes: 25 * MB,
      maxMemoryReceiveBytes: 25 * MB,
      chunkBytes: 24 * KB,
      windowChunks: 2,
      ackTimeoutMs: 16_000,
      maxRetries: 10,
    },
    voice: {
      enabled: true,
      mode: "maximum_privacy",
      codec: "pcm16",
      frameMs: 60,
      jitterTargetMs: 180,
      jitterMaxFrames: 10,
      vadEnabled: false,
      vadStartDb: -45,
      vadStopDb: -52,
      vadPreRollMs: 0,
      vadHangoverMs: 0,
      vadMinSpeechMs: 0,
      maxQueuedLatencyMs: 500,
    },
  },
};

export const PROFILE_IDS = Object.keys(PROFILES) as TransportProfileId[];

export function isTransportProfileId(
  value: unknown,
): value is TransportProfileId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(PROFILES, value)
  );
}

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
    maxSkippedMessageKeys: profile.maxSkippedMessageKeys,
    outbox: profile.outbox,
    lanes: profile.lanes,
    reconnect: profile.reconnect,
    files: profile.files,
    voice: profile.voice,
  });
}
