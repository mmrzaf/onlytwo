import type { LaneName, TransportProfile } from "../config/profiles";
import { decodeAppMessage, encodeAppMessage, type AppMessage } from "../protocol/appMessages";
import { createAadContext, OuterType, type Envelope } from "../protocol/envelope";
import type { CryptoClient } from "./CryptoClient";

export class SecureChannel {
  private sequence = 0;

  constructor(private crypto: CryptoClient, private profile: TransportProfile) {}

  setProfile(profile: TransportProfile): void {
    this.profile = profile;
  }

  async encryptAppMessage(message: AppMessage, lane: LaneName): Promise<Envelope> {
    const draft = {
      protocolVersion: this.profile.protocolVersion,
      outerType: OuterType.DATA,
      flags: 0,
      streamId: streamForLane(lane),
      sequence: this.nextSequence(),
      lane
    };
    const encrypted = await this.crypto.encrypt(encodeAppMessage(message), createAadContext(draft, this.profile));
    return { ...draft, counter: encrypted.counter, nonce: encrypted.nonce, payload: encrypted.ciphertext };
  }

  async decryptAppMessage(env: Envelope): Promise<AppMessage> {
    if (env.outerType !== OuterType.DATA) throw new Error("Expected encrypted data frame");
    const plaintext = await this.crypto.decrypt(env.payload, env.nonce, env.counter, createAadContext(env, this.profile));
    return decodeAppMessage(plaintext);
  }

  private nextSequence(): number {
    this.sequence = (this.sequence + 1) >>> 0;
    if (this.sequence === 0) this.sequence = 1;
    return this.sequence;
  }
}

function streamForLane(lane: LaneName): number {
  switch (lane) {
    case "control": return 1;
    case "text": return 2;
    case "file": return 3;
    case "voice": return 4;
  }
}
