// BadHub In-Browser Media Streaming Service Worker
// Enables native HTTP 206 Partial Content video and audio playback directly from P2P RLNC & Blossom decrypted chunks.

const streamRegistry = new Map();

self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

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
            controller: null
        });
    } else if (data.type === 'PUSH_CHUNK') {
        const stream = streamRegistry.get(data.streamId);
        if (!stream) return;
        const chunk = new Uint8Array(data.chunk);
        stream.totalReceived += chunk.length;

        if (stream.controller) {
            try {
                stream.controller.enqueue(chunk);
            } catch (e) {
                console.warn("ServiceWorker enqueue warning:", e);
            }
        } else {
            stream.chunks.push(chunk);
        }
    } else if (data.type === 'END_STREAM') {
        const stream = streamRegistry.get(data.streamId);
        if (!stream) return;
        stream.finished = true;
        if (stream.controller) {
            try {
                stream.controller.close();
            } catch (e) {}
            stream.controller = null;
        }
    } else if (data.type === 'RESET_STREAM') {
        streamRegistry.delete(data.streamId);
    }
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/badhub-stream/')) {
        const streamId = url.searchParams.get('id');
        const stream = streamRegistry.get(streamId);

        if (!stream) {
            event.respondWith(new Response('Stream not found or expired', { status: 404 }));
            return;
        }

        const rangeHeader = event.request.headers.get('range');
        const fileSize = stream.fileSize;
        const mimeType = stream.mimeType;

        let start = 0;
        let end = fileSize ? fileSize - 1 : undefined;

        if (rangeHeader) {
            const matches = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (matches) {
                start = parseInt(matches[1], 10);
                if (matches[2]) {
                    end = parseInt(matches[2], 10);
                }
            }
        }

        const readableStream = new ReadableStream({
            start(controller) {
                stream.controller = controller;
                while (stream.chunks.length > 0) {
                    const c = stream.chunks.shift();
                    controller.enqueue(c);
                }
                if (stream.finished) {
                    controller.close();
                    stream.controller = null;
                }
            },
            cancel() {
                stream.controller = null;
            }
        });

        const headers = {
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache, no-store'
        };

        let status = 200;
        if (fileSize > 0) {
            headers['Content-Length'] = String(fileSize - start);
            if (rangeHeader) {
                status = 206;
                headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
            }
        }

        event.respondWith(new Response(readableStream, {
            status: status,
            headers: headers
        }));
    }
});
