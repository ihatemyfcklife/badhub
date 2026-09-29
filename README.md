# BadHub

[![CI & Auto Release](https://github.com/ihatemyfcklife/badhub/actions/workflows/release.yml/badge.svg)](https://github.com/ihatemyfcklife/badhub/actions/workflows/release.yml)
[![Deploy GitHub Pages](https://github.com/ihatemyfcklife/badhub/actions/workflows/deploy.yml/badge.svg)](https://github.com/ihatemyfcklife/badhub/actions/workflows/deploy.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/ihatemyfcklife/badhub)](https://github.com/ihatemyfcklife/badhub/releases)

BadHub is a 100% serverless, client-side peer-to-peer file sharing and live media streaming web application compiled from Go into WebAssembly. It combines convolutional Sliding-Window Random Linear Network Coding over GF(2) via **badrlnc** with post-quantum ChaCha20-Poly1305 AEAD authenticated encryption via **badcrypt**, orchestrated by the **badsharing** engine.

- **GitHub Repository**: [https://github.com/ihatemyfcklife/badhub](https://github.com/ihatemyfcklife/badhub)
- **Live Web Application**: [https://ihatemyfcklife.github.io/badhub/](https://ihatemyfcklife.github.io/badhub/)

File transfers operate directly between web browsers over WebRTC DataChannels configured in unreliable, unordered mode (`ordered: false`, `maxRetransmits: 0`), effectively creating an encrypted UDP network in the browser sandbox. Lost packets are recovered on the fly using incremental Gauss-Jordan elimination, without retransmission delays or sequence stalls. Live media is delivered the same way: senders broadcast segmented audio and video that viewers can play progressively in native HTML5 players while the transfer is still in progress.

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

---

## Core Technical Features

### 1. Zero-Server Decentralization

BadHub requires no backend application server, no central coordination database, and no cloud storage relays. All encryption, encoding, transmission, and decoding run strictly within the client browser's WebAssembly sandbox.

### 2. Browser UDP Emulation via WebRTC DataChannels

Standard WebRTC DataChannels operate in TCP-like reliable mode with head-of-line blocking. BadHub explicitly configures:

```javascript
const channel = peerConnection.createDataChannel("badhub_channel", {
    ordered: false,
    maxRetransmits: 0
});
```

This forces the browser to transmit packets over raw SCTP/UDP without retransmission delays. Packets arriving out of order or dropped by congested networks are passed directly to the application layer.

### 3. Segmented Live Media Streaming (Broadcast Media and Watch & Listen)

BadHub provides two complementary media modes built on the same RLNC transport as file transfers:

- **Broadcast Media (sender)**: The sender selects a local audio or video file and streams it live. The file is processed segment by segment through the streaming sender pipeline (`initStreamingSender` / `feedSenderChunk`) instead of being fully buffered in memory, and the local preview player uses native HTML5 playback controls.
- **Watch & Listen (viewer)**: Viewers join the broadcast and play the incoming stream immediately, without waiting for the complete file to download. Decrypted chunks are exposed to the media element through an in-browser service worker (`sw-stream.js`), which answers HTTP 206 Partial Content range requests directly from the live P2P or Blossom-decrypted pipeline.
- Both modes share identical player dimensions and native browser controls, and both can be transported over WebRTC peer connections or the tab-to-tab BroadcastChannel for local multi-window workflows.

### 4. On-The-Fly Erasure Coding (badrlnc)

Rather than waiting for missing packets via TCP-style Automatic Repeat reQuest (ARQ), BadHub injects pseudo-random parity shards generated over a sliding window across GF(2). When a packet is lost, the incremental Gauss-Jordan linear solver reconstructs the missing data chunk the moment sufficient linear combinations arrive.

### 5. Post-Quantum AEAD Framing and Tamper Proofing (badcrypt)

Every wire frame is fixed to exactly 1380 bytes:

- 8 bytes: Dynamic Session ID (eliminates nonce reuse across file transfers).
- 12 bytes: 64-bit monotonically advancing nonce counter.
- 1344 bytes: ChaCha20 encrypted RLNC shard payload.
- 16 bytes: Poly1305 authentication tag.

Forged frames, pollution attacks, or corrupted bytes are detected and discarded in O(1) before touching the linear solver.

```

### 6. PBKDF2 Key Stretching

Passphrases are transformed into 32-byte cryptographic keys using PBKDF2 with 100,000 iterations of HMAC-SHA256 and a dedicated domain salt, providing protection against GPU-accelerated dictionary attacks.

### 7. One-Click Magic Link and QR Code Zero-Knowledge Signaling

- **Ephemeral Rooms**: Ephemeral peer rooms (`bad-xxxxxx`) allow immediate connection without central user registration.
- **RFC 3986 URL Hash Privacy**: Magic links (`#room=...&key=...`) encode the decryption passphrase entirely within the URL hash fragment. Per HTTP specifications, fragments are never transmitted to web servers, CDNs, or GitHub Pages.
- **Pure SVG QR Codes**: An integrated client-side SVG QR code generator enables instant mobile device pairing without third-party APIs.

### 8. IP Masking via TURN Relay Mode (`iceTransportPolicy: 'relay'`)

To ensure network-level anonymity in addition to content encryption:

- BadHub provides a one-click **Hide IP Address (TURN Relay Mode)** toggle.
- When active, WebRTC strictly applies `iceTransportPolicy: 'relay'`, blocking the generation of `host` (LAN) and `srflx` (public IP) ICE candidates.
- All encrypted frames transit through a blind TURN relay (preconfigured with the Open Relay Project by Metered on ports 80/443, with support for custom CoTURN instances).
- Magic links automatically pass `&relay=1` so recipients join with IP masking automatically enabled.

### 9. Decentralized Relays (Nostr, Zero IP Exposure)

For users requiring zero direct IP exposure and zero single-relay dependency without the heavy latency of Tor:

- BadHub integrates a fully automated **Decentralized Relays (Nostr)** transport mode.
- Shards encrypted with ChaCha20-Poly1305 are encapsulated into signed **ephemeral Nostr events** (NIP-01/NIP-16 `kind: 20001`) signed via BIP-340 Schnorr with ephemeral session keys.
- Relays (e.g. `relay.damus.io`, `nos.lol`, `nostr.mom`) are strictly forbidden by NIP-16 from writing ephemeral events to persistent storage; they forward packets purely in memory in real time.
- Sender and receiver never connect directly, never contact STUN/TURN, and never exchange ICE candidates, eliminating any mutual IP exposure.
- No account, no extension, and no private key setup is required.

### 10. Mobile and Multi-Screen Responsive UI

- Fluid clamp typography and dynamic layout adaptation for screens down to 320px width.
- Touch-friendly 44px minimum target sizes and iOS Safari auto-zoom prevention (`font-size: 16px` inputs).
- Throttled DOM updates and event loop yielding for sustained line-rate throughput on mobile hardware.

---

## Repository Structure

```
badhub/
├── .github/
│   └── workflows/
│       ├── release.yml       # Semantic release tagging, WASM bundling & Go proxy warming
│       ├── deploy.yml        # Continuous deployment to GitHub Pages
│       └── update-deps.yml   # Automated 6h dependency updater for badsharing, badrlnc, badcrypt
├── cmd/
│   └── wasm/
│       └── main.go           # Go WebAssembly bridge (syscall/js)
├── web/
│   ├── index.html            # Responsive cyberpunk interface (~58 KB)
│   ├── style.css             # Zero-dependency responsive dark stylesheet (~27 KB)
│   ├── app.js                # WebRTC, PeerJS, TURN relay, Nostr swarm & WASM controller (~156 KB)
│   ├── wasm_exec.js          # Go 1.24 WebAssembly runtime bridge
│   ├── sw-stream.js          # In-browser media streaming service worker (HTTP 206 range serving)
│   ├── peerjs.min.js         # PeerJS signaling library for ephemeral room establishment
│   ├── qrcode.min.js         # Pure client-side SVG QR code generator
│   ├── nostr.bundle.js       # Lightweight Nostr client library with BIP-340 Schnorr
│   ├── version.json          # Application version stamp (currently v1.9.8)
│   ├── favicon.svg           # Vector application icon
│   ├── favicon.png           # Raster application icon
│   ├── favicon.ico           # Legacy browser favicon
│   └── main.wasm             # Optimized WebAssembly binary (~4.1 MB)
├── scripts/
│   ├── build.sh              # WebAssembly compilation script
│   └── serve.sh              # Lightweight local HTTP server with WASM MIME types
├── blossom.go                # Encrypted Blossom container format (stream encryptor/decryptor)
├── blossom_test.go           # Blossom container unit tests
├── Makefile                  # Build, test, and development automation
├── hub_test.go               # End-to-end integration and resilience test suite
├── go.mod                    # Module definition
├── go.sum                    # Checksums
├── LICENSE                   # Apache 2.0 License
└── README.md                 # Technical documentation
```

---

## Local Development and Quickstart

### Prerequisites

- Go 1.24 or later
- Modern web browser with WebAssembly and WebRTC support (Chrome, Firefox, Safari, Edge)

### 1. Build the WebAssembly Binary

```bash
make build
# or: GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o web/main.wasm ./cmd/wasm
```

### 2. Start the Local Development Server

```bash
make serve
# or: ./scripts/serve.sh 8080
```

Navigate to `http://127.0.0.1:8080` in your web browser.

### 3. Run the Test Suite

```bash
make test
# or: go test -v ./...
```

---

## JavaScript / WebAssembly API Reference

The Go WebAssembly binary registers the `window.BadHub` global interface. Every mutating call returns an object carrying `success: true` on success, or `{ success: false, error }` on failure. `BadHub.version` exposes the engine version and `BadHub.ready` signals initialization completion.

### Hashing API

- `BadHub.createSha256()`
  Creates a streaming hasher instance and returns its numeric `id`.

- `BadHub.updateSha256(id, chunk)`
  Feeds a `Uint8Array` chunk into the hasher identified by `id`.

- `BadHub.finalizeSha256(id)`
  Finalizes the hasher, releases the instance, and returns the lowercase hex SHA-256 digest. Used to compute file checksums entirely in the browser before a transfer starts.

### Sender API

- `BadHub.initSender(fileName, fileBytes, passphrase, redundancyRatio, windowSize)`
  Initializes a sliding-window RLNC sender over a complete in-memory file and seals the encrypted metadata.
  Returns: `{ success, sessionID, name, size, checksum, chunkSize, totalChunks, encryptedMetadata, rawMetadata }`.

- `BadHub.nextSenderFrame()`
  Pulls the next calibrated 1380-byte encrypted frame.
  Returns: `{ frame: Uint8Array, eof: bool, error: string }`.

- `BadHub.getSenderStats()`
  Returns: `{ dataPackets: number, parityPackets: number, currentGeneration: number }`.

### Streaming Sender API (Live Media)

- `BadHub.initStreamingSender(fileName, fileSize, checksumHex, passphrase, redundancyRatio, windowSize, generationSize)`
  Creates a sender in streaming mode, where content is fed incrementally instead of being loaded as a whole file. `redundancyRatio` defaults to `0.30`; `windowSize` and `generationSize` default to `64`.
  Returns: `{ success, sessionID, name, size, checksum, chunkSize, generationSize, totalGenerations, totalChunks, isStreaming: true, encryptedMetadata, rawMetadata }`.

- `BadHub.feedSenderChunk(chunk)`
  Writes a `Uint8Array` segment into the streaming sender pipe.
  Returns: `{ success, bufferLevel }`.

- `BadHub.getSenderBufferLevel()`
  Returns the number of bytes currently buffered in the streaming sender pipe, for backpressure-aware feed scheduling.

### Receiver API

- `BadHub.initReceiver(metadataBytes, passphrase)`
  Authenticates and decrypts file metadata, preparing the Gauss-Jordan incremental solver.
  Returns: `{ success, sessionID, name, size, checksum, totalChunks }`.

- `BadHub.ingestReceiverFrame(frameBytes)`
  Decrypts an incoming 1380-byte frame, verifies the anti-replay counter, and feeds the shard to the solver.
  Returns: `{ completed, bytesReceived, totalBytes, percent, framesReceived, framesDropped, error }`.

- `BadHub.recodeReceiverFrame()`
  Re-encodes a frame from the receiver's current solver state so it can be re-broadcast to other peers in the swarm over the BroadcastChannel or Nostr transports, improving collective loss recovery.
  Returns: `{ success, frame: Uint8Array }`.

- `BadHub.getReceiverStats()`
  Returns: `{ success, framesReceived, framesDropped, framesRecoded, currentGeneration }`.

- `BadHub.finalizeReceiver()`
  Flushes the in-order resequencer and verifies end-to-end SHA-256 integrity.
  Returns: `{ success, data: Uint8Array|null, name, size, checksum, isStreaming }`. In streaming mode `data` is `null`, because content has already been served progressively through the media service worker.

- `BadHub.resetSession()`
  Clears the active sender, receiver, and Blossom session state.
  Returns: `{ success }`.

- `BadHub.deriveKeyHex(passphrase)`
  Utility deriving the 256-bit PBKDF2-HMAC-SHA256 hex key for debugging or audit purposes.

### Blossom Encrypted Storage API

- `BadHub.initBlossomEncryptor(fileName, fileSize, checksumHex, passphrase)`
  Initializes a stream encryptor for the Blossom storage container.
  Returns: `{ success, header: Uint8Array }`.

- `BadHub.encryptBlossomChunk(plainChunk)`
  Seals one plaintext `Uint8Array` chunk, preserving constant frame alignment across the stream.
  Returns: `{ success, chunk: Uint8Array }`.

- `BadHub.initBlossomDecryptor(headerBytes, passphrase)`
  Parses and authenticates the container header, yielding file metadata before any payload is processed.
  Returns: `{ success, name, size, checksum, headerConsumed }`.

- `BadHub.decryptBlossomChunk(sealedChunk)`
  Opens one sealed chunk and reports progress.
  Returns: `{ success, chunk: Uint8Array, bytesRead, totalSize }`.

- `BadHub.finalizeBlossomDecryption()`
  Verifies end-to-end container integrity after the last chunk.
  Returns: `{ success }`.

- `BadHub.resetBlossomSession()`
  Releases the active Blossom encryptor or decryptor.
  Returns: `{ success }`.

---

## Automation and CI/CD Pipelines

- **Auto Update Dependencies (`update-deps.yml`)**: Checks every 6 hours for new tags and commits across `badsharing`, `badrlnc`, and `badcrypt`, verifies tests, recompiles WASM, and commits updates automatically.
- **Deploy GitHub Pages (`deploy.yml`)**: Automatically triggers on pushes to `main` as well as after automated dependency updates to keep the live web app synchronized.
- **Semantic Release and Bundling (`release.yml`)**: Automates conventional-commit semantic tagging, builds release archives (`badhub-wasm.tar.gz`), creates GitHub Releases, and warms the Go module proxy cache.

---

## License

BadHub is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
