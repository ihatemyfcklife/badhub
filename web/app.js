/**
 * BadHub - Decentralized WebAssembly P2P File Sharing Engine
 * Integrates Go WebAssembly, badsharing, badrlnc, and badcrypt.
 */

// Application State
let selectedFile = null;
let selectedFileData = null;
let isTransmitting = false;
let isReceiving = false;
let activeBroadcastChannel = null;
let activePeerConnection = null;
let activeDataChannel = null;

let receivedFileBlob = null;
let receivedFileName = "";

// Direct-to-Disk & P2P Swarm State
let directDiskEnabled = false;
let swarmSeedEnabled = true;
let diskFileHandle = null;
let diskWritableStream = null;
let diskWriteChain = Promise.resolve();
let pendingMetaBytes = null;
let pendingMetaInfo = null;
let currentReceiverMeta = null;
let receiverNostrPrivKey = null;

// Initialize WebAssembly Engine
async function initWasm() {
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");

    if (!WebAssembly.instantiateStreaming) {
        WebAssembly.instantiateStreaming = async (resp, importObject) => {
            const source = await (await resp).arrayBuffer();
            return await WebAssembly.instantiate(source, importObject);
        };
    }

    const go = new Go();

    try {
        const result = await WebAssembly.instantiateStreaming(fetch("main.wasm"), go.importObject);
        go.run(result.instance);

        // Await BadHub global bridge initialization
        let attempts = 0;
        while ((!window.BadHub || !window.BadHub.ready) && attempts < 50) {
            await new Promise(r => setTimeout(r, 50));
            attempts++;
        }

        if (window.BadHub && window.BadHub.ready) {
            statusDot.className = "status-dot ready";
            statusText.innerText = "Engine Ready (WASM v" + window.BadHub.version + ")";
            checkSenderReady();
            checkUrlHash();
        } else {
            throw new Error("BadHub global bridge was not registered");
        }
    } catch (err) {
        statusDot.className = "status-dot error";
        statusText.innerText = "WASM Initialization Failed: " + err.message;
        console.error("WASM Load Error:", err);
    }
}

// Tab Switching
function switchTab(tab) {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

    if (tab === "send") {
        document.getElementById("tabSend").classList.add("active");
        document.getElementById("contentSend").classList.add("active");
    } else if (tab === "recv") {
        document.getElementById("tabRecv").classList.add("active");
        document.getElementById("contentRecv").classList.add("active");
    } else if (tab === "sim") {
        document.getElementById("tabSim").classList.add("active");
        document.getElementById("contentSim").classList.add("active");
    }
}

// Magic Link & Ephemeral Signaling State
let currentRoomId = "";
let senderPeer = null;
let receiverPeer = null;
let activePeerConn = null;

// Slider update helpers
function updateRedundancy(val) {
    document.getElementById("redundancyVal").innerText = val + "%";
}

function updateSimLoss(val) {
    document.getElementById("simLossVal").innerText = val + "%";
}

