# BadHub: Decentralized WebAssembly P2P File Sharing Engine

BadHub is a 100% serverless, client-side peer-to-peer file sharing web application compiled from Go into WebAssembly. It combines convolutional Sliding-Window Random Linear Network Coding over GF(2) via **badrlnc** with post-quantum ChaCha20-Poly1305 AEAD authenticated encryption via **badcrypt**, orchestrated by the **badsharing** engine.

Transfers operate directly between web browsers over WebRTC DataChannels configured in unreliable, unordered mode (`ordered: false`, `maxRetransmits: 0`), effectively creating an encrypted UDP network in the browser sandbox. Lost packets are recovered on-the-fly using incremental Gauss-Jordan elimination without retransmission delays.

---

## Architecture Overview

```
+-------------------------------------------------------------------------------+
|                             Sender Web Browser                                |
|                                                                               |
|   +---------------+     +------------------+     +------------------------+   |
|   | Selected File | --> | badsharing.Sender| --> | badrlnc Sliding Window |   |
|   +---------------+     +------------------+     +------------------------+   |
|                                                              | (Shards)       |
|                                                              v                |
|   +--------------------------+     +--------------------------------------+   |
|   | WebRTC RTCDataChannel    | <-- | badcrypt ChaCha20-Poly1305 SealFrame |   |
|   | (Unordered, Unreliable)  |     | (Constant 1380B Authenticated Frame) |   |
|   +--------------------------+     +--------------------------------------+   |
+-------------------------------------------------------------------------------+
                                       |
                   Direct P2P UDP Wire / Network Loss
                                       v
+-------------------------------------------------------------------------------+
|                            Receiver Web Browser                               |
|                                                                               |
|   +--------------------------+     +--------------------------------------+   |
|   | WebRTC RTCDataChannel    | --> | badcrypt ChaCha20-Poly1305 OpenFrame |   |
|   | (Raw Wire Frames)        |     | (Rejects Forged/Tampered Frames O(1))|   |
|   +--------------------------+     +--------------------------------------+   |
|                                                              | (Plain Shards) |
|                                                              v                |
|   +--------------------------+     +--------------------------------------+   |
|   | InOrderResequencer       | <-- | badrlnc Gauss-Jordan Incremental     |   |
|   | (Monotonic Stream)       |     | Elimination Solver (GF(2))           |   |
|   +--------------------------+     +--------------------------------------+   |
|                |                                                              |
|                v                                                              |
|   +--------------------------+     +--------------------------------------+   |
|   | SHA-256 Verification     | --> | Reconstructed File Download          |   |
|   +--------------------------+     +--------------------------------------+   |
+-------------------------------------------------------------------------------+
```

---

## Core Technical Features

### 1. Zero-Server Decentralization
BadHub requires no backend application server, no central coordination database, and no cloud storage relays. All encryption, encoding, transmission, and decoding run strictly within the browser's WebAssembly sandbox.

### 2. Browser UDP Emulation via WebRTC DataChannels
Standard WebRTC DataChannels operate in TCP-like reliable mode with head-of-line blocking. BadHub explicitly configures:
```javascript
const channel = peerConnection.createDataChannel("badhub_channel", {
    ordered: false,
    maxRetransmits: 0
});
```
This forces the browser to transmit packets over raw SCTP/UDP without retransmission delays or sequence stalls. Packets arriving out of order or dropped by congested networks are passed directly to the application layer.

### 3. On-The-Fly Erasure Coding (badrlnc)
Rather than waiting for missing packets via TCP-style Automatic Repeat reQuest (ARQ), BadHub injects pseudo-random parity shards generated over a sliding window across GF(2). When a packet is lost, the incremental Gauss-Jordan linear solver reconstructs the missing data chunk the moment sufficient linear combinations arrive.

