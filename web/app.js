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

// Slider update helpers
function updateRedundancy(val) {
    document.getElementById("redundancyVal").innerText = val + "%";
}

function updateSimLoss(val) {
    document.getElementById("simLossVal").innerText = val + "%";
}

// Transport mode toggles
function switchSendTransport(mode) {
    const box = document.getElementById("sendWebRTCBox");
    if (mode === "webrtc") {
        box.classList.remove("hidden");
    } else {
        box.classList.add("hidden");
    }
}

function switchRecvTransport(mode) {
    const box = document.getElementById("recvWebRTCBox");
    if (mode === "webrtc") {
        box.classList.remove("hidden");
    } else {
        box.classList.add("hidden");
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
    const res = window.BadHub.initSender(selectedFile.name, selectedFileData, passphrase, redundancy, 32);
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
        sendWirePacket = (packet) => {
            activeBroadcastChannel.postMessage({ type: "frame", data: packet });
        };
        // Emit encrypted metadata packet 5 times
        for (let i = 0; i < 5; i++) {
            activeBroadcastChannel.postMessage({ type: "meta", data: res.encryptedMetadata });
            await new Promise(r => setTimeout(r, 10));
        }
    } else {
        // WebRTC DataChannel
        if (!activeDataChannel || activeDataChannel.readyState !== "open") {
            alert("WebRTC DataChannel is not open! Please generate and exchange offer/answer tokens first.");
            stopTransmission();
            return;
        }
        sendWirePacket = (packet) => {
            activeDataChannel.send(packet);
        };
        for (let i = 0; i < 5; i++) {
            activeDataChannel.send(res.encryptedMetadata);
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
            sendWirePacket(frameRes.frame);
            bytesSent += frameRes.frame.length;
            frameCount++;

            if (frameCount % 4 === 0) {
                const stats = window.BadHub.getSenderStats();
                dataEl.innerText = stats.dataPackets;
                parityEl.innerText = stats.parityPackets;

                const elapsed = (performance.now() - startTime) / 1000;
                if (elapsed > 0) {
                    const mbps = (bytesSent / (1024 * 1024)) / elapsed;
                    speedEl.innerText = mbps.toFixed(2) + " MB/s";
                }

                const approxTotal = res.totalChunks * (1.0 + redundancy);
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
}

function stopTransmission() {
    isTransmitting = false;
    document.getElementById("btnStopSend").disabled = true;
    document.getElementById("btnStartSend").disabled = false;
    document.getElementById("sendMetricStatus").innerText = "Stopped";
}

// ==========================================
// P2P RECEIVER IMPLEMENTATION
// ==========================================

function startReceiving() {
    if (!window.BadHub) return;

    isReceiving = true;
    document.getElementById("btnStartRecv").disabled = true;
    document.getElementById("btnStopRecv").disabled = false;
    document.getElementById("downloadContainer").classList.add("hidden");

    const passphrase = document.getElementById("recvPassphrase").value || "badhub-default-secret";
    const transport = document.querySelector('input[name="recvTransport"]:checked').value;

    const statusEl = document.getElementById("recvMetricStatus");
    const fileEl = document.getElementById("recvMetricFile");
    const percentEl = document.getElementById("recvMetricPercent");
    const framesEl = document.getElementById("recvMetricFrames");
    const droppedEl = document.getElementById("recvMetricDropped");
    const integrityEl = document.getElementById("recvMetricIntegrity");
    const progressBar = document.getElementById("recvProgressBar");

    statusEl.innerText = "Listening for incoming stream...";
    progressBar.style.width = "0%";

    let receiverInitialized = false;

    // Incoming wire packet handler
    const onIncomingWirePacket = (packetData) => {
        if (!isReceiving) return;
        const bytes = new Uint8Array(packetData);

        // Check if metadata packet
        if (bytes.length < 1380) {
            if (!receiverInitialized) {
                const initRes = window.BadHub.initReceiver(bytes, passphrase);
                if (initRes.success) {
                    receiverInitialized = true;
                    fileEl.innerText = `${initRes.name} (${formatBytes(initRes.size)})`;
                    statusEl.innerText = "Metadata validated. Receiving shards...";
                }
            }
            return;
        }

        // Regular 1380-byte encrypted frame
        if (receiverInitialized) {
            const ingestRes = window.BadHub.ingestReceiverFrame(bytes);
            framesEl.innerText = ingestRes.framesReceived;
            droppedEl.innerText = ingestRes.framesDropped;

            progressBar.style.width = ingestRes.percent.toFixed(1) + "%";
            percentEl.innerText = ingestRes.percent.toFixed(1) + "%";

            if (ingestRes.completed) {
                // Finalize and verify
                const finalRes = window.BadHub.finalizeReceiver();
                if (finalRes.success) {
                    statusEl.innerText = "Transfer Complete & Verified!";
                    integrityEl.innerText = "100% BIT-EXACT MATCH";
                    integrityEl.className = "metric-value highlight-text";
                    progressBar.style.width = "100%";
                    percentEl.innerText = "100.0%";

                    receivedFileBlob = new Blob([finalRes.data]);
                    receivedFileName = finalRes.name;

                    document.getElementById("verifiedChecksum").innerText = "SHA-256: " + finalRes.checksum;
                    document.getElementById("downloadContainer").classList.remove("hidden");
                    stopReceiving();
                } else {
                    integrityEl.innerText = "CORRUPTED / FAILED";
                    integrityEl.className = "metric-value color-danger";
                    statusEl.innerText = "Verification failed: " + finalRes.error;
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

const rtcConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" }
    ]
};

async function generateWebRTCOffer() {
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
    const answer = JSON.parse(atob(rawAnswer));
    await activePeerConnection.setRemoteDescription(answer);
    alert("Peer answer configured! Connecting DataChannel...");
}

async function generateWebRTCAnswer() {
    const rawOffer = document.getElementById("txtRecvOffer").value.trim();
    if (!rawOffer) {
        alert("Please paste the sender's offer token first.");
        return;
    }

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

    const offer = JSON.parse(atob(rawOffer));
    await activePeerConnection.setRemoteDescription(offer);
    const answer = await activePeerConnection.createAnswer();
    await activePeerConnection.setLocalDescription(answer);
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
    log("Initializing WASM Sender (RLNC Sliding Window: 32, Redundancy: 40%)...");

    const senderRes = window.BadHub.initSender("simulation-test.bin", syntheticData, passphrase, redundancy, 32);
    if (!senderRes.success) {
        log("Sender init failed: " + senderRes.error, "error");
        btn.disabled = false;
        return;
    }
    log(`Sender initialized: ${senderRes.totalChunks} chunks, SHA-256=${senderRes.checksum.slice(0, 16)}...`);

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

    for (let i = 0; i < framesToFeed.length; i++) {
        const ingestRes = window.BadHub.ingestReceiverFrame(framesToFeed[i]);
        const pct = Math.min(100, Math.round(((i + 1) / framesToFeed.length) * 100));
        progressBar.style.width = pct + "%";

        if (i % 8 === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }

    log("Finalizing receiver and verifying bit-exact SHA-256 integrity anchor...");
    const finalRes = window.BadHub.finalizeReceiver();

    if (finalRes.success) {
        statusEl.innerText = "Completed: 100% Bit-Exact Match!";
        verifiedEl.innerText = "SHA-256 VERIFIED";
        verifiedEl.className = "metric-value highlight-text";
        progressBar.style.width = "100%";
        log(`RECOVERY SUCCESS: All ${sizeKB} KB reconstructed! SHA-256=${finalRes.checksum}`, "success");
    } else {
        statusEl.innerText = "Failed";
        verifiedEl.innerText = "FAILED";
        verifiedEl.className = "metric-value color-danger";
        log("RECOVERY FAILED: " + finalRes.error, "error");
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
window.addEventListener("DOMContentLoaded", initWasm);
