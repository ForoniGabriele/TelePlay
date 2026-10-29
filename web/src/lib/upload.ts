/**
 * Browser-side helpers for uploading files to the library from the web interface.
 */
import { api, TelegramFile } from './api';

export interface MediaMeta {
    duration?: number;
    width?: number;
    height?: number;
    thumbnail?: Blob | null;
}

/**
 * Reads duration / size of a video or audio file in the browser and grabs a small
 * JPEG frame as thumbnail. Never rejects: if the browser can't read the file
 * (unsupported codec/container) it resolves with whatever it managed to get.
 */
export function extractMediaMeta(file: File): Promise<MediaMeta> {
    const isVideo = file.type.startsWith('video/');
    const isAudio = file.type.startsWith('audio/');
    if (!isVideo && !isAudio) return Promise.resolve({});

    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const el = document.createElement(isVideo ? 'video' : 'audio') as HTMLVideoElement;
        el.preload = 'metadata';
        el.muted = true;

        let settled = false;
        let meta: MediaMeta = {};
        let timer: ReturnType<typeof setTimeout>;

        const finish = (result: MediaMeta) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            el.removeAttribute('src');
            el.load();
            URL.revokeObjectURL(url);
            resolve(result);
        };

        timer = setTimeout(() => finish(meta), 8000);

        el.onerror = () => finish(meta);

        el.onloadedmetadata = () => {
            meta = { duration: Number.isFinite(el.duration) ? el.duration : undefined };
            if (!isVideo) {
                finish(meta);
                return;
            }
            meta.width = el.videoWidth || undefined;
            meta.height = el.videoHeight || undefined;
            if (!meta.duration) {
                finish(meta);
                return;
            }
            // Jump a little into the video so the thumbnail isn't a black first frame
            el.currentTime = Math.min(Math.max(meta.duration * 0.1, 0.5), 30);
        };

        el.onseeked = () => {
            try {
                if (!el.videoWidth || !el.videoHeight) {
                    finish(meta);
                    return;
                }
                // Telegram thumbnails: JPEG, at most 320px on the longest side
                const scale = 320 / Math.max(el.videoWidth, el.videoHeight);
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(el.videoWidth * scale));
                canvas.height = Math.max(1, Math.round(el.videoHeight * scale));
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    finish(meta);
                    return;
                }
                ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => finish({ ...meta, thumbnail: blob }), 'image/jpeg', 0.7);
            } catch {
                finish(meta);
            }
        };

        el.src = url;
    });
}

interface UploadOptions {
    folderId?: number | null;
    meta?: MediaMeta;
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
}

/** Sends a file to the backend, which stores it on Telegram and adds it to the library. */
export async function uploadFile(file: File, options: UploadOptions = {}): Promise<TelegramFile> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (options.folderId) form.append('folder_id', String(options.folderId));

    const meta = options.meta;
    if (meta?.duration) form.append('duration', String(meta.duration));
    if (meta?.width) form.append('width', String(meta.width));
    if (meta?.height) form.append('height', String(meta.height));
    if (meta?.thumbnail) form.append('thumbnail', meta.thumbnail, 'thumb.jpg');

    const { data } = await api.post<TelegramFile>('/files/upload', form, {
        signal: options.signal,
        timeout: 0, // large files can take a long time
        onUploadProgress: (event) => {
            if (event.total) {
                options.onProgress?.(Math.min(100, Math.round((event.loaded * 100) / event.total)));
            }
        },
    });
    return data;
}