### 4. Post-Quantum AEAD Framing & Tamper Proofing (badcrypt)
Every wire frame is fixed to exactly 1380 bytes:
- 8 bytes: Dynamic Session ID (eliminates nonce reuse across file transfers).
- 12 bytes: 64-bit monotonically advancing nonce counter.
- 1344 bytes: ChaCha20 encrypted RLNC shard payload.
- 16 bytes: Poly1305 authentication tag.

Forged frames, pollution attacks, or corrupted bytes are detected and discarded in O(1) before touching the linear solver.

### 5. PBKDF2 Key Stretching
Passphrases are transformed into 32-byte cryptographic keys using PBKDF2 with 100,000 iterations of HMAC-SHA256 and a dedicated domain salt, providing protection against GPU-accelerated dictionary attacks.

### 6. Dual Signaling Modes
- **Serverless WebRTC**: Generates base64-encoded SDP tokens. Peers connect directly across the internet or LAN without an intermediary signaling server.
- **BroadcastChannel Loopback**: Uses browser-native BroadcastChannel API for testing between two tabs on the same machine.

---

## Repository Structure

```
badhub/
├── .github/
│   └── workflows/
│       ├── ci.yml            # CI: Go test & WebAssembly build check
│       └── deploy.yml        # CD: Automated deployment to GitHub Pages
├── cmd/
│   └── wasm/
│       └── main.go           # Go WebAssembly bridge (syscall/js)
├── web/
│   ├── index.html            # User interface
│   ├── style.css             # Dark theme stylesheet (zero external CSS)
│   ├── app.js                # WebRTC & WASM coordination
│   ├── wasm_exec.js          # Go 1.24 WebAssembly runtime bridge
│   └── main.wasm             # Compiled WebAssembly binary
├── scripts/
│   ├── build.sh              # WebAssembly compilation script
│   └── serve.sh              # Lightweight local HTTP server
├── Makefile                  # Build and development automation
├── hub_test.go               # Go test suite
├── go.mod                    # Module definition
├── go.sum                    # Checksums
├── LICENSE                   # Apache 2.0 License
└── README.md                 # Technical documentation
```

---

## Local Development & Quickstart

### Prerequisites
- Go 1.24 or later
- Modern web browser with WebAssembly and WebRTC support (Chrome, Firefox, Safari, Edge)

### 1. Build WebAssembly Binary
```bash
make build
# or: ./scripts/build.sh
```

### 2. Start Local Development Server
```bash
make serve
# or: ./scripts/serve.sh 8080
```
Navigate to `http://127.0.0.1:8080` in your web browser.

### 3. Run Tests
```bash
make test
```

---

## JavaScript / WebAssembly API Reference

The Go WebAssembly binary registers the `window.BadHub` global interface:

### Sender API
- `BadHub.initSender(fileName, fileBytes, passphrase, redundancyRatio, windowSize)`
  Initializes a sliding-window RLNC sender and seals encrypted metadata.
  Returns: `{ success, sessionID, name, size, checksum, chunkSize, totalChunks, encryptedMetadata, rawMetadata }`.

- `BadHub.nextSenderFrame()`
  Pulls the next calibrated 1380-byte encrypted frame.
  Returns: `{ frame: Uint8Array, eof: bool, error: string }`.

- `BadHub.getSenderStats()`
  Returns: `{ dataPackets: number, parityPackets: number }`.

### Receiver API
- `BadHub.initReceiver(metadataBytes, passphrase)`
  Authenticates and decrypts file metadata, preparing the Gauss-Jordan incremental solver.
  Returns: `{ success, sessionID, name, size, checksum, totalChunks }`.

- `BadHub.ingestReceiverFrame(frameBytes)`
  Decrypts incoming 1380-byte frame, verifies anti-replay counter, and feeds shard to solver.
  Returns: `{ completed, bytesReceived, totalBytes, percent, framesReceived, framesDropped, error }`.

- `BadHub.finalizeReceiver()`
  Flushes the in-order resequencer and verifies end-to-end SHA-256 integrity.
  Returns: `{ success, data: Uint8Array, name: string, size: number, checksum: string }`.

---

## License

BadHub is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
