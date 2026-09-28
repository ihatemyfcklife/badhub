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
            finished: false
        });
    } else if (data.type === 'PUSH_CHUNK') {
        const stream = streamRegistry.get(data.streamId);
        if (!stream) return;
        const chunk = new Uint8Array(data.chunk);
        stream.chunks.push(chunk);
        stream.totalReceived += chunk.length;
    } else if (data.type === 'END_STREAM') {
        const stream = streamRegistry.get(data.streamId);
        if (!stream) return;
        stream.finished = true;
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
        const fileSize = stream.fileSize || 0;
        const mimeType = stream.mimeType || 'video/mp4';

        // Build accumulated blob from all currently received chunks without shifting or destroying data
        const blob = new Blob(stream.chunks, { type: mimeType });
        const availableBytes = blob.size;

        if (rangeHeader) {
            const matches = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (matches) {
                const start = parseInt(matches[1], 10);
                let end = matches[2] ? parseInt(matches[2], 10) : (fileSize > 0 ? fileSize - 1 : availableBytes - 1);
                if (end >= availableBytes && !stream.finished) {
                    end = availableBytes > 0 ? availableBytes - 1 : 0;
                }

                if (start < availableBytes) {
                    const slice = blob.slice(start, end + 1);
                    const totalLenStr = (fileSize > 0) ? String(fileSize) : (stream.finished ? String(availableBytes) : '*');
                    event.respondWith(new Response(slice, {
                        status: 206,
                        headers: {
                            'Content-Type': mimeType,
                            'Content-Range': `bytes ${start}-${end}/${totalLenStr}`,
                            'Content-Length': String(slice.size),
                            'Accept-Ranges': 'bytes',
                            'Cache-Control': 'no-cache, no-store'
                        }
                    }));
                    return;
                }
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
            event.respondWith(new Response(blob, {
                status: 206,
                headers: headers
            }));
        } else {
            event.respondWith(new Response(blob, {
                status: 200,
                headers: headers
            }));
        }
    }
});