// Room & Passphrase Generation
function generateRoomId() {
    const chars = "abcdefghjkmnpqrstuvwxyz23456789";
    let code = "bad-";
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function generateRandomPassphrase() {
    const chars = "abcdefghjkmnpqrstuvwxyz23456789";
    let pass = "";
    for (let i = 0; i < 16; i++) {
        pass += chars[Math.floor(Math.random() * chars.length)];
    }
    return pass;
}

function updateMagicLink(roomId) {
    if (!roomId) return;
    const passphrase = document.getElementById("sendPassphrase").value || "badhub-secure-swarm-v1";
    const transport = document.querySelector('input[name="sendTransport"]:checked')?.value || "magic";
    const isRelay = document.getElementById("sendRelayToggle")?.checked || false;
    const baseUrl = window.location.origin + window.location.pathname;

    let magicUrl = `${baseUrl}#room=${encodeURIComponent(roomId)}&key=${encodeURIComponent(passphrase)}`;
    if (transport === "nostr") {
        magicUrl += "&transport=nostr";
    } else if (isRelay) {
        magicUrl += "&relay=1";
    }

    const txt = document.getElementById("txtMagicLink");
    if (txt) txt.value = magicUrl;

    const badge = document.getElementById("sendRoomCodeBadge");
    if (badge) badge.innerText = roomId;

    renderQRCode(magicUrl);
}

function renderQRCode(text) {
    const container = document.getElementById("qrCodeCanvas");
    if (!container || typeof qrcode === "undefined") return;
    try {
        const qr = qrcode(0, "M");
        qr.addData(text);
        qr.make();
        const svg = qr.createSvgTag(5, 4);
        container.innerHTML = svg
            .replaceAll('fill="white"', 'fill="#0a0e17"')
            .replaceAll('fill="black"', 'fill="#00f0ff"');
    } catch (err) {
        console.error("QR Code error:", err);
    }
}

function toggleQRCode() {
    const box = document.getElementById("qrCodeContainer");
    const btn = document.getElementById("btnToggleQR");
    if (!box) return;
    if (box.classList.contains("hidden")) {
        box.classList.remove("hidden");
        if (btn) btn.innerText = "Hide QR Code";
    } else {
        box.classList.add("hidden");
        if (btn) btn.innerText = "Show QR Code";
    }
}

function copyMagicLink() {
    const txt = document.getElementById("txtMagicLink");
    const btn = document.getElementById("btnCopyMagicLink");
    if (!txt || !txt.value) {
        alert("Please select a file first to generate a link.");
        return;
    }
    navigator.clipboard.writeText(txt.value).then(() => {
        if (btn) {
            const originalText = btn.innerText;
            btn.innerText = "Copied!";
            btn.classList.add("btn-success");
            setTimeout(() => {
                btn.innerText = originalText;
                btn.classList.remove("btn-success");
            }, 2000);
        }
    }).catch(() => {
        txt.select();
        document.execCommand("copy");
    });
}

// Transport mode toggles
function switchSendTransport(mode) {
    const magicBox = document.getElementById("sendMagicBox");
    const webrtcBox = document.getElementById("sendWebRTCBox");
    const privacyBox = document.querySelector("#contentSend .privacy-box");

    if (mode === "magic") {
        if (magicBox) magicBox.classList.remove("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (privacyBox) privacyBox.classList.remove("hidden");
        if (activeNostrSenderSub) { activeNostrSenderSub.unsub(); activeNostrSenderSub = null; }
        if (selectedFileData && currentRoomId && !senderPeer) {
            armSenderRoom(currentRoomId);
        }
    } else if (mode === "nostr") {
        if (magicBox) magicBox.classList.remove("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (privacyBox) privacyBox.classList.add("hidden");
        if (senderPeer) { senderPeer.destroy(); senderPeer = null; }
        if (selectedFileData && currentRoomId) {
            armSenderNostrRoom(currentRoomId);
        }
    } else if (mode === "airgap") {
        if (magicBox) magicBox.classList.add("hidden");
        if (webrtcBox) webrtcBox.classList.remove("hidden");
        if (privacyBox) privacyBox.classList.remove("hidden");
        if (senderPeer) { senderPeer.destroy(); senderPeer = null; }
        if (activeNostrSenderSub) { activeNostrSenderSub.unsub(); activeNostrSenderSub = null; }
    } else {
        // broadcast
        if (magicBox) magicBox.classList.add("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (privacyBox) privacyBox.classList.add("hidden");
        if (senderPeer) { senderPeer.destroy(); senderPeer = null; }
        if (activeNostrSenderSub) { activeNostrSenderSub.unsub(); activeNostrSenderSub = null; }
    }
    if (currentRoomId) updateMagicLink(currentRoomId);
}

function switchRecvTransport(mode) {
    const magicBox = document.getElementById("recvMagicBox");
    const webrtcBox = document.getElementById("recvWebRTCBox");
    const manualBar = document.getElementById("recvManualActionBar");
    const privacyBox = document.querySelector("#contentRecv .privacy-box");

    if (mode === "magic") {
        if (magicBox) magicBox.classList.remove("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (manualBar) manualBar.classList.add("hidden");
        if (privacyBox) privacyBox.classList.remove("hidden");
        if (activeNostrReceiverSub) { activeNostrReceiverSub.unsub(); activeNostrReceiverSub = null; }
    } else if (mode === "nostr") {
        if (magicBox) magicBox.classList.remove("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (manualBar) manualBar.classList.add("hidden");
        if (privacyBox) privacyBox.classList.add("hidden");
        if (receiverPeer) { receiverPeer.destroy(); receiverPeer = null; }
    } else if (mode === "airgap") {
        if (magicBox) magicBox.classList.add("hidden");
        if (webrtcBox) webrtcBox.classList.remove("hidden");
        if (manualBar) manualBar.classList.remove("hidden");
        if (privacyBox) privacyBox.classList.remove("hidden");
        if (activeNostrReceiverSub) { activeNostrReceiverSub.unsub(); activeNostrReceiverSub = null; }
    } else {
        // broadcast
        if (magicBox) magicBox.classList.add("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (manualBar) manualBar.classList.remove("hidden");
        if (privacyBox) privacyBox.classList.add("hidden");
        if (activeNostrReceiverSub) { activeNostrReceiverSub.unsub(); activeNostrReceiverSub = null; }
    }
}

// ==========================================
// IP PRIVACY & TURN RELAY CONFIGURATION
// ==========================================

const DEFAULT_STUN_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
];

const OPENRELAY_SERVERS = [
    {
        urls: [
            "turn:openrelay.metered.ca:80",
            "turn:openrelay.metered.ca:443",
            "turn:openrelay.metered.ca:443?transport=tcp",
            "turns:openrelay.metered.ca:443",
            "turns:openrelay.metered.ca:443?transport=tcp"
        ],
        username: "openrelayproject",
        credential: "openrelayproject"
    }
];

function getEffectiveIceConfig(forSender) {
    const prefix = forSender ? "send" : "recv";
    const isRelay = document.getElementById(prefix + "RelayToggle")?.checked || false;

    const customUrl = document.getElementById(prefix + "TurnUrl")?.value.trim();
    const customUser = document.getElementById(prefix + "TurnUser")?.value.trim();
    const customPass = document.getElementById(prefix + "TurnPass")?.value.trim();

    let iceServers = [];

    if (customUrl) {
        const customEntry = { urls: customUrl };
        if (customUser) customEntry.username = customUser;
        if (customPass) customEntry.credential = customPass;
        iceServers.push(customEntry);
    } else if (isRelay) {
        iceServers = [...OPENRELAY_SERVERS];
    } else {
        iceServers = [...DEFAULT_STUN_SERVERS];
    }

    const transportPolicy = isRelay ? "relay" : "all";

    return {
        iceServers: iceServers,
        iceTransportPolicy: transportPolicy
    };
}

function getPeerJsOptions(forSender) {
    const ice = getEffectiveIceConfig(forSender);
    return {
        config: {
            iceServers: ice.iceServers,
            iceTransportPolicy: ice.iceTransportPolicy
        },
        debug: 1
    };
}

function toggleSendRelay(checked) {
    const badge = document.getElementById("sendPrivacyBadge");
    if (badge) {
        if (checked) {
            badge.innerText = "TURN Relay Active (IPs Masked)";
            badge.className = "privacy-badge badge-relay";
        } else {
            badge.innerText = "Direct P2P (IP Visible)";
            badge.className = "privacy-badge badge-direct";
        }
    }

    if (currentRoomId) {
        updateMagicLink(currentRoomId);
        if (selectedFileData && document.querySelector('input[name="sendTransport"]:checked')?.value === "magic") {
            armSenderRoom(currentRoomId);
        }
    }
}

function toggleRecvRelay(checked) {
    const badge = document.getElementById("recvPrivacyBadge");
    if (badge) {
        if (checked) {
            badge.innerText = "TURN Relay Active (IPs Masked)";
            badge.className = "privacy-badge badge-relay";
        } else {
            badge.innerText = "Direct P2P (IP Visible)";
            badge.className = "privacy-badge badge-direct";
        }
    }
}

function toggleDirectDisk(checked) {
    directDiskEnabled = checked;
    const badge = document.getElementById("recvDiskBadge");
    if (!badge) return;
    if (checked) {
        if (typeof window.showSaveFilePicker === "function") {
            badge.innerText = "Streams API Active";
            badge.className = "privacy-badge badge-turn";
        } else {
            badge.innerText = "Not Supported (Memory Mode)";
            badge.className = "privacy-badge badge-direct";
            alert("File System Access API (showSaveFilePicker) is not supported in this browser. Falling back to RAM buffer mode.");
            document.getElementById("recvDirectDiskToggle").checked = false;
            directDiskEnabled = false;
        }
    } else {
        badge.innerText = "RAM Buffer Mode";
        badge.className = "privacy-badge badge-direct";
        const prompt = document.getElementById("recvDiskPrompt");
        if (prompt) prompt.classList.add("hidden");
    }
}

function toggleSwarmSeed(checked) {
    swarmSeedEnabled = checked;
    const badge = document.getElementById("recvSwarmBadge");
    if (!badge) return;
    if (checked) {
        badge.innerText = "Swarm Active";
        badge.className = "privacy-badge badge-turn";
    } else {
        badge.innerText = "Seeding Disabled";
        badge.className = "privacy-badge badge-direct";
    }
}

async function confirmDiskDestination() {
    if (!pendingMetaBytes || !window.BadHub) return;
    try {
        const suggestedName = pendingMetaInfo ? pendingMetaInfo.name : "download.bin";
        diskFileHandle = await window.showSaveFilePicker({ suggestedName });
        diskWritableStream = await diskFileHandle.createWritable();
        diskWriteChain = Promise.resolve();

        const promptBox = document.getElementById("recvDiskPrompt");
        if (promptBox) promptBox.classList.add("hidden");

        const badge = document.getElementById("recvDiskBadge");
        if (badge) {
            badge.innerText = "Streaming to Disk";
            badge.className = "privacy-badge badge-turn";
        }

        const passphrase = document.getElementById("recvPassphrase").value || "badhub-secure-swarm-v1";
        setupReceiver(pendingMetaBytes, passphrase);
    } catch (e) {
        if (e.name !== "AbortError") {
            console.error("showSaveFilePicker error:", e);
        }
    }
}

function onCustomTurnChange(prefix) {
    const isSender = (prefix === "send");
    if (isSender) {
        if (currentRoomId && selectedFileData) {
            armSenderRoom(currentRoomId);
        }
    }
}

// ==========================================
// DECENTRALIZED NOSTR RELAYS CONFIGURATION
// ==========================================

const NOSTR_RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://nostr.mom"
];

let nostrPool = null;
let senderNostrPrivKey = null;
let activeNostrSenderSub = null;
let activeNostrReceiverSub = null;
let activeNostrPacketHandler = null;

function getNostrPool() {
    if (!nostrPool && typeof window.NostrTools !== "undefined") {
        nostrPool = new window.NostrTools.SimplePool();
    }
    return nostrPool;
}

// Automated Nostr Sender Swarm Arming
async function armSenderNostrRoom(roomId) {
    if (typeof window.NostrTools === "undefined") {
        console.warn("NostrTools not loaded");
        return;
    }
    const pool = getNostrPool();
    if (!pool) return;

    if (!senderNostrPrivKey) {
        senderNostrPrivKey = window.NostrTools.generatePrivateKey();
    }

    if (activeNostrSenderSub) {
        activeNostrSenderSub.unsub();
        activeNostrSenderSub = null;
    }

    const statusText = document.getElementById("sendMagicPeerStatusText");
    const statusDot = document.getElementById("sendPeerDot");
    if (statusDot) statusDot.className = "status-dot loading";
    if (statusText) statusText.innerText = `Arming Nostr swarm on room ${roomId}...`;

    try {
        activeNostrSenderSub = pool.sub(NOSTR_RELAYS, [
            {
                kinds: [20001],
                "#d": [roomId],
                "#t": ["badhub-signal"]
            }
        ]);

        if (statusDot) statusDot.className = "status-dot loading";
        if (statusText) statusText.innerText = `Nostr swarm active on room ${roomId}. Waiting for recipient...`;

        const btnStart = document.getElementById("btnStartSend");
        if (btnStart && selectedFileData) btnStart.disabled = false;

        activeNostrSenderSub.on("event", event => {
            if (event.content === "join" && !isTransmitting && selectedFileData) {
                console.log("Recipient joined Nostr room!");
                if (statusDot) statusDot.className = "status-dot ready";
                if (statusText) statusText.innerText = "Recipient connected via Nostr! Streaming encrypted frames...";
                startSending();
            }
        });
    } catch (err) {
        console.error("Failed to arm Nostr sender swarm:", err);
    }
}

// Automated Nostr Receiver Connection
async function connectToNostrRoom(roomId) {
    if (!roomId) {
        roomId = document.getElementById("recvRoomCodeInput").value.trim();
    }
    if (!roomId) {
        alert("Please enter a room code or click a magic link.");
        return;
    }

    if (typeof window.NostrTools === "undefined") {
        alert("Nostr library not loaded. Please check your connection.");
        return;
    }
    const pool = getNostrPool();
    if (!pool) return;

    if (activeNostrReceiverSub) {
        activeNostrReceiverSub.unsub();
        activeNostrReceiverSub = null;
    }

    const statusText = document.getElementById("recvMagicPeerStatusText");
    const statusDot = document.getElementById("recvPeerDot");
    if (statusDot) statusDot.className = "status-dot loading";
    if (statusText) statusText.innerText = `Connecting to Nostr swarm for room ${roomId}...`;

    try {
        // Ephemeral join signal to inform sender
        const joinSk = window.NostrTools.generatePrivateKey();
        const joinEvent = window.NostrTools.finishEvent({
            kind: 20001,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ["d", roomId],
                ["t", "badhub-signal"]
            ],
            content: "join"
        }, joinSk);

        pool.publish(NOSTR_RELAYS, joinEvent);

        // Subscribe to all room frames and metadata
        activeNostrReceiverSub = pool.sub(NOSTR_RELAYS, [
            {
                kinds: [20001],
                "#d": [roomId]
            }
        ]);

        if (statusDot) statusDot.className = "status-dot ready";
        if (statusText) statusText.innerText = `Connected to Nostr swarm for room ${roomId}! Receiving stream...`;

        startReceiving();

        activeNostrReceiverSub.on("event", event => {
            if (!isReceiving || !activeNostrPacketHandler) return;
            const isSignal = event.tags && event.tags.some(t => t[0] === "t" && t[1] === "badhub-signal");
            if (isSignal) return;

            try {
                const binaryStr = atob(event.content);
                const frameBytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    frameBytes[i] = binaryStr.charCodeAt(i);
                }
                activeNostrPacketHandler(frameBytes);
            } catch (err) {
                console.warn("Failed to process incoming Nostr frame:", err);
            }
        });
    } catch (err) {
        console.error("Failed to connect to Nostr swarm:", err);
    }
}

// Automated PeerJS Sender Room Arming
function armSenderRoom(roomId) {
    if (typeof Peer === "undefined") {
        console.warn("PeerJS library not loaded");
        return;
    }
    if (senderPeer) {
        senderPeer.destroy();
        senderPeer = null;
    }

    const statusText = document.getElementById("sendMagicPeerStatusText");
    const statusDot = document.getElementById("sendPeerDot");
    if (statusDot) statusDot.className = "status-dot loading";
    if (statusText) statusText.innerText = `Arming room ${roomId}...`;

    try {
        const peerOptions = getPeerJsOptions(true);
        senderPeer = new Peer(roomId, peerOptions);

        senderPeer.on("open", (id) => {
            if (statusDot) statusDot.className = "status-dot loading";
            if (statusText) statusText.innerText = `Room ${id} active. Waiting for recipient to connect...`;
        });

        senderPeer.on("connection", (conn) => {
            console.log("Recipient connected to sender room!");
            activePeerConn = conn;
            if (statusDot) statusDot.className = "status-dot ready";
            if (statusText) statusText.innerText = "Peer connected! Starting transmission...";

            conn.on("open", () => {
                activeDataChannel = conn.dataChannel;
                activeDataChannel.binaryType = "arraybuffer";
                startSending();
            });

            conn.on("close", () => {
                if (statusDot) statusDot.className = "status-dot loading";
                if (statusText) statusText.innerText = "Peer disconnected. Waiting for next recipient...";
            });
        });

        senderPeer.on("error", (err) => {
            console.warn("Sender PeerJS error:", err);
            if (err.type === "unavailable-id") {
                currentRoomId = generateRoomId();
                updateMagicLink(currentRoomId);
                armSenderRoom(currentRoomId);
            } else {
                if (statusDot) statusDot.className = "status-dot error";
                if (statusText) statusText.innerText = "Signaling error: " + err.type;
            }
        });
    } catch (err) {
        console.error("Failed to arm sender room:", err);
    }
}

// Automated PeerJS Receiver Connection
function connectToRoom(roomId) {
    if (!roomId) {
        roomId = document.getElementById("recvRoomCodeInput").value.trim();
    }
    if (!roomId) {
        alert("Please enter a room code or click a magic link.");
        return;
    }

    const transport = document.querySelector('input[name="recvTransport"]:checked')?.value || "magic";
    if (transport === "nostr") {
        return connectToNostrRoom(roomId);
    }

    if (typeof Peer === "undefined") {
        alert("PeerJS is not loaded. Please check your connection.");
        return;
    }

    if (receiverPeer) {
        receiverPeer.destroy();
        receiverPeer = null;
    }

    const statusText = document.getElementById("recvMagicPeerStatusText");
    const statusDot = document.getElementById("recvPeerDot");
    if (statusDot) statusDot.className = "status-dot loading";
    if (statusText) statusText.innerText = `Connecting to room ${roomId}...`;

    try {
        const peerOptions = getPeerJsOptions(false);
        receiverPeer = new Peer(peerOptions);

        receiverPeer.on("open", () => {
            const conn = receiverPeer.connect(roomId, {
                reliable: false, // UDP mode: unordered, unreliable for RLNC
                serialization: "raw"
            });

            conn.on("open", () => {
                if (statusDot) statusDot.className = "status-dot ready";
                if (statusText) statusText.innerText = `Connected to room ${roomId}! Receiving stream...`;
                activeDataChannel = conn.dataChannel;
                activeDataChannel.binaryType = "arraybuffer";
                startReceiving();
            });

            conn.on("close", () => {
                if (statusDot) statusDot.className = "status-dot";
                if (statusText) statusText.innerText = "Connection closed.";
            });

            conn.on("error", (err) => {
                if (statusDot) statusDot.className = "status-dot error";
                if (statusText) statusText.innerText = "Connection error: " + err.message;
            });
        });

        receiverPeer.on("error", (err) => {
            console.warn("Receiver PeerJS error:", err);
            if (statusDot) statusDot.className = "status-dot error";
            if (statusText) statusText.innerText = "Signaling: " + (err.type === "peer-unavailable" ? "Sender room not found or offline" : err.type);
        });
    } catch (err) {
        console.error("Failed to connect to room:", err);
    }
}

// URL Hash Deep Linking (#room=...&key=...)
function checkUrlHash() {
    const rawHash = window.location.hash.substring(1);
    if (!rawHash) return;

    const params = new URLSearchParams(rawHash);
    const room = params.get("room");
    const key = params.get("key");
    const relay = params.get("relay");
    const transport = params.get("transport");

    if (relay === "1") {
        const recvToggle = document.getElementById("recvRelayToggle");
        if (recvToggle) {
            recvToggle.checked = true;
            toggleRecvRelay(true);
        }
    }

    if (room) {
        switchTab("recv");
        if (transport === "nostr") {
            const nostrRadio = document.querySelector('input[name="recvTransport"][value="nostr"]');
            if (nostrRadio) {
                nostrRadio.checked = true;
                switchRecvTransport("nostr");
            }
        } else {
            const radio = document.querySelector('input[name="recvTransport"][value="magic"]');
            if (radio) {
                radio.checked = true;
                switchRecvTransport("magic");
            }
        }
        const roomInput = document.getElementById("recvRoomCodeInput");
        if (roomInput) roomInput.value = room;
        if (key) {
            const passInput = document.getElementById("recvPassphrase");
            if (passInput) passInput.value = key;
        }

        const tryAutoConnect = () => {
            if (window.BadHub && window.BadHub.ready) {
                connectToRoom(room);
            } else {
                setTimeout(tryAutoConnect, 100);
            }
        };
        tryAutoConnect();
    }
}

// Drag & Drop Setup
const dropzone = document.getElementById("sendDropzone");
const fileInput = document.getElementById("fileInput");

["dragenter", "dragover"].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
        e.preventDefault();
        dropzone.classList.add("dragover");
    }, false);
});

