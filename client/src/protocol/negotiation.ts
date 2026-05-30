import { profileHashInput, type TransportProfile } from "../config/profiles";
import { bytesToHex, sha256, utf8Encode } from "../utils/bytes";
import { APP_VERSION, FEATURE_FLAGS } from "./appMessages";

const WORDS = [
  "river",
  "lunar",
  "copper",
  "hawk",
  "signal",
  "stone",
  "violet",
  "orbit",
  "cedar",
  "silver",
  "ember",
  "north",
  "silent",
  "anchor",
  "prism",
  "comet",
  "field",
  "winter",
  "summit",
  "clear",
  "falcon",
  "harbor",
  "magnet",
  "solar",
  "forest",
  "quartz",
  "velvet",
  "island",
  "canyon",
  "brave",
  "delta",
  "marble",
  "radar",
  "willow",
  "aurora",
  "coral",
  "sable",
  "meteor",
  "bison",
  "atlas",
  "frost",
  "olive",
  "binary",
  "echo",
  "granite",
  "lotus",
  "nebula",
  "onyx",
  "pixel",
  "raven",
  "saffron",
  "tundra",
  "umbra",
  "vector",
  "yonder",
  "zenith",
  "amber",
  "brook",
  "cipher",
  "drift",
  "forge",
  "meadow",
  "plain",
  "root",
];

export async function profileHash(profile: TransportProfile): Promise<string> {
  const digest = await sha256(utf8Encode(profileHashInput(profile)));
  return bytesToHex(digest.slice(0, 16));
}

export async function verificationPhrase(input: {
  localPublicKey: Uint8Array;
  peerPublicKey: Uint8Array;
  profile: TransportProfile;
  sessionCode: string;
  peerAppVersion: string;
  peerFeatureFlags: string[];
}): Promise<string> {
  const localHex = bytesToHex(input.localPublicKey);
  const peerHex = bytesToHex(input.peerPublicKey);
  const [a, b] = localHex < peerHex ? [localHex, peerHex] : [peerHex, localHex];
  const sessionDigest = await sha256(utf8Encode(input.sessionCode));
  const material = {
    app: "onlytwo",
    appVersion: APP_VERSION,
    peerAppVersion: input.peerAppVersion,
    featureFlags: [...FEATURE_FLAGS],
    peerFeatureFlags: [...input.peerFeatureFlags].sort(),
    protocolVersion: input.profile.protocolVersion,
    profileHash: await profileHash(input.profile),
    sessionCodeHash: bytesToHex(sessionDigest.slice(0, 16)),
    identityA: a,
    identityB: b,
  };
  const digest = await sha256(utf8Encode(JSON.stringify(material)));
  return Array.from(digest.slice(0, 8), (bte) => WORDS[bte & 63]).join(" ");
}
