// BadHub In-Browser Media Streaming Service Worker
// Enables native HTTP 206 Partial Content video and audio playback directly from P2P RLNC & Blossom decrypted chunks.

const streamRegistry = new Map();

self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

function notifyStreamListeners(stream) {
    if (stream && stream.listeners && stream.listeners.length > 0) {
        const list = [...stream.listeners];
        list.forEach(fn => fn());
    }
}

function waitForBytes(stream, minBytes, timeoutMs = 8000) {
    if (stream.totalReceived >= minBytes || stream.finished) {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        let timer = null;
        const check = () => {
            if (stream.totalReceived >= minBytes || stream.finished) {
                if (timer) clearTimeout(timer);
                stream.listeners = (stream.listeners || []).filter(l => l !== check);
                resolve();
            }
        };
        if (!stream.listeners) stream.listeners = [];
        stream.listeners.push(check);
        timer = setTimeout(() => {
            stream.listeners = (stream.listeners || []).filter(l => l !== check);
            resolve();
        }, timeoutMs);
    });
}

self.addEventListener('message', event => {
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === 'INIT_STREAM') {
        streamRegistry.set(data.streamId, {
            mimeType: data.mimeType || 'video/mp4',
            fileSize: data.fileSize || 0,
            chunks: [],
            totalReceived: 0,
            finished: false,
            listeners: []
        });
    } else if (data.type === 'PUSH_CHUNK') {
        const stream = streamRegistry.get(data.streamId);
        if (!stream) return;
        const chunk = new Uint8Array(data.chunk);
        stream.chunks.push(chunk);
        stream.totalReceived += chunk.length;
        notifyStreamListeners(stream);
    } else if (data.type === 'END_STREAM') {
        const stream = streamRegistry.get(data.streamId);
        if (!stream) return;
        stream.finished = true;
        notifyStreamListeners(stream);
    } else if (data.type === 'RESET_STREAM') {
        const stream = streamRegistry.get(data.streamId);
        if (stream) {
            notifyStreamListeners(stream);
        }
        streamRegistry.delete(data.streamId);
    }
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (!url.pathname.includes('/badhub-stream/')) {
        return;
    }

    const streamId = url.searchParams.get('id');
    const stream = streamRegistry.get(streamId);

    if (!stream) {
        event.respondWith(new Response('Stream not found or expired', { status: 404 }));
        return;
    }

    event.respondWith((async () => {
        const rangeHeader = event.request.headers.get('range');
        const fileSize = stream.fileSize || 0;
        const mimeType = stream.mimeType || 'video/mp4';

        // 1. If stream just initialized and has 0 chunks, wait for initial data
        if (stream.chunks.length === 0 && !stream.finished) {
            await waitForBytes(stream, 64 * 1024, 6000);
        }

        let blob = new Blob(stream.chunks, { type: mimeType });
        let availableBytes = blob.size;

        if (rangeHeader) {
            const matches = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (matches) {
                const start = parseInt(matches[1], 10);

                // If user seeks beyond currently available bytes, wait if stream is still active
                if (start >= availableBytes && !stream.finished && fileSize > 0 && start < fileSize) {
                    await waitForBytes(stream, Math.min(fileSize, start + 256 * 1024), 8000);
                    blob = new Blob(stream.chunks, { type: mimeType });
                    availableBytes = blob.size;
                }

                // If start is still beyond available bytes, return 416 (Range Not Satisfiable)
                if (start >= availableBytes) {
                    return new Response(null, {
                        status: 416,
                        headers: {
                            'Content-Range': `bytes */${fileSize > 0 ? fileSize : availableBytes}`,
                            'Accept-Ranges': 'bytes'
                        }
                    });
                }

                let end = matches[2] ? parseInt(matches[2], 10) : (fileSize > 0 ? fileSize - 1 : availableBytes - 1);
                if (end >= availableBytes && !stream.finished) {
                    end = availableBytes > 0 ? availableBytes - 1 : 0;
                }
                if (end < start) {
                    end = start;
                }

                const slice = blob.slice(start, end + 1);
                const totalLenStr = (fileSize > 0) ? String(fileSize) : (stream.finished ? String(availableBytes) : '*');

                return new Response(slice, {
                    status: 206,
                    headers: {
                        'Content-Type': mimeType,
                        'Content-Range': `bytes ${start}-${end}/${totalLenStr}`,
                        'Content-Length': String(slice.size),
                        'Accept-Ranges': 'bytes',
                        'Cache-Control': 'no-cache, no-store'
                    }
                });
            }
        }

        // Default response: Return currently available stream buffer with 200 or 206
        const headers = {
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache, no-store',
            'Content-Length': String(availableBytes)
        };

        if (fileSize > 0 && availableBytes < fileSize) {
            headers['Content-Range'] = `bytes 0-${availableBytes > 0 ? availableBytes - 1 : 0}/${fileSize}`;
            return new Response(blob, {
                status: 206,
                headers: headers
            });
        } else {
            return new Response(blob, {
                status: 200,
                headers: headers
            });
        }
    })());
});