["dragleave", "drop"].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
    }, false);
});

dropzone.addEventListener("drop", e => {
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFileSelect(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener("change", e => {
    if (e.target.files && e.target.files.length > 0) {
        handleFileSelect(e.target.files[0]);
    }
});

function handleFileSelect(file) {
    selectedFile = file;
    document.getElementById("dropTitle").innerText = `Selected: ${file.name} (${formatBytes(file.size)})`;
    document.getElementById("dropSubtitle").innerText = "Reading file into WebAssembly memory...";

    if (!currentRoomId) {
        currentRoomId = generateRoomId();
        document.getElementById("sendPassphrase").value = generateRandomPassphrase();
    }
    updateMagicLink(currentRoomId);

    const transportRadio = document.querySelector('input[name="sendTransport"]:checked');
    if (transportRadio && transportRadio.value === "magic") {
        armSenderRoom(currentRoomId);
    } else if (transportRadio && transportRadio.value === "nostr") {
        armSenderNostrRoom(currentRoomId);
    }

    const reader = new FileReader();
    reader.onload = e => {
        selectedFileData = new Uint8Array(e.target.result);
        document.getElementById("dropSubtitle").innerText = "Ready for transmission. Configure parameters and start.";
        checkSenderReady();
    };
    reader.readAsArrayBuffer(file);
}

function checkSenderReady() {
    const btn = document.getElementById("btnStartSend");
    if (selectedFileData && window.BadHub && window.BadHub.ready && !isTransmitting) {
        btn.disabled = false;
    } else {
        btn.disabled = true;
    }
}

// ==========================================
// P2P SENDER IMPLEMENTATION
// ==========================================

async function startSending() {
    if (!selectedFileData || !window.BadHub) return;

    isTransmitting = true;
    document.getElementById("btnStartSend").disabled = true;
    document.getElementById("btnStopSend").disabled = false;

    const passphrase = document.getElementById("sendPassphrase").value || "badhub-default-secret";
    const redundancy = parseFloat(document.getElementById("sendRedundancy").value) / 100.0;
    const transport = document.querySelector('input[name="sendTransport"]:checked').value;

    const statusEl = document.getElementById("sendMetricStatus");
    const percentEl = document.getElementById("sendMetricPercent");
    const dataEl = document.getElementById("sendMetricData");
    const parityEl = document.getElementById("sendMetricParity");
    const speedEl = document.getElementById("sendMetricSpeed");
    const sessionEl = document.getElementById("sendMetricSession");
    const progressBar = document.getElementById("sendProgressBar");

    statusEl.innerText = "Initializing RLNC Engine...";

    // 1. Initialize Sender in Go WASM
    const res = window.BadHub.initSender(selectedFile.name, selectedFileData, passphrase, redundancy, 64, 64);
    if (!res.success) {
        alert("Failed to initialize sender: " + res.error);
        stopTransmission();
        return;
    }

    sessionEl.innerText = res.sessionID.slice(0, 8) + "...";
    statusEl.innerText = "Connecting Transport...";

    // 2. Setup Transport Output Handler
    let sendWirePacket = null;

    if (transport === "broadcast") {
        if (!activeBroadcastChannel) {
            activeBroadcastChannel = new BroadcastChannel("badhub_p2p_channel");
        }
        sendWirePacket = async (packet) => {
            activeBroadcastChannel.postMessage({ type: "frame", data: packet });
        };
        // Emit encrypted metadata packet 5 times
        for (let i = 0; i < 5; i++) {
            activeBroadcastChannel.postMessage({ type: "meta", data: res.encryptedMetadata });
            await new Promise(r => setTimeout(r, 10));
        }
    } else if (transport === "nostr") {
        const pool = getNostrPool();
        if (!pool) {
            alert("Nostr engine is not loaded. Please check your connection.");
            stopTransmission();
            return;
        }
        if (!senderNostrPrivKey && typeof window.NostrTools !== "undefined") {
            senderNostrPrivKey = window.NostrTools.generatePrivateKey();
        }

        sendWirePacket = async (packet, isMeta = false) => {
            let binary = "";
            const len = packet.byteLength;
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(packet[i]);
            }
            const b64 = btoa(binary);

            const ev = window.NostrTools.finishEvent({
                kind: 20001,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ["d", currentRoomId],
                    ["t", isMeta ? "badhub-meta" : "badhub-frame"]
                ],
                content: b64
            }, senderNostrPrivKey);

            pool.publish(NOSTR_RELAYS, ev);
        };

        // Emit encrypted metadata packet 5 times over Nostr swarm
        for (let i = 0; i < 5; i++) {
            await sendWirePacket(res.encryptedMetadata, true);
            await new Promise(r => setTimeout(r, 25));
        }
    } else {
        // WebRTC DataChannel
        if (!activeDataChannel || activeDataChannel.readyState !== "open") {
            alert("WebRTC DataChannel is not open! Please share your Magic Link / QR Code or connect your peer first.");
            stopTransmission();
            return;
        }
        activeDataChannel.bufferedAmountLowThreshold = 64 * 1024;
        sendWirePacket = async (packet) => {
            if (activeDataChannel.bufferedAmount > 256 * 1024) {
                await new Promise(resolve => {
                    const onLow = () => {
                        activeDataChannel.removeEventListener("bufferedamountlow", onLow);
                        resolve();
                    };
                    activeDataChannel.addEventListener("bufferedamountlow", onLow);
                });
            }
            activeDataChannel.send(packet);
        };
        for (let i = 0; i < 5; i++) {
            await sendWirePacket(res.encryptedMetadata);
            await new Promise(r => setTimeout(r, 10));
        }
    }

    statusEl.innerText = "Streaming Encrypted Shards...";
    const startTime = performance.now();
    let bytesSent = 0;
    let frameCount = 0;

    // 3. Frame Emission Loop
    while (isTransmitting) {
        const frameRes = window.BadHub.nextSenderFrame();
        if (frameRes.error) {
            statusEl.innerText = "Error: " + frameRes.error;
            break;
        }
        if (frameRes.eof) {
            progressBar.style.width = "100%";
            percentEl.innerText = "100.0%";
            statusEl.innerText = "Completed (All chunks + parity emitted)";
            break;
        }

        if (frameRes.frame) {
            await sendWirePacket(frameRes.frame);
            bytesSent += frameRes.frame.length;
            frameCount++;

            if (transport === "nostr") {
                // Yield periodically to allow WebSocket frames to flush across relays
                if (frameCount % 4 === 0) {
                    await new Promise(r => setTimeout(r, 10));
                }
            }

            if (frameCount % 32 === 0) {
                const stats = window.BadHub.getSenderStats();
                dataEl.innerText = stats.dataPackets;
                parityEl.innerText = stats.parityPackets;

                const elapsed = (performance.now() - startTime) / 1000;
                if (elapsed > 0) {
                    const mbps = (bytesSent / (1024 * 1024)) / elapsed;
                    speedEl.innerText = mbps.toFixed(2) + " MB/s";
                }

                statusEl.innerText = `Streaming Encrypted Shards (Gen ${stats.currentGeneration + 1} / ${res.totalGenerations})...`;

                const pct = Math.min(99.0, (stats.dataPackets / res.totalChunks) * 100.0);
                progressBar.style.width = pct.toFixed(1) + "%";
                percentEl.innerText = pct.toFixed(1) + "%";

                // Micro-sleep to yield browser UI thread and prevent socket queue saturation
                await new Promise(r => setTimeout(r, 0));
            }
        }
    }

    document.getElementById("btnStopSend").disabled = true;
    document.getElementById("btnStartSend").disabled = false;
    isTransmitting = false;
    if (window.BadHub && window.BadHub.resetSession) {
        window.BadHub.resetSession();
    }
}

function stopTransmission() {
    isTransmitting = false;
    document.getElementById("btnStopSend").disabled = true;
    document.getElementById("btnStartSend").disabled = false;
    document.getElementById("sendMetricStatus").innerText = "Stopped";
    if (activeNostrSenderSub) {
        activeNostrSenderSub.unsub();
        activeNostrSenderSub = null;
    }
    if (window.BadHub && window.BadHub.resetSession) {
        window.BadHub.resetSession();
    }
}

// ==========================================
// P2P RECEIVER IMPLEMENTATION
// ==========================================

let receiverInitialized = false;

function setupReceiver(bytes, passphrase) {
    const fileEl = document.getElementById("recvMetricFile");
    const statusEl = document.getElementById("recvMetricStatus");

    let initRes;
    if (directDiskEnabled && diskWritableStream) {
        const onChunkDecoded = (chunk) => {
            diskWriteChain = diskWriteChain.then(() => diskWritableStream.write(chunk));
        };
        initRes = window.BadHub.initReceiver(bytes, passphrase, onChunkDecoded);
    } else {
        initRes = window.BadHub.initReceiver(bytes, passphrase);
    }

    if (initRes && initRes.success) {
        receiverInitialized = true;
        currentReceiverMeta = initRes;
        fileEl.innerText = `${initRes.name} (${formatBytes(initRes.size)})`;
        const genEl = document.getElementById("recvMetricGen");
        if (genEl) genEl.innerText = `Gen 1 / ${initRes.totalGenerations}`;
        statusEl.innerText = initRes.isStreaming
            ? "Direct-to-Disk Stream active (0 RAM). Receiving shards..."
            : "Metadata validated. Receiving shards...";
        return true;
    } else {
        statusEl.innerText = "Receiver init failed: " + (initRes ? initRes.error : "unknown error");
        return false;
    }
}

function broadcastRecodedSwarmFrame(transport) {
    if (!window.BadHub || !window.BadHub.recodeReceiverFrame) return;
    const recodeRes = window.BadHub.recodeReceiverFrame();
    if (!recodeRes || !recodeRes.success || !recodeRes.frame) return;

    const frame = recodeRes.frame;
    if (transport === "broadcast" && activeBroadcastChannel) {
        activeBroadcastChannel.postMessage({ type: "frame", data: frame });
    } else if (transport === "nostr") {
        const pool = getNostrPool();
        if (pool && currentRoomId) {
            if (!receiverNostrPrivKey && typeof window.NostrTools !== "undefined") {
                receiverNostrPrivKey = window.NostrTools.generatePrivateKey();
            }
            let binary = "";
            const len = frame.byteLength;
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(frame[i]);
            }
            const b64 = btoa(binary);
            const ev = window.NostrTools.finishEvent({
                kind: 20001,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ["d", currentRoomId],
                    ["t", "badhub-frame"]
                ],
                content: b64
            }, receiverNostrPrivKey);
            pool.publish(NOSTR_RELAYS, ev);
        }
    } else if (transport === "magic" || transport === "airgap") {
        if (activeDataChannel && activeDataChannel.readyState === "open") {
            try {
                if (activeDataChannel.bufferedAmount < 128 * 1024) {
                    activeDataChannel.send(frame);
                }
            } catch (err) {
                // Ignore transient channel errors
            }
        }
    }
}

