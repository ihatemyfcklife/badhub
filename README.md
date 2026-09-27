# BadHub: Decentralized WebAssembly P2P File Sharing Engine

BadHub is a 100% serverless, client-side peer-to-peer file sharing web application compiled from Go into WebAssembly. It combines convolutional Sliding-Window Random Linear Network Coding over GF(2) via **badrlnc** with post-quantum ChaCha20-Poly1305 AEAD authenticated encryption via **badcrypt**, orchestrated by the **badsharing** engine.

- **GitHub Repository**: [https://github.com/ihatemyfcklife/badhub](https://github.com/ihatemyfcklife/badhub)
- **Live Web Application**: [https://ihatemyfcklife.github.io/badhub/](https://ihatemyfcklife.github.io/badhub/)

Transfers operate directly between web browsers over WebRTC DataChannels configured in unreliable, unordered mode (`ordered: false`, `maxRetransmits: 0`), effectively creating an encrypted UDP network in the browser sandbox. Lost packets are recovered on-the-fly using incremental Gauss-Jordan elimination without retransmission delays or sequence stalls.

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

### 6. 1-Click Magic Link & QR Code Zero-Knowledge Signaling
- **Ephemeral Rooms**: Ephemeral peer rooms (`bad-xxxxxx`) allow immediate connection without central user registration.
- **RFC 3986 URL Hash Privacy**: Magic links (`#room=...&key=...`) encode the decryption passphrase entirely within the URL hash fragment. Per HTTP specifications, fragments are never transmitted to web servers, CDNs, or GitHub Pages.
- **Pure SVG QR Codes**: Integrated client-side SVG QR code generator permits instant mobile device pairing without third-party APIs.

### 7. IP Masking via TURN Relay Mode (`iceTransportPolicy: 'relay'`)
To ensure total network-level anonymity in addition to content encryption:
- BadHub provides a 1-click **Hide IP Address (TURN Relay Mode)** toggle.
- When active, WebRTC strictly applies `iceTransportPolicy: 'relay'`, blocking the generation of `host` (LAN) and `srflx` (public IP) ICE candidates.
- All encrypted frames transit through a blind TURN relay (preconfigured with the Open Relay Project by Metered on ports 80/443, with support for custom CoTURN instances).
- Magic links automatically pass `&relay=1` so recipients join with IP masking automatically enabled.

### 8. Mobile & Multi-Screen Responsive UI
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
│   ├── index.html            # Responsive cyberpunk interface
│   ├── style.css             # Zero-dependency responsive dark stylesheet
│   ├── app.js                # WebRTC, PeerJS, TURN relay & WASM lifecycle controller
│   ├── wasm_exec.js          # Go 1.24 WebAssembly runtime bridge
│   ├── qrcode.min.js         # Pure client-side SVG QR code generator
│   └── main.wasm             # Optimized WebAssembly binary (3.4 MB)
├── scripts/
│   ├── build.sh              # WebAssembly compilation script
│   └── serve.sh              # Lightweight local HTTP server with WASM MIME types
├── Makefile                  # Build, test, and development automation
├── hub_test.go               # End-to-end integration and resilience test suite
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
# or: GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o web/main.wasm ./cmd/wasm
```

### 2. Start Local Development Server
```bash
make serve
# or: ./scripts/serve.sh 8080
```
Navigate to `http://127.0.0.1:8080` in your web browser.

### 3. Run Test Suite
```bash
make test
# or: go test -v ./...
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

- `BadHub.deriveKeyHex(passphrase)`
  Utility deriving the 256-bit PBKDF2-HMAC-SHA256 hex key for debugging or audit purposes.

---

## Automation & CI/CD Pipelines

- **Auto Update Dependencies (`update-deps.yml`)**: Checks every 6 hours for new tags and commits across `badsharing`, `badrlnc`, and `badcrypt`, verifies tests, recompiles WASM, and commits updates automatically.
- **Deploy GitHub Pages (`deploy.yml`)**: Automatically triggers on pushes to `main` as well as after automated dependency updates to keep the live web app synchronized.
- **Semantic Release & Bundling (`release.yml`)**: Automates conventional-commit semantic tagging, builds release archives (`badhub-wasm.tar.gz`), creates GitHub Releases, and warms the Go module proxy cache.

---

## License

BadHub is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
