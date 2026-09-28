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
let isOpfsMode = false;
let opfsFileHandle = null;
let wakeLock = null;
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
        const result = await WebAssembly.instantiateStreaming(fetch("main.wasm?v=1.8.2"), go.importObject);
        go.run(result.instance);

        // Await BadHub global bridge initialization
        let attempts = 0;
        while ((!window.BadHub || !window.BadHub.ready) && attempts < 50) {
            await new Promise(r => setTimeout(r, 50));
            attempts++;
        }

        if (window.BadHub && window.BadHub.ready) {
            statusDot.className = "status-dot ready";
            const ver = window.BadHub.version ? (window.BadHub.version.startsWith("v") ? window.BadHub.version : "v" + window.BadHub.version) : "v1.8.2";
            statusText.innerText = "Engine Ready (" + ver + ")";
            checkSenderReady();
            checkUrlHash();
            fetchGitHubBadHubVersion();
        } else {
            throw new Error("BadHub global bridge was not registered");
        }
    } catch (err) {
        statusDot.className = "status-dot error";
        statusText.innerText = "WASM Initialization Failed: " + err.message;
        console.error("WASM Load Error:", err);
    }
}

async function fetchGitHubBadHubVersion() {
    try {
        // 1. Check static version.json first (instant, unaffected by GitHub API rate limits)
        try {
            const localResp = await fetch("version.json?v=1.8.2");
            if (localResp.ok) {
                const localData = await localResp.json();
                if (localData && localData.version) {
                    const statusText = document.getElementById("statusText");
                    if (statusText && statusText.innerText.startsWith("Engine Ready")) {
                        statusText.innerText = `Engine Ready (${localData.version})`;
                    }
                }
            }
        } catch (_) {}

        // 2. Query GitHub releases for live upstream repository version
        const resp = await fetch("https://api.github.com/repos/ihatemyfcklife/badhub/releases/latest");
        if (resp.ok) {
            const data = await resp.json();
            if (data && data.tag_name) {
                const statusText = document.getElementById("statusText");
                if (statusText && statusText.innerText.startsWith("Engine Ready")) {
                    statusText.innerText = `Engine Ready (${data.tag_name})`;
                }
            }
        }
    } catch (e) {
        // Fallback to embedded version already in place
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
    } else if (tab === "media") {
        document.getElementById("tabMedia").classList.add("active");
        document.getElementById("contentMedia").classList.add("active");
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

let activeBlossomXhr = null;
let activeBlossomAbortController = null;

// Transport mode toggles
function switchSendTransport(mode) {
    const magicBox = document.getElementById("sendMagicBox");
    const webrtcBox = document.getElementById("sendWebRTCBox");
    const blossomBox = document.getElementById("sendBlossomBox");
    const privacyBox = document.querySelector("#contentSend .privacy-box");
    const sendBtn = document.getElementById("btnStartSend");

    if (mode === "magic") {
        if (magicBox) magicBox.classList.remove("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (blossomBox) blossomBox.classList.add("hidden");
        if (privacyBox) privacyBox.classList.remove("hidden");
        if (sendBtn) sendBtn.innerText = "Start P2P Transmission";
        if (activeNostrSenderSub) { activeNostrSenderSub.unsub(); activeNostrSenderSub = null; }
        if (selectedFile && currentRoomId && !senderPeer) {
            armSenderRoom(currentRoomId);
        }
    } else if (mode === "blossom") {
        if (magicBox) magicBox.classList.add("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (blossomBox) blossomBox.classList.remove("hidden");
        if (privacyBox) privacyBox.classList.add("hidden");
        if (sendBtn) sendBtn.innerText = "Upload Encrypted Blob to Blossom (Offline Ready)";
        if (senderPeer) { senderPeer.destroy(); senderPeer = null; }
        if (activeNostrSenderSub) { activeNostrSenderSub.unsub(); activeNostrSenderSub = null; }
    } else if (mode === "nostr") {
        if (magicBox) magicBox.classList.remove("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (blossomBox) blossomBox.classList.add("hidden");
        if (privacyBox) privacyBox.classList.add("hidden");
        if (sendBtn) sendBtn.innerText = "Start P2P Transmission";
        if (senderPeer) { senderPeer.destroy(); senderPeer = null; }
        if (selectedFile && currentRoomId) {
            armSenderNostrRoom(currentRoomId);
        }
    } else if (mode === "airgap") {
        if (magicBox) magicBox.classList.add("hidden");
        if (webrtcBox) webrtcBox.classList.remove("hidden");
        if (blossomBox) blossomBox.classList.add("hidden");
        if (privacyBox) privacyBox.classList.remove("hidden");
        if (sendBtn) sendBtn.innerText = "Start P2P Transmission";
        if (senderPeer) { senderPeer.destroy(); senderPeer = null; }
        if (activeNostrSenderSub) { activeNostrSenderSub.unsub(); activeNostrSenderSub = null; }
    } else {
        // broadcast
        if (magicBox) magicBox.classList.add("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (blossomBox) blossomBox.classList.add("hidden");
        if (privacyBox) privacyBox.classList.add("hidden");
        if (sendBtn) sendBtn.innerText = "Start P2P Transmission";
        if (senderPeer) { senderPeer.destroy(); senderPeer = null; }
        if (activeNostrSenderSub) { activeNostrSenderSub.unsub(); activeNostrSenderSub = null; }
    }
    if (currentRoomId) updateMagicLink(currentRoomId);
    checkSenderReady();
}

function switchRecvTransport(mode) {
    const magicBox = document.getElementById("recvMagicBox");
    const webrtcBox = document.getElementById("recvWebRTCBox");
    const blossomBox = document.getElementById("recvBlossomBox");
    const manualBar = document.getElementById("recvManualActionBar");
    const privacyBox = document.querySelector("#contentRecv .privacy-box");

    if (mode === "magic") {
        if (magicBox) magicBox.classList.remove("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (blossomBox) blossomBox.classList.add("hidden");
        if (manualBar) manualBar.classList.add("hidden");
        if (privacyBox) privacyBox.classList.remove("hidden");
        if (activeNostrReceiverSub) { activeNostrReceiverSub.unsub(); activeNostrReceiverSub = null; }
    } else if (mode === "blossom") {
        if (magicBox) magicBox.classList.add("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (blossomBox) blossomBox.classList.remove("hidden");
        if (manualBar) manualBar.classList.add("hidden");
        if (privacyBox) privacyBox.classList.remove("hidden");
        if (receiverPeer) { receiverPeer.destroy(); receiverPeer = null; }
        if (activeNostrReceiverSub) { activeNostrReceiverSub.unsub(); activeNostrReceiverSub = null; }
    } else if (mode === "nostr") {
        if (magicBox) magicBox.classList.remove("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (blossomBox) blossomBox.classList.add("hidden");
        if (manualBar) manualBar.classList.add("hidden");
        if (privacyBox) privacyBox.classList.add("hidden");
        if (receiverPeer) { receiverPeer.destroy(); receiverPeer = null; }
    } else if (mode === "airgap") {
        if (magicBox) magicBox.classList.add("hidden");
        if (webrtcBox) webrtcBox.classList.remove("hidden");
        if (blossomBox) blossomBox.classList.add("hidden");
        if (manualBar) manualBar.classList.remove("hidden");
        if (privacyBox) privacyBox.classList.remove("hidden");
        if (activeNostrReceiverSub) { activeNostrReceiverSub.unsub(); activeNostrReceiverSub = null; }
    } else {
        // broadcast
        if (magicBox) magicBox.classList.add("hidden");
        if (webrtcBox) webrtcBox.classList.add("hidden");
        if (blossomBox) blossomBox.classList.add("hidden");
        if (manualBar) manualBar.classList.remove("hidden");
        if (privacyBox) privacyBox.classList.add("hidden");
        if (activeNostrReceiverSub) { activeNostrReceiverSub.unsub(); activeNostrReceiverSub = null; }
    }
}

function onBlossomServerChange(val) {
    const customGroup = document.getElementById("customBlossomServerGroup");
    if (customGroup) {
        if (val === "custom") {
            customGroup.classList.remove("hidden");
        } else {
            customGroup.classList.add("hidden");
        }
    }
}

function copyBlossomLink() {
    const txt = document.getElementById("txtBlossomLink");
    if (!txt || !txt.value) return;
    navigator.clipboard.writeText(txt.value).then(() => {
        const btn = document.getElementById("btnCopyBlossomLink");
        if (btn) {
            const orig = btn.innerText;
            btn.innerText = "Copied!";
            setTimeout(() => { btn.innerText = orig; }, 2000);
        }
    }).catch(() => {
        txt.select();
        document.execCommand("copy");
    });
}

// ==========================================
// SCREEN WAKE LOCK API (MOBILE KEEP-AWAKE)
// ==========================================

async function acquireWakeLock() {
    if ("wakeLock" in navigator) {
        try {
            if (!wakeLock) {
                wakeLock = await navigator.wakeLock.request("screen");
                wakeLock.addEventListener("release", () => {
                    wakeLock = null;
                    const badge = document.getElementById("wakeLockBadge");
                    if (badge) badge.style.display = "none";
                });
                const badge = document.getElementById("wakeLockBadge");
                if (badge) badge.style.display = "inline-block";
            }
        } catch (err) {
            console.warn("WakeLock request error:", err);
        }
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
    const badge = document.getElementById("wakeLockBadge");
    if (badge) badge.style.display = "none";
}

document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && (isTransmitting || isReceiving)) {
        await acquireWakeLock();
    }
});

// ==========================================
// IP PRIVACY & TURN RELAY CONFIGURATION
// ==========================================

const DEFAULT_STUN_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.services.mozilla.com:3478" }
];

const OPENRELAY_SERVERS = [
    {
        urls: [
            "turn:openrelay.metered.ca:80",
            "turn:openrelay.metered.ca:443",
            "turn:openrelay.metered.ca:443?transport=tcp",
            "turns:openrelay.metered.ca:443",
            "turns:openrelay.metered.ca:443?transport=tcp",
            "turn:openrelay.metered.ca:5349",
            "turns:openrelay.metered.ca:5349"
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
        if (selectedFile && document.querySelector('input[name="sendTransport"]:checked')?.value === "magic") {
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
    const hasSavePicker = typeof window.showSaveFilePicker === "function";
    const hasOPFS = typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function";

    if (checked) {
        if (hasSavePicker) {
            badge.innerText = "Streams API (Direct Disk)";
            badge.className = "privacy-badge badge-turn";
        } else if (hasOPFS) {
            badge.innerText = "OPFS Disk Stream (Safari/Firefox)";
            badge.className = "privacy-badge badge-turn";
        } else {
            badge.innerText = "Not Supported (Memory Mode)";
            badge.className = "privacy-badge badge-direct";
            alert("Disk streaming APIs (FileSystem Access / OPFS) are not supported in this browser. Falling back to RAM buffer mode.");
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
        isOpfsMode = false;

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
    const url = document.getElementById(prefix + "TurnUrl")?.value.trim() || "";
    const user = document.getElementById(prefix + "TurnUser")?.value.trim() || "";
    const pass = document.getElementById(prefix + "TurnPass")?.value.trim() || "";

    const otherPrefix = isSender ? "recv" : "send";
    const otherUrl = document.getElementById(otherPrefix + "TurnUrl");
    const otherUser = document.getElementById(otherPrefix + "TurnUser");
    const otherPass = document.getElementById(otherPrefix + "TurnPass");
    if (otherUrl && !otherUrl.value) otherUrl.value = url;
    if (otherUser && !otherUser.value) otherUser.value = user;
    if (otherPass && !otherPass.value) otherPass.value = pass;

    try {
        localStorage.setItem("badhub_turn_config", JSON.stringify({ url, user, pass }));
    } catch (e) {}

    if (isSender && currentRoomId && selectedFile) {
        armSenderRoom(currentRoomId);
    }
}

function restoreSavedTurnConfig() {
    try {
        const saved = localStorage.getItem("badhub_turn_config");
        if (saved) {
            const cfg = JSON.parse(saved);
            ["send", "recv"].forEach(p => {
                const urlEl = document.getElementById(p + "TurnUrl");
                const userEl = document.getElementById(p + "TurnUser");
                const passEl = document.getElementById(p + "TurnPass");
                if (urlEl && cfg.url) urlEl.value = cfg.url;
                if (userEl && cfg.user) userEl.value = cfg.user;
                if (passEl && cfg.pass) passEl.value = cfg.pass;
            });
        }
    } catch (e) {}
}

// ==========================================
// DECENTRALIZED NOSTR RELAYS CONFIGURATION
// ==========================================

const NOSTR_RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://nostr.mom",
    "wss://relay.nostr.band",
    "wss://relay.snort.social"
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

    const blossomBlob = params.get("blossom");
    if (blossomBlob) {
        switchTab("recv");
        const blossomRadio = document.querySelector('input[name="recvTransport"][value="blossom"]');
        if (blossomRadio) {
            blossomRadio.checked = true;
            switchRecvTransport("blossom");
        }
        const blossomInput = document.getElementById("recvBlossomInput");
        const server = params.get("server") || "https://nostr.download";
        const fullUrl = blossomBlob.startsWith("http") ? blossomBlob : `${server.replace(/\/+$/, "")}/${blossomBlob}`;
        if (blossomInput) blossomInput.value = fullUrl;
        if (key) {
            const passInput = document.getElementById("recvPassphrase");
            if (passInput) passInput.value = key;
        }
        const statusEl = document.getElementById("recvMetricStatus");
        if (statusEl) statusEl.innerText = "Blossom Blob detected. Ready to download (Sender offline).";
    }

    const streamParam = params.get("stream");
    if (streamParam) {
        switchTab("media");
        switchMediaMode("watch");
        const streamInput = document.getElementById("mediaStreamInput");
        if (streamInput) {
            streamInput.value = window.location.hash;
        }
        if (key) {
            const passInput = document.getElementById("mediaWatchPassphrase");
            if (passInput) passInput.value = key;
        }
        const tryAutoStream = () => {
            if (window.BadHub && window.BadHub.ready) {
                startStreamingPlayback(window.location.hash);
            } else {
                setTimeout(tryAutoStream, 150);
            }
        };
        tryAutoStream();
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
    selectedFileData = null; // Do NOT buffer full file in RAM!
    document.getElementById("dropTitle").innerText = `Selected: ${file.name} (${formatBytes(file.size)})`;
    document.getElementById("dropSubtitle").innerText = "Ready for transmission (0 RAM on-demand streaming). Configure parameters and start.";

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

    checkSenderReady();
}

function checkSenderReady() {
    const btn = document.getElementById("btnStartSend");
    if (selectedFile && window.BadHub && window.BadHub.ready && !isTransmitting) {
        btn.disabled = false;
    } else {
        btn.disabled = true;
    }
}

async function uploadToBlossom(passphrase) {
    const statusEl = document.getElementById("sendMetricStatus");
    const percentEl = document.getElementById("sendMetricPercent");
    const speedEl = document.getElementById("sendMetricSpeed");
    const progressBar = document.getElementById("sendProgressBar");
    const dataEl = document.getElementById("sendMetricData");
    const parityEl = document.getElementById("sendMetricParity");
    const sessionEl = document.getElementById("sendMetricSession");

    let serverUrl = document.getElementById("sendBlossomServer")?.value;
    if (serverUrl === "custom") {
        serverUrl = document.getElementById("txtCustomBlossomServer")?.value.trim();
    }
    if (!serverUrl) serverUrl = "https://nostr.download";
    serverUrl = serverUrl.replace(/\/+$/, "");

    statusEl.innerText = "Computing SHA-256 integrity anchor...";
    progressBar.style.width = "0%";
    percentEl.innerText = "0.0%";

    // 1. Compute SHA-256 of original file in 2 MB slices
    const hasherId = window.BadHub.createSha256();
    const hashChunkSize = 2 * 1024 * 1024;
    for (let offset = 0; offset < selectedFile.size; offset += hashChunkSize) {
        if (!isTransmitting) {
            releaseWakeLock();
            return;
        }
        const end = Math.min(selectedFile.size, offset + hashChunkSize);
        const slice = await selectedFile.slice(offset, end).arrayBuffer();
        window.BadHub.updateSha256(hasherId, new Uint8Array(slice));
        const hashPct = Math.round((end / selectedFile.size) * 100);
        progressBar.style.width = (hashPct * 0.1) + "%";
        percentEl.innerText = (hashPct * 0.1).toFixed(1) + "%";
        statusEl.innerText = `Computing SHA-256 integrity anchor (${hashPct}%)...`;
        if (offset % (4 * hashChunkSize) === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }
    const checksumHex = window.BadHub.finalizeSha256(hasherId);
    if (!checksumHex || !isTransmitting) {
        releaseWakeLock();
        return;
    }

    statusEl.innerText = "Encrypting file with ChaCha20-Poly1305...";

    // 2. Initialize Blossom Encryptor in WASM
    const initRes = window.BadHub.initBlossomEncryptor(selectedFile.name, selectedFile.size, checksumHex, passphrase);
    if (!initRes || !initRes.success) {
        alert("Failed to initialize Blossom encryptor: " + (initRes ? initRes.error : "unknown error"));
        stopTransmission();
        return;
    }

    const encryptedParts = [initRes.header];
    const streamSliceSize = 1024 * 1024; // 1 MB slices
    let encryptedBytes = 0;

    for (let offset = 0; offset < selectedFile.size; offset += streamSliceSize) {
        if (!isTransmitting) {
            releaseWakeLock();
            if (window.BadHub.resetBlossomSession) window.BadHub.resetBlossomSession();
            return;
        }
        const end = Math.min(selectedFile.size, offset + streamSliceSize);
        const slice = await selectedFile.slice(offset, end).arrayBuffer();
        const encChunkRes = window.BadHub.encryptBlossomChunk(new Uint8Array(slice));
        if (!encChunkRes || !encChunkRes.success) {
            alert("Chunk encryption failed: " + (encChunkRes ? encChunkRes.error : "unknown error"));
            stopTransmission();
            return;
        }
        encryptedParts.push(encChunkRes.chunk);
        encryptedBytes += encChunkRes.chunk.length;

        const encPct = Math.round((end / selectedFile.size) * 100);
        progressBar.style.width = (10 + encPct * 0.3) + "%";
        percentEl.innerText = (10 + encPct * 0.3).toFixed(1) + "%";
        statusEl.innerText = `Encrypting with ChaCha20-Poly1305 (${encPct}%)...`;
        if (offset % (4 * streamSliceSize) === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }

    const encryptedBlob = new Blob(encryptedParts, { type: "application/octet-stream" });

    // 3. Compute SHA-256 of encrypted blob (Blossom blob ID)
    statusEl.innerText = "Computing Blossom content address...";
    const blobHasherId = window.BadHub.createSha256();
    for (let offset = 0; offset < encryptedBlob.size; offset += hashChunkSize) {
        if (!isTransmitting) {
            releaseWakeLock();
            return;
        }
        const end = Math.min(encryptedBlob.size, offset + hashChunkSize);
        const slice = await encryptedBlob.slice(offset, end).arrayBuffer();
        window.BadHub.updateSha256(blobHasherId, new Uint8Array(slice));
    }
    const blobSha256 = window.BadHub.finalizeSha256(blobHasherId);
    if (!blobSha256 || !isTransmitting) {
        releaseWakeLock();
        return;
    }

    if (sessionEl) sessionEl.innerText = blobSha256.substring(0, 16) + "...";
    if (dataEl) dataEl.innerText = formatBytes(encryptedBlob.size);
    if (parityEl) parityEl.innerText = "AEAD Tagged";

    // 4. Construct Blossom upload authorization event (kind 24242)
    if (!senderNostrPrivKey && typeof window.NostrTools !== "undefined") {
        senderNostrPrivKey = window.NostrTools.generatePrivateKey();
    }
    const now = Math.floor(Date.now() / 1000);
    const authEvent = window.NostrTools.finishEvent({
        kind: 24242,
        created_at: now,
        tags: [
            ["t", "upload"],
            ["x", blobSha256],
            ["expiration", (now + 1800).toString()]
        ],
        content: `BadHub encrypted upload: ${selectedFile.name}`
    }, senderNostrPrivKey);
    const authHeader = "Nostr " + btoa(unescape(encodeURIComponent(JSON.stringify(authEvent))));

    // 5. Upload to Blossom server via XMLHttpRequest for granular progress
    statusEl.innerText = `Uploading encrypted blob to ${serverUrl}...`;
    const startTime = performance.now();

    await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeBlossomXhr = xhr;
        xhr.open("PUT", `${serverUrl}/upload`);
        xhr.setRequestHeader("Authorization", authHeader);
        xhr.setRequestHeader("X-SHA-256", blobSha256);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && isTransmitting) {
                const upPct = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = (40 + upPct * 0.6) + "%";
                percentEl.innerText = (40 + upPct * 0.6).toFixed(1) + "%";
                statusEl.innerText = `Uploading to Blossom (${upPct}%)...`;
                const elapsedSec = (performance.now() - startTime) / 1000;
                if (elapsedSec > 0 && speedEl) {
                    const mbps = (e.loaded / 1048576) / elapsedSec;
                    speedEl.innerText = `${mbps.toFixed(2)} MB/s`;
                }
            }
        };

        xhr.onload = () => {
            activeBlossomXhr = null;
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.responseText);
            } else {
                reject(new Error(`Server returned HTTP ${xhr.status}: ${xhr.responseText || xhr.statusText}`));
            }
        };

        xhr.onerror = () => {
            activeBlossomXhr = null;
            reject(new Error("Network connection error to Blossom server"));
        };

        xhr.onabort = () => {
            activeBlossomXhr = null;
            reject(new Error("Upload aborted"));
        };

        xhr.send(encryptedBlob);
    }).then(() => {
        progressBar.style.width = "100%";
        percentEl.innerText = "100.0%";
        statusEl.innerText = "Upload Complete & Stored on Blossom! Sender can safely close this page.";
        statusEl.className = "metric-value highlight-text";

        // Generate Blossom Link
        const blossomLink = `${window.location.origin}${window.location.pathname}#blossom=${blobSha256}&server=${encodeURIComponent(serverUrl)}&key=${encodeURIComponent(passphrase)}`;

        const shareBox = document.getElementById("sendBlossomShareBox");
        const linkInput = document.getElementById("txtBlossomLink");
        if (shareBox) shareBox.style.display = "block";
        if (linkInput) linkInput.value = blossomLink;

        // Render QR Code for Blossom link
        const qrCanvas = document.getElementById("qrCodeCanvas");
        const qrContainer = document.getElementById("qrCodeContainer");
        if (qrCanvas && typeof window.QRCode !== "undefined") {
            qrCanvas.innerHTML = "";
            new window.QRCode(qrCanvas, {
                text: blossomLink,
                width: 180,
                height: 180,
                colorDark: "#10b981",
                colorLight: "#0f172a",
                correctLevel: window.QRCode.CorrectLevel.M
            });
            if (qrContainer) qrContainer.classList.remove("hidden");
        }

        document.getElementById("btnStopSend").disabled = true;
        document.getElementById("btnStartSend").disabled = false;
        isTransmitting = false;
        releaseWakeLock();
        if (window.BadHub.resetBlossomSession) window.BadHub.resetBlossomSession();
    }).catch((err) => {
        if (isTransmitting) {
            statusEl.innerText = "Error: " + err.message;
            statusEl.className = "metric-value color-danger";
            alert("Blossom Upload Failed: " + err.message);
            stopTransmission();
        }
    });
}

// ==========================================
// P2P SENDER IMPLEMENTATION
// ==========================================

async function startSending() {
    if (!selectedFile || !window.BadHub) return;

    isTransmitting = true;
    document.getElementById("btnStartSend").disabled = true;
    document.getElementById("btnStopSend").disabled = false;

    await acquireWakeLock();

    const passphrase = document.getElementById("sendPassphrase").value || "badhub-default-secret";
    const redundancy = parseFloat(document.getElementById("sendRedundancy").value) / 100.0;
    const transport = document.querySelector('input[name="sendTransport"]:checked').value;

    if (transport === "blossom") {
        await uploadToBlossom(passphrase);
        return;
    }

    const statusEl = document.getElementById("sendMetricStatus");
    const percentEl = document.getElementById("sendMetricPercent");
    const dataEl = document.getElementById("sendMetricData");
    const parityEl = document.getElementById("sendMetricParity");
    const speedEl = document.getElementById("sendMetricSpeed");
    const sessionEl = document.getElementById("sendMetricSession");
    const progressBar = document.getElementById("sendProgressBar");

    statusEl.innerText = "Computing SHA-256 integrity anchor...";
    progressBar.style.width = "0%";
    percentEl.innerText = "0.0%";

    // Compute SHA-256 in small 2 MB slices with live progress
    const hasherId = window.BadHub.createSha256();
    const hashChunkSize = 2 * 1024 * 1024;
    for (let offset = 0; offset < selectedFile.size; offset += hashChunkSize) {
        if (!isTransmitting) {
            releaseWakeLock();
            return;
        }
        const end = Math.min(selectedFile.size, offset + hashChunkSize);
        const slice = await selectedFile.slice(offset, end).arrayBuffer();
        window.BadHub.updateSha256(hasherId, new Uint8Array(slice));
        const hashPct = Math.round((end / selectedFile.size) * 100);
        progressBar.style.width = (hashPct * 0.05) + "%";
        statusEl.innerText = `Computing SHA-256 integrity anchor (${hashPct}%)...`;
        if (offset % (8 * hashChunkSize) === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }
    const checksumHex = window.BadHub.finalizeSha256(hasherId);
    if (!checksumHex || !isTransmitting) {
        releaseWakeLock();
        return;
    }

    statusEl.innerText = "Initializing RLNC Streaming Engine...";

    // 1. Initialize Streaming Sender in Go WASM (0 RAM overhead)
    const res = window.BadHub.initStreamingSender(selectedFile.name, selectedFile.size, checksumHex, passphrase, redundancy, 64, 64);
    if (!res || !res.success) {
        alert("Failed to initialize sender: " + (res ? res.error : "unknown error"));
        releaseWakeLock();
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
    let fileReadOffset = 0;
    const streamSliceSize = 64 * 1024; // 64 KB streaming buffer

    // 3. Frame Emission Loop
    while (isTransmitting) {
        // Feed chunks into WASM pipe if buffer level is low
        while (isTransmitting && window.BadHub.getSenderBufferLevel() < streamSliceSize * 2 && fileReadOffset < selectedFile.size) {
            const end = Math.min(selectedFile.size, fileReadOffset + streamSliceSize);
            const sliceBuf = await selectedFile.slice(fileReadOffset, end).arrayBuffer();
            window.BadHub.feedSenderChunk(new Uint8Array(sliceBuf));
            fileReadOffset = end;
        }

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
    releaseWakeLock();
    if (window.BadHub && window.BadHub.resetSession) {
        window.BadHub.resetSession();
    }
}

function stopTransmission() {
    isTransmitting = false;
    releaseWakeLock();
    if (activeBlossomXhr) {
        activeBlossomXhr.abort();
        activeBlossomXhr = null;
    }
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
    if (window.BadHub && window.BadHub.resetBlossomSession) {
        window.BadHub.resetBlossomSession();
    }
}

// ==========================================
// P2P RECEIVER IMPLEMENTATION
// ==========================================

let receiverInitialized = false;

async function setupReceiver(bytes, passphrase) {
    const fileEl = document.getElementById("recvMetricFile");
    const statusEl = document.getElementById("recvMetricStatus");

    let initRes;
    if (directDiskEnabled) {
        const hasSavePicker = typeof window.showSaveFilePicker === "function";
        const hasOPFS = typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function";

        if (!diskWritableStream && !hasSavePicker && hasOPFS) {
            try {
                const testMeta = window.BadHub.initReceiver(bytes, passphrase);
                if (testMeta && testMeta.success) {
                    const root = await navigator.storage.getDirectory();
                    const safeName = testMeta.name.replace(/[/\\?%*:|"<>]/g, '_');
                    opfsFileHandle = await root.getFileHandle(safeName, { create: true });
                    diskWritableStream = await opfsFileHandle.createWritable();
                    diskWriteChain = Promise.resolve();
                    isOpfsMode = true;
                }
            } catch (err) {
                console.warn("OPFS stream init failed, falling back to memory:", err);
            }
        }

        if (diskWritableStream) {
            const onChunkDecoded = (chunk) => {
                diskWriteChain = diskWriteChain.then(() => diskWritableStream.write(chunk));
            };
            initRes = window.BadHub.initReceiver(bytes, passphrase, onChunkDecoded);
        } else {
            initRes = window.BadHub.initReceiver(bytes, passphrase);
        }
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
            ? (isOpfsMode ? "OPFS Disk Stream active (Safari/Firefox). Receiving shards..." : "Direct-to-Disk Stream active (0 RAM). Receiving shards...")
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
    isOpfsMode = false;
    opfsFileHandle = null;

    acquireWakeLock();

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
                const hasSavePicker = typeof window.showSaveFilePicker === "function";

                if (directDiskEnabled && hasSavePicker && !diskWritableStream) {
                    if (!pendingMetaBytes) {
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

                await setupReceiver(bytes, passphrase);
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
                    progressBar.style.width = "100%";
                    percentEl.innerText = "100.0%";
                    integrityEl.innerText = "100% BIT-EXACT MATCH";
                    integrityEl.className = "metric-value highlight-text";

                    const downloadBtn = document.getElementById("btnDownload");
                    if (isOpfsMode && opfsFileHandle) {
                        try {
                            const opfsFile = await opfsFileHandle.getFile();
                            receivedFileBlob = opfsFile;
                            receivedFileName = finalRes.name;
                            downloadBtn.innerText = "Download Reconstructed File (from OPFS Disk)";
                            downloadBtn.disabled = false;
                            statusEl.innerText = "Transfer Complete & Saved in OPFS Storage!";
                        } catch (e) {
                            console.error("Failed to get OPFS file:", e);
                        }
                    } else if (finalRes.isStreaming) {
                        downloadBtn.innerText = "Streamed Directly to Disk (0 RAM)";
                        downloadBtn.disabled = true;
                        statusEl.innerText = "Transfer Complete & Saved to Disk!";
                    } else {
                        receivedFileBlob = new Blob([finalRes.data]);
                        receivedFileName = finalRes.name;
                        downloadBtn.innerText = "Download Reconstructed File";
                        downloadBtn.disabled = false;
                        statusEl.innerText = "Transfer Complete & Verified!";
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
    releaseWakeLock();
    if (activeBlossomAbortController) {
        activeBlossomAbortController.abort();
        activeBlossomAbortController = null;
    }
    const startBlossomBtn = document.getElementById("btnStartBlossomRecv");
    if (startBlossomBtn) startBlossomBtn.disabled = false;
    document.getElementById("btnStopRecv").disabled = true;
    document.getElementById("btnStartRecv").disabled = false;
    const promptBox = document.getElementById("recvDiskPrompt");
    if (promptBox) promptBox.classList.add("hidden");
    pendingMetaBytes = null;
    pendingMetaInfo = null;
    if (diskWritableStream) {
        diskWritableStream.abort().catch(() => {});
        diskWritableStream = null;
    }
    isOpfsMode = false;
    opfsFileHandle = null;

    if (activeNostrReceiverSub) {
        activeNostrReceiverSub.unsub();
        activeNostrReceiverSub = null;
    }
    if (window.BadHub && window.BadHub.resetSession) {
        window.BadHub.resetSession();
    }
    if (window.BadHub && window.BadHub.resetBlossomSession) {
        window.BadHub.resetBlossomSession();
    }
}

async function startBlossomDownload() {
    let inputVal = document.getElementById("recvBlossomInput")?.value.trim() || "";
    const passphrase = document.getElementById("recvPassphrase")?.value || "badhub-secure-swarm-v1";

    if (!inputVal) {
        alert("Please enter a Blossom Blob URL or SHA-256 hash.");
        return;
    }

    // Handle hex SHA-256 hash
    let blobUrl = inputVal;
    if (/^[a-fA-F0-9]{64}$/.test(inputVal)) {
        blobUrl = `https://nostr.download/${inputVal}`;
    }

    isReceiving = true;
    acquireWakeLock();

    const startBtn = document.getElementById("btnStartBlossomRecv");
    const stopBtn = document.getElementById("btnStopRecv");
    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;

    const fileEl = document.getElementById("recvMetricFile");
    const statusEl = document.getElementById("recvMetricStatus");
    const percentEl = document.getElementById("recvMetricPercent");
    const speedEl = document.getElementById("recvMetricSpeed");
    const integrityEl = document.getElementById("recvMetricIntegrity");
    const progressBar = document.getElementById("recvProgressBar");

    progressBar.style.width = "0%";
    percentEl.innerText = "0.0%";
    integrityEl.innerText = "CONNECTING...";
    integrityEl.className = "metric-value";
    statusEl.innerText = `Connecting to Blossom server: ${blobUrl}...`;

    activeBlossomAbortController = new AbortController();
    const startTime = performance.now();

    try {
        const resp = await fetch(blobUrl, { signal: activeBlossomAbortController.signal });
        if (!resp.ok) {
            throw new Error(`Blossom server returned HTTP ${resp.status}: ${resp.statusText}`);
        }

        const reader = resp.body.getReader();

        let decryptorInitialized = false;
        let decryptorMeta = null;
        let diskStream = null;
        let diskFileHandle = null;
        let isOpfs = false;
        let decryptedPlainParts = [];

        let streamBuf = new Uint8Array(0);
        let totalDownloaded = 0;

        function appendToBuffer(buf, newBytes) {
            const res = new Uint8Array(buf.length + newBytes.length);
            res.set(buf, 0);
            res.set(newBytes, buf.length);
            return res;
        }

        while (isReceiving) {
            const { done, value } = await reader.read();
            if (done) break;

            totalDownloaded += value.length;
            streamBuf = appendToBuffer(streamBuf, value);

            // 1. Initialize decryptor from header
            if (!decryptorInitialized) {
                if (streamBuf.length >= 8) {
                    const view = new DataView(streamBuf.buffer, streamBuf.byteOffset, streamBuf.byteLength);
                    const metaLen = view.getUint32(4, false);
                    const requiredHeaderLen = 8 + metaLen;

                    if (streamBuf.length >= requiredHeaderLen) {
                        const headerSlice = streamBuf.slice(0, requiredHeaderLen);
                        const initRes = window.BadHub.initBlossomDecryptor(headerSlice, passphrase);
                        if (!initRes || !initRes.success) {
                            throw new Error("Decryption failed: " + (initRes ? initRes.error : "incorrect passphrase"));
                        }
                        decryptorInitialized = true;
                        decryptorMeta = initRes;

                        fileEl.innerText = `${initRes.name} (${formatBytes(initRes.size)})`;
                        statusEl.innerText = "Decrypted metadata. Streaming file directly to disk...";

                        // Initialize Direct-to-Disk if enabled
                        const hasSavePicker = typeof window.showSaveFilePicker === "function";
                        const hasOPFS = typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function";

                        if (directDiskEnabled) {
                            if (hasSavePicker) {
                                try {
                                    diskFileHandle = await window.showSaveFilePicker({ suggestedName: initRes.name });
                                    diskStream = await diskFileHandle.createWritable();
                                } catch (e) {
                                    console.warn("Save picker bypassed, using memory or OPFS:", e);
                                }
                            }
                            if (!diskStream && hasOPFS) {
                                try {
                                    const root = await navigator.storage.getDirectory();
                                    const safeName = initRes.name.replace(/[/\\?%*:|"<>]/g, '_');
                                    diskFileHandle = await root.getFileHandle(safeName, { create: true });
                                    diskStream = await diskFileHandle.createWritable();
                                    isOpfs = true;
                                } catch (e) {
                                    console.warn("OPFS init failed:", e);
                                }
                            }
                        }

                        // Shift buffer past header
                        streamBuf = streamBuf.slice(requiredHeaderLen);
                    }
                }
            }

            // 2. Extract and decrypt chunks from streamBuf
            while (decryptorInitialized && streamBuf.length >= 4) {
                const chunkLen = new DataView(streamBuf.buffer, streamBuf.byteOffset, streamBuf.byteLength).getUint32(0, false);
                if (streamBuf.length < 4 + chunkLen) {
                    break; // Wait for full sealed chunk
                }

                const sealedChunk = streamBuf.slice(4, 4 + chunkLen);
                streamBuf = streamBuf.slice(4 + chunkLen);

                const decRes = window.BadHub.decryptBlossomChunk(sealedChunk);
                if (!decRes || !decRes.success) {
                    throw new Error("Chunk decryption failed: " + (decRes ? decRes.error : "corrupted"));
                }

                if (diskStream) {
                    await diskStream.write(decRes.chunk);
                } else {
                    decryptedPlainParts.push(decRes.chunk);
                }

                if (decRes.totalSize > 0) {
                    const pct = ((decRes.bytesRead / decRes.totalSize) * 100).toFixed(1);
                    progressBar.style.width = pct + "%";
                    percentEl.innerText = pct + "%";
                    statusEl.innerText = `Decrypting and saving: ${formatBytes(decRes.bytesRead)} / ${formatBytes(decRes.totalSize)}`;
                }

                const elapsedSec = (performance.now() - startTime) / 1000;
                if (elapsedSec > 0 && speedEl) {
                    const mbps = (totalDownloaded / 1048576) / elapsedSec;
                    speedEl.innerText = `${mbps.toFixed(2)} MB/s`;
                }
            }
        }

        // 3. Finalize decryption and verify integrity
        if (diskStream) {
            await diskStream.close();
            diskStream = null;
        }

        const finalRes = window.BadHub.finalizeBlossomDecryption();
        if (!finalRes || !finalRes.success) {
            throw new Error("Integrity verification failed: " + (finalRes ? finalRes.error : "hash mismatch"));
        }

        progressBar.style.width = "100%";
        percentEl.innerText = "100.0%";
        integrityEl.innerText = "100% BIT-EXACT MATCH";
        integrityEl.className = "metric-value highlight-text";

        const downloadBtn = document.getElementById("btnDownload");
        if (isOpfs && diskFileHandle) {
            const opfsFile = await diskFileHandle.getFile();
            receivedFileBlob = opfsFile;
            receivedFileName = decryptorMeta.name;
            downloadBtn.innerText = "Download Reconstructed File (from OPFS Disk)";
            downloadBtn.disabled = false;
            statusEl.innerText = "Download Complete & Saved in OPFS Storage (Sender was offline)!";
        } else if (diskFileHandle && !isOpfs) {
            downloadBtn.innerText = "Streamed Directly to Disk (0 RAM)";
            downloadBtn.disabled = true;
            statusEl.innerText = "Transfer Complete & Saved to Disk (Sender was offline)!";
        } else {
            receivedFileBlob = new Blob(decryptedPlainParts, { type: "application/octet-stream" });
            receivedFileName = decryptorMeta.name;
            downloadBtn.innerText = "Download Reconstructed File";
            downloadBtn.disabled = false;
            statusEl.innerText = "Transfer Complete & Verified (Sender was offline)!";
        }

        document.getElementById("verifiedChecksum").innerText = "SHA-256: " + decryptorMeta.checksum;
        document.getElementById("downloadContainer").classList.remove("hidden");

        stopReceiving();
    } catch (err) {
        if (isReceiving) {
            integrityEl.innerText = "FAILED";
            integrityEl.className = "metric-value color-danger";
            statusEl.innerText = "Error: " + err.message;
            alert("Blossom Download Error: " + err.message);
            stopReceiving();
        }
    } finally {
        activeBlossomAbortController = null;
        releaseWakeLock();
        if (window.BadHub.resetBlossomSession) window.BadHub.resetBlossomSession();
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
// DECENTRALIZED MEDIA & VIDEO STREAMING ENGINE
// ==========================================

let mediaSelectedFile = null;
let mediaBroadcastPeer = null;
let mediaActiveViewers = new Map();
let isBroadcastingMedia = false;
let mediaBroadcastStartTime = 0;
let mediaTotalStreamedBytes = 0;
let mediaBroadcastQrInstance = null;

let isStreamingPlayback = false;
let mediaViewerPeer = null;
let mediaViewerConn = null;
let mediaPlaybackStartTime = 0;
let mediaTotalReceivedBytes = 0;
let mediaTotalFileSize = 0;
let mediaDecryptedChunks = [];
let mediaStreamMime = "video/mp4";
let currentStreamFileName = "streamed-media.mp4";
let activeStreamId = "";
let swStreamActive = false;
let activeSourceBuffer = null;
let mediaBlossomAbortController = null;
let initialBlobLoaded = false;
let mediaOpfsFileHandle = null;
let mediaOpfsWritable = null;

// Mode Switching (Broadcast vs Watch)
function switchMediaMode(mode) {
    const navBroadcast = document.getElementById("mediaNavBroadcast");
    const navWatch = document.getElementById("mediaNavWatch");
    const panelBroadcast = document.getElementById("mediaBroadcastSection");
    const panelWatch = document.getElementById("mediaWatchSection");

    if (mode === "broadcast") {
        navBroadcast.classList.add("active");
        navWatch.classList.remove("active");
        panelBroadcast.classList.add("active");
        panelWatch.classList.remove("active");
    } else {
        navWatch.classList.add("active");
        navBroadcast.classList.remove("active");
        panelWatch.classList.add("active");
        panelBroadcast.classList.remove("active");
    }
}

// Transport Switching for Media Broadcast
function switchMediaTransport(mode) {
    const blossomBox = document.getElementById("mediaBlossomBox");
    if (blossomBox) {
        if (mode === "blossom") {
            blossomBox.classList.remove("hidden");
        } else {
            blossomBox.classList.add("hidden");
        }
    }
}

function onMediaBlossomServerChange(val) {
    const customGroup = document.getElementById("customMediaBlossomServerGroup");
    if (customGroup) {
        if (val === "custom") {
            customGroup.classList.remove("hidden");
        } else {
            customGroup.classList.add("hidden");
        }
    }
}

// Slider update helper
function updateMediaRedundancy(val) {
    const el = document.getElementById("mediaRedundancyVal");
    if (el) el.innerText = val + "%";
}

// Handle Media File Selection
function handleMediaFileSelected(file) {
    if (!file) return;
    mediaSelectedFile = file;

    const dropTitle = document.getElementById("mediaDropTitle");
    const dropSubtitle = document.getElementById("mediaDropSubtitle");
    const previewBox = document.getElementById("mediaLocalPreviewBox");
    const previewType = document.getElementById("mediaPreviewType");
    const previewName = document.getElementById("mediaPreviewName");
    const previewMeta = document.getElementById("mediaPreviewMeta");
    const previewVideo = document.getElementById("mediaBroadcastLocalPreview");
    const btnStart = document.getElementById("btnStartBroadcast");

    dropTitle.innerText = file.name;
    dropSubtitle.innerText = `${formatBytes(file.size)} - ${file.type || 'application/octet-stream'}`;

    const isAudio = file.type.startsWith("audio/");
    const isVideo = file.type.startsWith("video/") || /\.(mp4|webm|mkv|mov|avi)$/i.test(file.name);

    previewType.innerText = isAudio ? "AUDIO" : (isVideo ? "VIDEO" : "MEDIA");
    previewName.innerText = file.name;
    previewMeta.innerText = formatBytes(file.size);

    previewBox.classList.remove("hidden");

    if (isVideo) {
        previewVideo.classList.remove("hidden");
        const objUrl = URL.createObjectURL(file);
        previewVideo.src = objUrl;
        previewVideo.onloadedmetadata = () => {
            const dur = Math.round(previewVideo.duration);
            const mins = Math.floor(dur / 60);
            const secs = dur % 60;
            const durStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
            previewMeta.innerText = `${previewVideo.videoWidth}x${previewVideo.videoHeight} - ${durStr} - ${formatBytes(file.size)}`;
        };
    } else {
        previewVideo.classList.add("hidden");
        previewVideo.src = "";
    }

    btnStart.disabled = false;
}

// ------------------------------------------
// BROADCASTER LOGIC (Stream Media)
// ------------------------------------------

async function startMediaBroadcast() {
    if (!mediaSelectedFile) {
        alert("Please select a media file to broadcast.");
        return;
    }
    if (!window.BadHub || !window.BadHub.ready) {
        alert("WebAssembly Engine is not ready.");
        return;
    }

    const transportRadio = document.querySelector('input[name="mediaTransport"]:checked');
    const transport = transportRadio ? transportRadio.value : "webrtc";
    const passphrase = document.getElementById("mediaPassphrase").value.trim() || "badhub-live-stream-v1";
    const redundancy = (parseInt(document.getElementById("mediaRedundancy").value, 10) || 25) / 100.0;

    isBroadcastingMedia = true;
    mediaTotalStreamedBytes = 0;
    mediaBroadcastStartTime = performance.now();
    mediaActiveViewers.clear();

    document.getElementById("btnStartBroadcast").classList.add("hidden");
    document.getElementById("btnStopBroadcast").classList.remove("hidden");
    document.getElementById("mediaBroadcastActiveCard").classList.remove("hidden");

    const statusEl = document.getElementById("mediaBroadcastStatus");
    const linkInput = document.getElementById("mediaStreamLinkInput");

    if (transport === "webrtc") {
        statusEl.innerText = "Initializing P2P Room...";
        const streamRoomId = "bh-stream-" + Math.random().toString(36).substring(2, 10);

        const turnConf = getTurnConfig();
        try {
            mediaBroadcastPeer = new Peer(streamRoomId, turnConf);
        } catch (e) {
            mediaBroadcastPeer = new Peer(streamRoomId);
        }

        mediaBroadcastPeer.on("open", id => {
            statusEl.innerText = "Broadcasting (P2P Room Ready)";
            const streamUrl = `${window.location.origin}${window.location.pathname}#stream=p2p&room=${encodeURIComponent(id)}&key=${encodeURIComponent(passphrase)}&name=${encodeURIComponent(mediaSelectedFile.name)}&type=${encodeURIComponent(mediaSelectedFile.type || "video/mp4")}&size=${mediaSelectedFile.size}`;
            linkInput.value = streamUrl;
            renderMediaQr(streamUrl);
        });

        mediaBroadcastPeer.on("connection", conn => {
            conn.on("open", async () => {
                mediaActiveViewers.set(conn.peer, conn);
                updateViewerCount();
                await streamMediaToViewer(conn, passphrase, redundancy);
            });

            conn.on("close", () => {
                mediaActiveViewers.delete(conn.peer);
                updateViewerCount();
            });

            conn.on("error", () => {
                mediaActiveViewers.delete(conn.peer);
                updateViewerCount();
            });
        });

        mediaBroadcastPeer.on("error", err => {
            console.warn("Media Broadcaster PeerJS warning:", err);
            statusEl.innerText = "Signaling Notice: " + err.type;
        });

    } else if (transport === "blossom") {
        statusEl.innerText = "Encrypting & Uploading to Blossom Relays...";
        await broadcastViaBlossom(passphrase);
    }
}

function updateViewerCount() {
    const el = document.getElementById("mediaViewerCount");
    if (el) el.innerText = mediaActiveViewers.size;
}

async function streamMediaToViewer(conn, passphrase, redundancy) {
    try {
        const file = mediaSelectedFile;
        if (!file) return;

        const arrayBuf = await file.arrayBuffer();
        const fileBytes = new Uint8Array(arrayBuf);

        const senderRes = window.BadHub.initSender(file.name, fileBytes, passphrase, redundancy, 64, 64);
        if (!senderRes || !senderRes.success) {
            console.error("Failed to init media sender:", senderRes ? senderRes.error : "unknown");
            return;
        }

        const headerPayload = {
            type: "BH_MEDIA_STREAM_HEADER",
            name: file.name,
            size: file.size,
            mime: file.type || "video/mp4",
            meta: Array.from(senderRes.encryptedMetadata)
        };
        conn.send(JSON.stringify(headerPayload));

        let chunksStreamed = 0;
        const chunksEl = document.getElementById("mediaChunksStreamed");
        const bitrateEl = document.getElementById("mediaBitrate");

        while (isBroadcastingMedia && conn.open) {
            const frameRes = window.BadHub.nextSenderFrame();
            if (frameRes.error || frameRes.eof) break;

            if (frameRes.frame) {
                conn.send(frameRes.frame.buffer);
                chunksStreamed++;
                mediaTotalStreamedBytes += frameRes.frame.length;

                if (chunksEl) chunksEl.innerText = chunksStreamed;
                const elapsedSec = (performance.now() - mediaBroadcastStartTime) / 1000;
                if (elapsedSec > 0 && bitrateEl) {
                    const mbps = (mediaTotalStreamedBytes / 1048576) / elapsedSec;
                    bitrateEl.innerText = `${mbps.toFixed(2)} MB/s`;
                }

                if (conn.dataChannel && conn.dataChannel.bufferedAmount > 2 * 1024 * 1024) {
                    await new Promise(r => setTimeout(r, 20));
                }
            }
        }
    } catch (err) {
        console.warn("Stream transmission to viewer ended:", err);
    }
}

async function broadcastViaBlossom(passphrase) {
    const statusEl = document.getElementById("mediaBroadcastStatus");
    const linkInput = document.getElementById("mediaStreamLinkInput");
    const chunksEl = document.getElementById("mediaChunksStreamed");
    const bitrateEl = document.getElementById("mediaBitrate");
    const file = mediaSelectedFile;

    let targetServer = document.getElementById("mediaBlossomServer")?.value || "https://nostr.download";
    if (targetServer === "custom") {
        const customUrl = document.getElementById("txtCustomMediaBlossomServer")?.value.trim();
        if (customUrl) targetServer = customUrl.replace(/\/+$/, "");
    }

    try {
        statusEl.innerText = "Initializing Post-Quantum AEAD Stream Encryption...";
        const initRes = window.BadHub.initBlossomEncryptor(file.name, file.size, file.type || "video/mp4", passphrase);
        if (!initRes || !initRes.success) {
            throw new Error(initRes ? initRes.error : "Encryption init failed");
        }

        const blobHasherId = window.BadHub.createSha256();
        window.BadHub.updateSha256(blobHasherId, initRes.header);

        const sealedChunks = [initRes.header];
        const chunkSize = 512 * 1024;
        let offset = 0;

        while (offset < file.size && isBroadcastingMedia) {
            const slice = file.slice(offset, offset + chunkSize);
            const sliceBuf = await slice.arrayBuffer();
            offset += sliceBuf.byteLength;
            const isLast = (offset >= file.size);

            const encRes = window.BadHub.encryptBlossomChunk(new Uint8Array(sliceBuf), isLast);
            if (!encRes || !encRes.success) {
                throw new Error(encRes ? encRes.error : "Chunk encryption failed");
            }
            sealedChunks.push(encRes.sealed);
            window.BadHub.updateSha256(blobHasherId, encRes.sealed);

            const encPct = Math.round((offset / file.size) * 100);
            statusEl.innerText = `Encrypting stream chunks (${encPct}%)...`;
            if (chunksEl) chunksEl.innerText = sealedChunks.length;
        }

        if (!isBroadcastingMedia) {
            window.BadHub.finalizeSha256(blobHasherId);
            return;
        }

        const blobSha256 = window.BadHub.finalizeSha256(blobHasherId);
        const encryptedBlob = new Blob(sealedChunks, { type: "application/octet-stream" });

        // BUD-11 Nostr Authorization Event (kind 24242)
        if (!senderNostrPrivKey && typeof window.NostrTools !== "undefined") {
            senderNostrPrivKey = window.NostrTools.generatePrivateKey();
        }
        const now = Math.floor(Date.now() / 1000);
        const authEvent = window.NostrTools.finishEvent({
            kind: 24242,
            created_at: now,
            tags: [
                ["t", "upload"],
                ["x", blobSha256],
                ["size", String(encryptedBlob.size)],
                ["expiration", String(now + 3600)]
            ],
            content: `BadHub encrypted stream: ${file.name}`
        }, senderNostrPrivKey);
        const authHeader = "Nostr " + btoa(unescape(encodeURIComponent(JSON.stringify(authEvent))));

        // Candidate servers with automatic fallback
        const candidateServers = [targetServer];
        if (!candidateServers.includes("https://nostr.download")) candidateServers.push("https://nostr.download");
        if (!candidateServers.includes("https://blossom.primal.net")) candidateServers.push("https://blossom.primal.net");

        let uploadSuccess = false;
        let successfulServer = "";
        let lastError = null;

        for (const serverUrl of candidateServers) {
            if (!isBroadcastingMedia) break;

            let hostName = serverUrl;
            try { hostName = new URL(serverUrl).hostname; } catch (_) {}
            statusEl.innerText = `Uploading ${formatBytes(encryptedBlob.size)} to Blossom (${hostName})...`;

            let lastLoaded = 0;
            let lastTime = performance.now();

            try {
                await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    activeBlossomXhr = xhr;
                    xhr.open("PUT", `${serverUrl}/upload`);
                    xhr.setRequestHeader("Authorization", authHeader);
                    xhr.setRequestHeader("X-SHA-256", blobSha256);
                    xhr.setRequestHeader("Content-Type", "application/octet-stream");

                    xhr.upload.onprogress = (e) => {
                        if (e.lengthComputable && isBroadcastingMedia) {
                            const pct = Math.round((e.loaded / e.total) * 100);
                            statusEl.innerText = `Uploading to ${hostName} (${pct}% - ${formatBytes(e.loaded)} / ${formatBytes(e.total)})...`;
                            const curTime = performance.now();
                            const dt = (curTime - lastTime) / 1000;
                            if (dt >= 0.5) {
                                const speed = ((e.loaded - lastLoaded) / 1048576) / dt;
                                if (bitrateEl) bitrateEl.innerText = `${speed.toFixed(2)} MB/s`;
                                lastLoaded = e.loaded;
                                lastTime = curTime;
                            }
                        }
                    };

                    xhr.onload = () => {
                        activeBlossomXhr = null;
                        if (xhr.status >= 200 && xhr.status < 300) {
                            resolve(xhr.responseText);
                        } else {
                            const reason = xhr.getResponseHeader("x-reason") || xhr.statusText || "";
                            reject(new Error(`Server returned HTTP ${xhr.status} ${reason}`.trim()));
                        }
                    };

                    xhr.onerror = () => {
                        activeBlossomXhr = null;
                        reject(new Error(`Network error connecting to ${hostName}`));
                    };

                    xhr.onabort = () => {
                        activeBlossomXhr = null;
                        reject(new Error("Upload aborted by user"));
                    };

                    xhr.send(encryptedBlob);
                });

                uploadSuccess = true;
                successfulServer = serverUrl;
                break;
            } catch (err) {
                lastError = err;
                console.warn(`Blossom upload failed on ${serverUrl}:`, err);
                if (candidateServers.indexOf(serverUrl) < candidateServers.length - 1 && isBroadcastingMedia) {
                    statusEl.innerText = `Retrying on alternative relay... (${err.message})`;
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }

        if (!uploadSuccess) {
            throw lastError || new Error("Failed to upload to Blossom relays");
        }

        statusEl.innerText = "Broadcasting (Blossom Asynchronous Stream Ready)";
        const streamUrl = `${window.location.origin}${window.location.pathname}#stream=blossom&blob=${encodeURIComponent(blobSha256)}&server=${encodeURIComponent(successfulServer)}&key=${encodeURIComponent(passphrase)}&name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || "video/mp4")}&size=${file.size}`;
        linkInput.value = streamUrl;
        renderMediaQr(streamUrl);
    } catch (err) {
        if (!isBroadcastingMedia) return;
        statusEl.innerText = "Error: " + err.message;
        alert("Blossom Broadcast Error: " + err.message);
        stopMediaBroadcast();
    }
}

function renderMediaQr(text) {
    const qrDiv = document.getElementById("mediaQrCode");
    if (!qrDiv) return;
    qrDiv.innerHTML = "";
    if (typeof QRCode !== "undefined") {
        mediaBroadcastQrInstance = new QRCode(qrDiv, {
            text: text,
            width: 180,
            height: 180,
            colorDark: "#00f0ff",
            colorLight: "#0a0e17",
            correctLevel: QRCode.CorrectLevel.M
        });
    }
}

function copyMediaStreamLink() {
    const linkInput = document.getElementById("mediaStreamLinkInput");
    if (linkInput && linkInput.value) {
        navigator.clipboard.writeText(linkInput.value).then(() => {
            alert("Stream link copied to clipboard!");
        }).catch(() => {
            linkInput.select();
            document.execCommand("copy");
            alert("Stream link copied!");
        });
    }
}

function toggleMediaQr() {
    const c = document.getElementById("mediaQrContainer");
    if (c) c.classList.toggle("hidden");
}

function stopMediaBroadcast() {
    isBroadcastingMedia = false;
    if (activeBlossomXhr) {
        try {
            activeBlossomXhr.abort();
        } catch (_) {}
        activeBlossomXhr = null;
    }
    if (mediaBroadcastPeer) {
        mediaBroadcastPeer.destroy();
        mediaBroadcastPeer = null;
    }
    mediaActiveViewers.clear();

    document.getElementById("btnStartBroadcast").classList.remove("hidden");
    document.getElementById("btnStopBroadcast").classList.add("hidden");
    document.getElementById("mediaBroadcastActiveCard").classList.add("hidden");

    if (window.BadHub && window.BadHub.resetSession) {
        window.BadHub.resetSession();
    }
    if (window.BadHub && window.BadHub.resetBlossomSession) {
        window.BadHub.resetBlossomSession();
    }
}

// ------------------------------------------
// VIEWER / PLAYBACK LOGIC (Watch Live Stream)
// ------------------------------------------

async function startStreamingPlayback(customParam) {
    const inputVal = (typeof customParam === "string" && customParam.length > 0)
        ? customParam
        : document.getElementById("mediaStreamInput").value.trim();

    if (!inputVal) {
        alert("Please enter a stream link, room code, or Blossom URL.");
        return;
    }

    acquireWakeLock();
    isStreamingPlayback = true;
    mediaTotalReceivedBytes = 0;
    mediaTotalFileSize = 0;
    mediaDecryptedChunks = [];
    initialBlobLoaded = false;
    mediaPlaybackStartTime = performance.now();

    document.getElementById("btnConnectStream").classList.add("hidden");
    document.getElementById("btnDisconnectStream").classList.remove("hidden");
    document.getElementById("mediaPlayerCard").classList.remove("hidden");
    document.getElementById("mediaStreamSaveContainer").classList.add("hidden");

    const statusDot = document.getElementById("streamPlayerStatusDot");
    const playbackState = document.getElementById("streamPlaybackState");
    const titleText = document.getElementById("streamTitleText");
    const liveBadge = document.getElementById("streamLiveBadge");
    const bufferingOverlay = document.getElementById("playerBufferingOverlay");

    statusDot.className = "status-dot loading";
    playbackState.innerText = "Connecting to media stream...";
    bufferingOverlay.classList.remove("hidden");

    let params = null;
    if (inputVal.includes("#")) {
        params = new URLSearchParams(inputVal.substring(inputVal.indexOf("#") + 1));
    } else if (inputVal.includes("?")) {
        params = new URLSearchParams(inputVal.substring(inputVal.indexOf("?") + 1));
    } else if (inputVal.startsWith("stream=")) {
        params = new URLSearchParams(inputVal);
    }

    const streamMode = params ? params.get("stream") : null;
    const roomCode = params ? (params.get("room") || params.get("id")) : inputVal;
    const passphrase = (params && params.get("key")) ? params.get("key") : (document.getElementById("mediaWatchPassphrase").value.trim() || "badhub-live-stream-v1");
    const streamName = params ? (params.get("name") || "live-stream.mp4") : "live-stream.mp4";
    const streamType = params ? (params.get("type") || "video/mp4") : "video/mp4";
    const streamSize = params ? parseInt(params.get("size"), 10) : 0;

    currentStreamFileName = streamName;
    mediaStreamMime = streamType;
    mediaTotalFileSize = streamSize;
    titleText.innerText = `${streamName} ${streamSize > 0 ? '(' + formatBytes(streamSize) + ')' : ''}`;

    const opfsEnabled = document.getElementById("mediaOpfsToggle").checked;
    if (opfsEnabled && typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function") {
        try {
            const root = await navigator.storage.getDirectory();
            const safeName = streamName.replace(/[/\\?%*:|"<>]/g, '_');
            mediaOpfsFileHandle = await root.getFileHandle(safeName, { create: true });
            mediaOpfsWritable = await mediaOpfsFileHandle.createWritable();
        } catch (e) {
            console.warn("OPFS stream init bypassed, continuing in memory:", e);
        }
    }

    initMediaPlayerViewport(streamName, streamType, streamSize);

    if (streamMode === "blossom" || (params && params.get("blob"))) {
        liveBadge.innerText = "BLOSSOM STREAM";
        liveBadge.style.display = "inline-block";
        const blobId = params.get("blob");
        const server = params.get("server") || "https://nostr.download";
        const fullUrl = blobId.startsWith("http") ? blobId : `${server.replace(/\/+$/, "")}/${blobId}`;
        await playBlossomStream(fullUrl, passphrase);
    } else {
        liveBadge.innerText = "LIVE P2P";
        liveBadge.style.display = "inline-block";
        await playWebRtcStream(roomCode, passphrase);
    }
}

function initMediaPlayerViewport(name, mime, size) {
    activeStreamId = "bh_stream_" + Date.now();
    const videoEl = document.getElementById("mediaStreamVideo");
    const audioBox = document.getElementById("mediaAudioVisualizer");
    const audioLabel = document.getElementById("audioStreamLabel");

    const isAudio = mime.startsWith("audio/");
    if (isAudio) {
        videoEl.classList.add("hidden");
        audioBox.classList.remove("hidden");
        audioLabel.innerText = `Audio Stream: ${name}`;
    } else {
        videoEl.classList.remove("hidden");
        audioBox.classList.add("hidden");
    }

    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        swStreamActive = true;
        navigator.serviceWorker.controller.postMessage({
            type: "INIT_STREAM",
            streamId: activeStreamId,
            mimeType: mime,
            fileSize: size
        });
        videoEl.src = `badhub-stream/?id=${activeStreamId}`;
        videoEl.play().catch(e => console.log("Stream autoplay waiting for gesture:", e));
    } else if (window.MediaSource && MediaSource.isTypeSupported(mime)) {
        try {
            const ms = new MediaSource();
            videoEl.src = URL.createObjectURL(ms);
            ms.addEventListener("sourceopen", () => {
                try {
                    activeSourceBuffer = ms.addSourceBuffer(mime);
                } catch (e) {
                    console.warn("MSE initialization warning:", e);
                }
            });
            videoEl.play().catch(() => {});
        } catch (_) {}
    }
}

async function playWebRtcStream(roomCode, passphrase) {
    const statusDot = document.getElementById("streamPlayerStatusDot");
    const playbackState = document.getElementById("streamPlaybackState");
    const bufferingOverlay = document.getElementById("playerBufferingOverlay");

    try {
        const turnConf = getTurnConfig();
        try {
            mediaViewerPeer = new Peer(turnConf);
        } catch (_) {
            mediaViewerPeer = new Peer();
        }

        mediaViewerPeer.on("open", () => {
            playbackState.innerText = "Connecting to broadcaster swarm...";
            mediaViewerConn = mediaViewerPeer.connect(roomCode, { reliable: true });

            mediaViewerConn.on("open", () => {
                statusDot.className = "status-dot ready";
                playbackState.innerText = "Connected! Buffering initial packets...";
            });

            mediaViewerConn.on("data", async data => {
                if (!isStreamingPlayback) return;

                if (typeof data === "string") {
                    try {
                        const msg = JSON.parse(data);
                        if (msg.type === "BH_MEDIA_STREAM_HEADER") {
                            const metaBytes = new Uint8Array(msg.meta);
                            const onChunkDecoded = chunk => {
                                feedDecryptedMediaChunk(chunk);
                            };

                            const initRes = window.BadHub.initReceiver(metaBytes, passphrase, onChunkDecoded);
                            if (!initRes || !initRes.success) {
                                throw new Error("Metadata decryption failed: " + (initRes ? initRes.error : "incorrect passphrase"));
                            }
                            playbackState.innerText = "Playing live stream";
                            bufferingOverlay.classList.add("hidden");
                        }
                    } catch (e) {
                        console.warn("Stream header parse error:", e);
                    }
                    return;
                }

                const frameBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                const ingestRes = window.BadHub.ingestReceiverFrame(frameBytes);

                const stats = window.BadHub.getReceiverStats ? window.BadHub.getReceiverStats() : null;
                if (stats) {
                    const rlncEl = document.getElementById("streamMetricRlnc");
                    if (rlncEl) rlncEl.innerText = `${stats.droppedPackets || 0} dropped / ${stats.recoveredPackets || 0} rec`;
                }
            });

            mediaViewerConn.on("close", () => {
                finalizeMediaStreamPlayback();
            });

            mediaViewerConn.on("error", err => {
                playbackState.innerText = "Connection error: " + err.message;
            });
        });

        mediaViewerPeer.on("error", err => {
            statusDot.className = "status-dot error";
            playbackState.innerText = "Stream unavailable: " + (err.type === "peer-unavailable" ? "Broadcaster is offline" : err.type);
            bufferingOverlay.classList.add("hidden");
        });

    } catch (err) {
        statusDot.className = "status-dot error";
        playbackState.innerText = "Stream error: " + err.message;
        bufferingOverlay.classList.add("hidden");
    }
}

async function playBlossomStream(url, passphrase) {
    const statusDot = document.getElementById("streamPlayerStatusDot");
    const playbackState = document.getElementById("streamPlaybackState");
    const bufferingOverlay = document.getElementById("playerBufferingOverlay");

    mediaBlossomAbortController = new AbortController();

    try {
        const resp = await fetch(url, { signal: mediaBlossomAbortController.signal });
        if (!resp.ok) {
            throw new Error(`Failed to fetch Blossom blob (HTTP ${resp.status})`);
        }

        statusDot.className = "status-dot ready";
        playbackState.innerText = "Streaming from Blossom Relays...";

        const reader = resp.body.getReader();
        let streamBuf = new Uint8Array(0);
        let decryptorReady = false;

        function appendBuf(a, b) {
            const res = new Uint8Array(a.length + b.length);
            res.set(a, 0);
            res.set(b, a.length);
            return res;
        }

        while (isStreamingPlayback) {
            const { done, value } = await reader.read();
            if (done) break;

            streamBuf = appendBuf(streamBuf, value);

            if (!decryptorReady && streamBuf.length >= 8) {
                const metaLen = new DataView(streamBuf.buffer, streamBuf.byteOffset, streamBuf.byteLength).getUint32(4, false);
                const reqHeaderLen = 8 + metaLen;
                if (streamBuf.length >= reqHeaderLen) {
                    const headerSlice = streamBuf.slice(0, reqHeaderLen);
                    const initRes = window.BadHub.initBlossomDecryptor(headerSlice, passphrase);
                    if (!initRes || !initRes.success) {
                        throw new Error("Decryption failed: " + (initRes ? initRes.error : "incorrect passphrase"));
                    }
                    decryptorReady = true;
                    streamBuf = streamBuf.slice(reqHeaderLen);
                    bufferingOverlay.classList.add("hidden");
                    playbackState.innerText = "Playing live stream";
                }
            }

            while (decryptorReady && streamBuf.length >= 4) {
                const chunkLen = new DataView(streamBuf.buffer, streamBuf.byteOffset, streamBuf.byteLength).getUint32(0, false);
                if (streamBuf.length < 4 + chunkLen) break;

                const sealedChunk = streamBuf.slice(4, 4 + chunkLen);
                streamBuf = streamBuf.slice(4 + chunkLen);

                const decRes = window.BadHub.decryptBlossomChunk(sealedChunk);
                if (!decRes || !decRes.success) {
                    throw new Error("Chunk decryption failed: " + (decRes ? decRes.error : "corrupted"));
                }

                feedDecryptedMediaChunk(decRes.chunk);
            }
        }

        const finalRes = window.BadHub.finalizeBlossomDecryption();
        if (finalRes && finalRes.success) {
            const integrityEl = document.getElementById("streamMetricIntegrity");
            if (integrityEl) {
                integrityEl.innerText = "100% BIT-EXACT";
                integrityEl.className = "metric-value highlight-text";
            }
        }

        finalizeMediaStreamPlayback();
    } catch (err) {
        if (isStreamingPlayback) {
            statusDot.className = "status-dot error";
            playbackState.innerText = "Stream error: " + err.message;
            bufferingOverlay.classList.add("hidden");
        }
    }
}

function feedDecryptedMediaChunk(chunk) {
    if (!chunk || chunk.length === 0) return;

    mediaTotalReceivedBytes += chunk.length;
    mediaDecryptedChunks.push(chunk);

    if (mediaOpfsWritable) {
        mediaOpfsWritable.write(chunk).catch(() => {});
    }

    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: "PUSH_CHUNK",
            streamId: activeStreamId,
            chunk: chunk
        });
    }

    if (activeSourceBuffer && !activeSourceBuffer.updating) {
        try {
            activeSourceBuffer.appendBuffer(chunk);
        } catch (_) {}
    }

    if (!swStreamActive && !activeSourceBuffer && mediaTotalReceivedBytes >= 512 * 1024 && !initialBlobLoaded) {
        initialBlobLoaded = true;
        const videoEl = document.getElementById("mediaStreamVideo");
        const blob = new Blob(mediaDecryptedChunks, { type: mediaStreamMime || "video/mp4" });
        videoEl.src = URL.createObjectURL(blob);
        videoEl.play().catch(() => {});
        document.getElementById("playerBufferingOverlay").classList.add("hidden");
    }

    updateStreamTelemetry();
}

function updateStreamTelemetry() {
    const bufferEl = document.getElementById("streamMetricBuffer");
    const speedEl = document.getElementById("streamMetricSpeed");
    const bufferBar = document.getElementById("streamBufferBar");

    if (bufferEl) bufferEl.innerText = formatBytes(mediaTotalReceivedBytes);

    const elapsed = (performance.now() - mediaPlaybackStartTime) / 1000;
    if (elapsed > 0 && speedEl) {
        const mbps = (mediaTotalReceivedBytes / 1048576) / elapsed;
        speedEl.innerText = `${mbps.toFixed(2)} MB/s`;
    }

    if (mediaTotalFileSize > 0 && bufferBar) {
        const pct = Math.min(100, Math.round((mediaTotalReceivedBytes / mediaTotalFileSize) * 100));
        bufferBar.style.width = pct + "%";
    }
}

async function finalizeMediaStreamPlayback() {
    const playbackState = document.getElementById("streamPlaybackState");
    const saveContainer = document.getElementById("mediaStreamSaveContainer");
    const bufferingOverlay = document.getElementById("playerBufferingOverlay");

    bufferingOverlay.classList.add("hidden");
    if (playbackState) playbackState.innerText = "Stream Playback Ready";
    if (saveContainer) saveContainer.classList.remove("hidden");

    if (mediaOpfsWritable) {
        try {
            await mediaOpfsWritable.close();
            mediaOpfsWritable = null;
        } catch (_) {}
    }

    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: "END_STREAM",
            streamId: activeStreamId
        });
    }
}

function stopStreamingPlayback() {
    isStreamingPlayback = false;
    releaseWakeLock();

    const videoEl = document.getElementById("mediaStreamVideo");
    if (videoEl) {
        videoEl.pause();
        videoEl.src = "";
    }

    if (mediaViewerPeer) {
        mediaViewerPeer.destroy();
        mediaViewerPeer = null;
    }
    if (mediaBlossomAbortController) {
        mediaBlossomAbortController.abort();
        mediaBlossomAbortController = null;
    }

    document.getElementById("btnConnectStream").classList.remove("hidden");
    document.getElementById("btnDisconnectStream").classList.add("hidden");
    document.getElementById("playerBufferingOverlay").classList.add("hidden");
    document.getElementById("streamPlaybackState").innerText = "Playback stopped";
    document.getElementById("streamPlayerStatusDot").className = "status-dot";

    if (window.BadHub && window.BadHub.resetSession) {
        window.BadHub.resetSession();
    }
    if (window.BadHub && window.BadHub.resetBlossomSession) {
        window.BadHub.resetBlossomSession();
    }
}

async function saveStreamedMediaFile() {
    if (mediaOpfsFileHandle) {
        try {
            const file = await mediaOpfsFileHandle.getFile();
            triggerMediaBlobDownload(file, currentStreamFileName);
            return;
        } catch (_) {}
    }

    if (mediaDecryptedChunks && mediaDecryptedChunks.length > 0) {
        const blob = new Blob(mediaDecryptedChunks, { type: mediaStreamMime || "application/octet-stream" });
        triggerMediaBlobDownload(blob, currentStreamFileName);
    }
}

function triggerMediaBlobDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name || "streamed-media.mp4";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
    restoreSavedTurnConfig();
    window.addEventListener("hashchange", checkUrlHash);
    const passInput = document.getElementById("sendPassphrase");
    if (passInput) {
        passInput.addEventListener("input", () => {
            if (currentRoomId) updateMagicLink(currentRoomId);
        });
    }

    // Check FileSystem Access API & OPFS support for direct-to-disk streaming
    const diskToggle = document.getElementById("recvDirectDiskToggle");
    const diskBadge = document.getElementById("recvDiskBadge");
    const hasSavePicker = typeof window.showSaveFilePicker === "function";
    const hasOPFS = typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function";

    if (hasSavePicker) {
        if (diskToggle) diskToggle.checked = true;
        toggleDirectDisk(true);
    } else if (hasOPFS) {
        if (diskToggle) diskToggle.checked = true;
        toggleDirectDisk(true);
    } else {
        if (diskToggle) {
            diskToggle.checked = false;
            diskToggle.disabled = true;
        }
        if (diskBadge) {
            diskBadge.innerText = "Not Supported (Memory Mode)";
            diskBadge.title = "Browser lacks File System Access / OPFS API support";
        }
    }

    // Setup Service Worker for in-browser video & audio streaming
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw-stream.js?v=1.8.2', { scope: './' })
            .then(reg => {
                console.log('Stream ServiceWorker registered with scope:', reg.scope);
            })
            .catch(err => {
                console.warn('Stream ServiceWorker registration bypassed:', err);
            });
    }

    // Media Dropzone Setup
    const mediaDrop = document.getElementById("mediaDropzone");
    const mediaInput = document.getElementById("mediaFileInput");
    if (mediaDrop && mediaInput) {
        ["dragenter", "dragover"].forEach(eventName => {
            mediaDrop.addEventListener(eventName, e => {
                e.preventDefault();
                mediaDrop.classList.add("dragover");
            }, false);
        });

        ["dragleave", "drop"].forEach(eventName => {
            mediaDrop.addEventListener(eventName, e => {
                e.preventDefault();
                mediaDrop.classList.remove("dragover");
            }, false);
        });

        mediaDrop.addEventListener("drop", e => {
            const dt = e.dataTransfer;
            if (dt && dt.files && dt.files.length > 0) {
                handleMediaFileSelected(dt.files[0]);
            }
        });

        mediaInput.addEventListener("change", e => {
            if (e.target.files && e.target.files.length > 0) {
                handleMediaFileSelected(e.target.files[0]);
            }
        });
    }
});