function startReceiving() {
    if (!window.BadHub) return;

    isReceiving = true;
    receiverInitialized = false;
    pendingMetaBytes = null;
    pendingMetaInfo = null;
    currentReceiverMeta = null;

    document.getElementById("btnStartRecv").disabled = true;
    document.getElementById("btnStopRecv").disabled = false;
    document.getElementById("downloadContainer").classList.add("hidden");
    const promptBox = document.getElementById("recvDiskPrompt");
    if (promptBox) promptBox.classList.add("hidden");

    const passphrase = document.getElementById("recvPassphrase").value || "badhub-default-secret";
    const transport = document.querySelector('input[name="recvTransport"]:checked').value;

    const statusEl = document.getElementById("recvMetricStatus");
    const fileEl = document.getElementById("recvMetricFile");
    const percentEl = document.getElementById("recvMetricPercent");
    const framesEl = document.getElementById("recvMetricFrames");
    const droppedEl = document.getElementById("recvMetricDropped");
    const integrityEl = document.getElementById("recvMetricIntegrity");
    const progressBar = document.getElementById("recvProgressBar");
    const recodedEl = document.getElementById("recvMetricRecoded");
    const genEl = document.getElementById("recvMetricGen");

    statusEl.innerText = "Listening for incoming stream...";
    progressBar.style.width = "0%";
    if (recodedEl) recodedEl.innerText = "0 frames";
    if (genEl) genEl.innerText = "Gen 0 / 1";

    // Incoming wire packet handler
    const onIncomingWirePacket = async (packetData) => {
        if (!isReceiving) return;
        const bytes = new Uint8Array(packetData);

        // Check if metadata packet (< 1380 bytes)
        if (bytes.length < 1380) {
            if (!receiverInitialized) {
                if (directDiskEnabled && typeof window.showSaveFilePicker === "function" && !diskWritableStream) {
                    if (!pendingMetaBytes) {
                        // Inspect metadata
                        const testRes = window.BadHub.initReceiver(bytes, passphrase);
                        if (testRes && testRes.success) {
                            pendingMetaBytes = bytes;
                            pendingMetaInfo = testRes;
                            fileEl.innerText = `${testRes.name} (${formatBytes(testRes.size)})`;
                            if (genEl) genEl.innerText = `Gen 0 / ${testRes.totalGenerations}`;
                            statusEl.innerText = "Direct-to-Disk: Select destination file to start streaming...";

                            const pBox = document.getElementById("recvDiskPrompt");
                            const pText = document.getElementById("recvDiskPromptText");
                            if (pBox && pText) {
                                pText.innerHTML = `Incoming stream: <strong>${testRes.name}</strong> (${formatBytes(testRes.size)}, ${testRes.totalGenerations} generation(s)). Choose save location to begin direct-to-disk streaming:`;
                                pBox.classList.remove("hidden");
                            }
                        }
                    }
                    return;
                }

                setupReceiver(bytes, passphrase);
            }
            return;
        }

        // Regular 1380-byte encrypted frame
        if (receiverInitialized) {
            const ingestRes = window.BadHub.ingestReceiverFrame(bytes);
            if (!ingestRes || ingestRes.error) {
                return;
            }

            // P2P Swarm Recoding: when progress >= 30%, recode and broadcast innovative frame to swarm
            if (swarmSeedEnabled && ingestRes.percent >= 30.0 && !ingestRes.completed) {
                if (ingestRes.framesReceived % 3 === 0) {
                    broadcastRecodedSwarmFrame(transport);
                }
            }

            // Throttle UI updates to prevent mobile DOM thrashing
            if (ingestRes.framesReceived % 8 === 0 || ingestRes.completed) {
                framesEl.innerText = ingestRes.framesReceived;
                droppedEl.innerText = ingestRes.framesDropped;
                if (recodedEl) recodedEl.innerText = ingestRes.framesRecoded + " frames";
                if (genEl && currentReceiverMeta) {
                    genEl.innerText = `Gen ${ingestRes.currentGeneration + 1} / ${currentReceiverMeta.totalGenerations}`;
                }

                progressBar.style.width = ingestRes.percent.toFixed(1) + "%";
                percentEl.innerText = ingestRes.percent.toFixed(1) + "%";
            }

            if (ingestRes.completed) {
                if (diskWritableStream) {
                    statusEl.innerText = "Flushing disk buffer...";
                    try {
                        await diskWriteChain;
                        await diskWritableStream.close();
                        diskWritableStream = null;
                    } catch (err) {
                        console.error("Error closing disk stream:", err);
                    }
                }

                // Finalize and verify bit-exact integrity
                const finalRes = window.BadHub.finalizeReceiver();
                if (finalRes && finalRes.success) {
                    statusEl.innerText = finalRes.isStreaming
                        ? "Transfer Complete & Saved to Disk!"
                        : "Transfer Complete & Verified!";
                    integrityEl.innerText = "100% BIT-EXACT MATCH";
                    integrityEl.className = "metric-value highlight-text";
                    progressBar.style.width = "100%";
                    percentEl.innerText = "100.0%";

                    const downloadBtn = document.getElementById("btnDownload");
                    if (finalRes.isStreaming) {
                        downloadBtn.innerText = "Streamed Directly to Disk (0 RAM)";
                        downloadBtn.disabled = true;
                    } else {
                        receivedFileBlob = new Blob([finalRes.data]);
                        receivedFileName = finalRes.name;
                        downloadBtn.innerText = "Download Reconstructed File";
                        downloadBtn.disabled = false;
                    }

                    document.getElementById("verifiedChecksum").innerText = "SHA-256: " + finalRes.checksum;
                    document.getElementById("downloadContainer").classList.remove("hidden");
                    stopReceiving();
                } else {
                    integrityEl.innerText = "CORRUPTED / FAILED";
                    integrityEl.className = "metric-value color-danger";
                    statusEl.innerText = "Verification failed: " + (finalRes ? finalRes.error : "unknown error");
                }
            }
        }
    };

    if (transport === "broadcast") {
        if (!activeBroadcastChannel) {
            activeBroadcastChannel = new BroadcastChannel("badhub_p2p_channel");
        }
        activeBroadcastChannel.onmessage = (e) => {
            if (e.data && e.data.data) {
                onIncomingWirePacket(e.data.data);
            }
        };
    } else if (transport === "nostr") {
        activeNostrPacketHandler = onIncomingWirePacket;
    } else {
        // WebRTC DataChannel
        if (activeDataChannel) {
            activeDataChannel.onmessage = (e) => {
                onIncomingWirePacket(e.data);
            };
        }
    }
}

