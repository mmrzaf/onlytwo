import _libsodium from "libsodium-wrappers-sumo";
let libsodium: typeof _libsodium;
export interface KeyPair {
  keyType: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

// State
let myKeyPair: KeyPair | null = null;
let sessionKeyTx: Uint8Array | null = null;
let sessionKeyRx: Uint8Array | null = null;

let txCounter = 0n;
let rxCounter = 0n;

async function init() {
  await _libsodium.ready;
  libsodium = _libsodium;
  self.postMessage({ type: "READY" });
}

function hashRatchet(key: Uint8Array): Uint8Array {
  const newKey = libsodium.crypto_generichash(32, key, null);
  libsodium.memzero(key);
  return newKey;
}

self.onmessage = async (e) => {
  if (!libsodium) return;
  const { type, payload, id } = e.data;

  try {
    switch (type) {
      case "GENERATE_IDENTITY": {
        myKeyPair = libsodium.crypto_kx_keypair();
        self.postMessage({ id, result: myKeyPair.publicKey });
        break;
      }

      case "ESTABLISH_SESSION": {
        if (!myKeyPair) throw new Error("Identity not generated");

        const peerPublicKey = payload;

        // --- P2P ROLE RESOLUTION ---
        // Libsodium requires explicit Client/Server roles to align Tx/Rx keys.
        // We deterministically assign roles by comparing the public keys.
        let amIClient = false;
        for (let i = 0; i < 32; i++) {
          if (myKeyPair.publicKey[i] !== peerPublicKey[i]) {
            amIClient = myKeyPair.publicKey[i] < peerPublicKey[i];
            break;
          }
        }

        let keys;
        if (amIClient) {
          // I have the smaller key, I act as the Client
          keys = libsodium.crypto_kx_client_session_keys(
            myKeyPair.publicKey,
            myKeyPair.privateKey,
            peerPublicKey,
          );
        } else {
          // I have the larger key, I act as the Server
          keys = libsodium.crypto_kx_server_session_keys(
            myKeyPair.publicKey, // Server PK
            myKeyPair.privateKey, // Server SK
            peerPublicKey, // Client PK
          );
        }

        sessionKeyTx = keys.sharedTx;
        sessionKeyRx = keys.sharedRx;
        txCounter = 0n;
        rxCounter = 0n;

        // Generate matching fingerprint (Order doesn't matter here due to .sort())
        const sortedKeys = [myKeyPair.publicKey, peerPublicKey].sort((a, b) => {
          for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return a[i] - b[i];
          }
          return 0;
        });

        const combined = new Uint8Array(64);
        combined.set(sortedKeys[0], 0);
        combined.set(sortedKeys[1], 32);

        const hash = libsodium.crypto_generichash(16, combined, null);
        const hex = libsodium.to_hex(hash).substring(0, 8).toUpperCase();

        self.postMessage({ id, result: { fingerprint: hex } });
        break;
      }

      case "ENCRYPT_TEXT": {
        if (!sessionKeyTx) throw new Error("No TX session key");

        const nonce = libsodium.randombytes_buf(24);
        const counter = ++txCounter;
        const messageBytes = new TextEncoder().encode(payload);

        const ciphertext = libsodium.crypto_secretbox_easy(
          messageBytes,
          nonce,
          sessionKeyTx,
        );

        // Ratchet the TX key forward
        sessionKeyTx = hashRatchet(sessionKeyTx);

        self.postMessage({ id, result: { ciphertext, nonce, counter } });
        break;
      }

      case "DECRYPT_TEXT": {
        if (!sessionKeyRx) throw new Error("No RX session key");

        const { ciphertext, nonce, counter } = payload;

        if (counter <= rxCounter) {
          throw new Error(
            `Replay attack detected: Invalid counter ${counter} <= ${rxCounter}`,
          );
        }

        // Fast-forward ratchet if messages arrived out of order/were dropped
        while (rxCounter < counter - 1n) {
          sessionKeyRx = hashRatchet(sessionKeyRx);
          rxCounter++;
        }

        const plaintextBytes = libsodium.crypto_secretbox_open_easy(
          ciphertext,
          nonce,
          sessionKeyRx,
        );

        // Ratchet once more for the current message we just decrypted
        sessionKeyRx = hashRatchet(sessionKeyRx);
        rxCounter = counter;

        const plaintext = new TextDecoder().decode(plaintextBytes);

        self.postMessage({ id, result: plaintext });
        break;
      }
      case "ENCRYPT_BINARY": {
        if (!sessionKeyTx) throw new Error("No TX session key");

        const nonce = libsodium.randombytes_buf(24);
        const counter = ++txCounter;
        const messageBytes = payload; // ALREADY A Uint8Array

        const ciphertext = libsodium.crypto_secretbox_easy(
          messageBytes,
          nonce,
          sessionKeyTx,
        );

        sessionKeyTx = hashRatchet(sessionKeyTx);
        self.postMessage({ id, result: { ciphertext, nonce, counter } });
        break;
      }

      case "DECRYPT_BINARY": {
        if (!sessionKeyRx) throw new Error("No RX session key");

        const { ciphertext, nonce, counter } = payload;

        if (counter <= rxCounter) {
          throw new Error(`Replay attack: ${counter} <= ${rxCounter}`);
        }

        while (rxCounter < counter - 1n) {
          sessionKeyRx = hashRatchet(sessionKeyRx);
          rxCounter++;
        }

        const plaintextBytes = libsodium.crypto_secretbox_open_easy(
          ciphertext,
          nonce,
          sessionKeyRx,
        );

        sessionKeyRx = hashRatchet(sessionKeyRx);
        rxCounter = counter;

        // RETURN RAW BYTES, DO NOT DECODE TO STRING
        self.postMessage({ id, result: plaintextBytes });
        break;
      }

      case "RESET": {
        if (myKeyPair && myKeyPair.privateKey) {
          libsodium.memzero(myKeyPair.privateKey);
        }
        if (sessionKeyTx) libsodium.memzero(sessionKeyTx);
        if (sessionKeyRx) libsodium.memzero(sessionKeyRx);

        myKeyPair = null;
        sessionKeyTx = null;
        sessionKeyRx = null;
        txCounter = 0n;
        rxCounter = 0n;

        self.postMessage({ id, result: true });
        break;
      }
    }
  } catch (err: any) {
    self.postMessage({ id, error: err.message });
  }
};

init();