function stopReceiving() {
    isReceiving = false;
    document.getElementById("btnStopRecv").disabled = true;
    document.getElementById("btnStartRecv").disabled = false;
    const promptBox = document.getElementById("recvDiskPrompt");
    if (promptBox) promptBox.classList.add("hidden");
    pendingMetaBytes = null;
    pendingMetaInfo = null;

    if (activeNostrReceiverSub) {
        activeNostrReceiverSub.unsub();
        activeNostrReceiverSub = null;
    }
    if (window.BadHub && window.BadHub.resetSession) {
        window.BadHub.resetSession();
    }
}

function triggerDownload() {
    if (!receivedFileBlob) return;
    const url = URL.createObjectURL(receivedFileBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = receivedFileName || "reconstructed-file.bin";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ==========================================
// WEBRTC SIGNALING (SERVERLESS MANUAL SDP)
// ==========================================

async function generateWebRTCOffer() {
    const rtcConfig = getEffectiveIceConfig(true);
    activePeerConnection = new RTCPeerConnection(rtcConfig);
    activeDataChannel = activePeerConnection.createDataChannel("badhub_channel", {
        ordered: false,
        maxRetransmits: 0
    });
    activeDataChannel.binaryType = "arraybuffer";

    activeDataChannel.onopen = () => {
        alert("WebRTC P2P DataChannel connected! You can now start transmission.");
    };

    activePeerConnection.onicecandidate = e => {
        if (!e.candidate) {
            // ICE gathering complete; output compressed SDP token
            const offerStr = JSON.stringify(activePeerConnection.localDescription);
            document.getElementById("txtOffer").value = btoa(offerStr);
        }
    };

    const offer = await activePeerConnection.createOffer();
    await activePeerConnection.setLocalDescription(offer);
}

async function acceptWebRTCAnswer() {
    const rawAnswer = document.getElementById("txtSenderAnswer").value.trim();
    if (!rawAnswer) {
        alert("Please paste the receiver's answer token.");
        return;
    }
    try {
        const answer = JSON.parse(atob(rawAnswer));
        await activePeerConnection.setRemoteDescription(answer);
        alert("Peer answer configured! Connecting DataChannel...");
    } catch (err) {
        alert("Invalid answer token format: " + err.message);
    }
}

async function generateWebRTCAnswer() {
    const rawOffer = document.getElementById("txtRecvOffer").value.trim();
    if (!rawOffer) {
        alert("Please paste the sender's offer token first.");
        return;
    }

    try {
        const offer = JSON.parse(atob(rawOffer));
        const rtcConfig = getEffectiveIceConfig(false);
        activePeerConnection = new RTCPeerConnection(rtcConfig);

        activePeerConnection.ondatachannel = e => {
            activeDataChannel = e.channel;
            activeDataChannel.binaryType = "arraybuffer";
            activeDataChannel.onopen = () => {
                alert("WebRTC P2P DataChannel connected on receiver!");
            };
        };

        activePeerConnection.onicecandidate = e => {
            if (!e.candidate) {
                const answerStr = JSON.stringify(activePeerConnection.localDescription);
                document.getElementById("txtRecvAnswer").value = btoa(answerStr);
            }
        };

        await activePeerConnection.setRemoteDescription(offer);
        const answer = await activePeerConnection.createAnswer();
        await activePeerConnection.setLocalDescription(answer);
    } catch (err) {
        alert("Invalid offer token format: " + err.message);
    }
}

// ==========================================
// ONE-CLICK IN-BROWSER SIMULATOR
// ==========================================

async function runSimulation() {
    if (!window.BadHub) return;

    const btn = document.getElementById("btnRunSim");
    btn.disabled = true;

    const sizeKB = parseInt(document.getElementById("simPayloadSize").value) || 256;
    const lossRate = parseFloat(document.getElementById("simLossRate").value) / 100.0;
    const redundancy = 0.40; // 40% parity redundancy

    const statusEl = document.getElementById("simMetricStatus");
    const dataEl = document.getElementById("simMetricData");
    const parityEl = document.getElementById("simMetricParity");
    const droppedEl = document.getElementById("simMetricDropped");
    const lossPctEl = document.getElementById("simMetricLossPct");
    const verifiedEl = document.getElementById("simMetricVerified");
    const progressBar = document.getElementById("simProgressBar");
    const logBox = document.getElementById("simLog");

    logBox.innerHTML = "";
    const log = (msg, cls = "info") => {
        const div = document.createElement("div");
        div.className = `log-entry ${cls}`;
        div.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logBox.appendChild(div);
        logBox.scrollTop = logBox.scrollHeight;
    };

    log(`Generating synthetic payload: ${sizeKB} KB...`);
    statusEl.innerText = "Generating test payload...";
    progressBar.style.width = "0%";

    // Generate pseudo-random test bytes
    const totalBytes = sizeKB * 1024;
    const syntheticData = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes; i++) {
        syntheticData[i] = (i * 31 + 17) & 0xFF;
    }

    const passphrase = "simulation-secret-passphrase-2026";
    log("Initializing WASM Sender (RLNC Sliding Window: 64, Generation Size: 64, Redundancy: 40%)...");

    const senderRes = window.BadHub.initSender("simulation-test.bin", syntheticData, passphrase, redundancy, 64, 64);
    if (!senderRes.success) {
        log("Sender init failed: " + senderRes.error, "error");
        btn.disabled = false;
        return;
    }
    log(`Sender initialized: ${senderRes.totalChunks} chunks in ${senderRes.totalGenerations} generation(s), SHA-256=${senderRes.checksum.slice(0, 16)}...`);

    log("Initializing WASM Receiver with encrypted metadata...");
    const recvRes = window.BadHub.initReceiver(senderRes.encryptedMetadata, passphrase);
    if (!recvRes.success) {
        log("Receiver init failed: " + recvRes.error, "error");
        btn.disabled = false;
        return;
    }

    log(`Starting packet stream under ${Math.round(lossRate * 100)}% simulated packet loss...`);
    statusEl.innerText = `Streaming with ${Math.round(lossRate * 100)}% loss...`;

    let totalEmitted = 0;
    let totalDropped = 0;
    let framesToFeed = [];

    // Collect frames from sender and apply loss
    while (true) {
        const frameRes = window.BadHub.nextSenderFrame();
        if (frameRes.error) {
            log("Sender error: " + frameRes.error, "error");
            break;
        }
        if (frameRes.eof) break;

        if (frameRes.frame) {
            totalEmitted++;
            if (Math.random() < lossRate) {
                totalDropped++;
                // Packet dropped in transmission
            } else {
                framesToFeed.push(frameRes.frame);
            }
        }
    }

    const stats = window.BadHub.getSenderStats();
    dataEl.innerText = stats.dataPackets;
    parityEl.innerText = stats.parityPackets;
    droppedEl.innerText = totalDropped;
    lossPctEl.innerText = ((totalDropped / totalEmitted) * 100).toFixed(1) + "%";

    log(`Emission complete: ${stats.dataPackets} data, ${stats.parityPackets} parity. ${totalDropped} frames dropped (${lossPctEl.innerText}).`);
    log("Feeding surviving frames to Gauss-Jordan incremental linear solver...");

    let swarmRecodedCount = 0;
    for (let i = 0; i < framesToFeed.length; i++) {
        const ingestRes = window.BadHub.ingestReceiverFrame(framesToFeed[i]);
        const pct = Math.min(100, Math.round(((i + 1) / framesToFeed.length) * 100));
        progressBar.style.width = pct + "%";

        if (pct >= 30 && swarmRecodedCount < 2) {
            swarmRecodedCount++;
            const recodedRes = window.BadHub.recodeReceiverFrame();
            if (recodedRes && recodedRes.success) {
                log(`[P2P Swarm] Generated innovative recoded frame #${swarmRecodedCount} (${recodedRes.frame.length} B) over GF(2) at ${pct}% progress!`, "info");
            }
        }

        if (i % 8 === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }

    log("Finalizing receiver and verifying bit-exact SHA-256 integrity anchor...");
    const finalRes = window.BadHub.finalizeReceiver();

    if (finalRes && finalRes.success) {
        statusEl.innerText = "Completed: 100% Bit-Exact Match!";
        verifiedEl.innerText = "SHA-256 VERIFIED";
        verifiedEl.className = "metric-value highlight-text";
        progressBar.style.width = "100%";
        log(`RECOVERY SUCCESS: All ${sizeKB} KB reconstructed! SHA-256=${finalRes.checksum}`, "success");
    } else {
        statusEl.innerText = "Failed";
        verifiedEl.innerText = "FAILED";
        verifiedEl.className = "metric-value color-danger";
        log("RECOVERY FAILED: " + (finalRes ? finalRes.error : "unknown error"), "error");
    }

    if (window.BadHub && window.BadHub.resetSession) {
        window.BadHub.resetSession();
    }

    btn.disabled = false;
}

// Utility: Format bytes
function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

// Bootstrap on window load
window.addEventListener("DOMContentLoaded", () => {
    initWasm();
    window.addEventListener("hashchange", checkUrlHash);
    const passInput = document.getElementById("sendPassphrase");
    if (passInput) {
        passInput.addEventListener("input", () => {
            if (currentRoomId) updateMagicLink(currentRoomId);
        });
    }

    // Check FileSystem Access API support for direct-to-disk streaming
    const diskToggle = document.getElementById("recvDirectDiskToggle");
    const diskBadge = document.getElementById("recvDiskBadge");
    if (typeof window.showSaveFilePicker !== "function") {
        if (diskToggle) {
            diskToggle.checked = false;
            diskToggle.disabled = true;
        }
        if (diskBadge) {
            diskBadge.innerText = "Not Supported (Memory Mode)";
            diskBadge.title = "Browser lacks File System Access API support";
        }
    }
});
