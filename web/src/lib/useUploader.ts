/**
 * Upload queue: files are sent one at a time, with progress and cancel support.
 */
import { useCallback, useRef, useState } from 'react';
import axios from 'axios';
import { TelegramFile } from './api';
import { extractMediaMeta, uploadFile } from './upload';

export type UploadStatus = 'queued' | 'preparing' | 'uploading' | 'processing' | 'done' | 'error';

export interface UploadItem {
    id: string;
    name: string;
    size: number;
    progress: number;
    status: UploadStatus;
    error?: string;
}

interface Job {
    id: string;
    file: File;
    folderId: number | null;
}

let jobCounter = 0;

function errorMessage(err: any): string {
    const detail = err?.response?.data?.detail;
    if (typeof detail === 'string') return detail;
    if (detail) return JSON.stringify(detail);
    return err?.message || 'Upload failed';
}

export function useUploader(
    onUploaded?: (file: TelegramFile) => void,
    onError?: (name: string, message: string) => void,
) {
    const [items, setItems] = useState<UploadItem[]>([]);
    const queue = useRef<Job[]>([]);
    const running = useRef(false);
    const controllers = useRef(new Map<string, AbortController>());

    // Always call the latest callbacks, even for uploads that last a long time
    const callbacks = useRef({ onUploaded, onError });
    callbacks.current = { onUploaded, onError };

    const patch = useCallback((id: string, changes: Partial<UploadItem>) => {
        setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...changes } : item)));
    }, []);

    const runQueue = useCallback(async () => {
        if (running.current) return;
        running.current = true;

        while (queue.current.length > 0) {
            const job = queue.current.shift()!;
            const controller = new AbortController();
            controllers.current.set(job.id, controller);

            try {
                patch(job.id, { status: 'preparing' });
                const meta = await extractMediaMeta(job.file);

                if (controller.signal.aborted) {
                    patch(job.id, { status: 'error', error: 'Cancelled' });
                    continue;
                }

                patch(job.id, { status: 'uploading', progress: 0 });
                const uploaded = await uploadFile(job.file, {
                    folderId: job.folderId,
                    meta,
                    signal: controller.signal,
                    onProgress: (percent) =>
                        // At 100% the browser is done, but the server is still sending the file to Telegram
                        patch(job.id, { progress: percent, status: percent >= 100 ? 'processing' : 'uploading' }),
                });

                patch(job.id, { status: 'done', progress: 100 });
                callbacks.current.onUploaded?.(uploaded);
            } catch (err: any) {
                if (axios.isCancel(err)) {
                    patch(job.id, { status: 'error', error: 'Cancelled' });
                } else {
                    const message = errorMessage(err);
                    patch(job.id, { status: 'error', error: message });
                    callbacks.current.onError?.(job.file.name, message);
                }
            } finally {
                controllers.current.delete(job.id);
            }
        }

        running.current = false;
    }, [patch]);

    const addFiles = useCallback(
        (files: File[], folderId: number | null) => {
            if (files.length === 0) return;
            const jobs: Job[] = files.map((file) => ({
                id: `upload-${Date.now()}-${jobCounter++}`,
                file,
                folderId,
            }));
            setItems((prev) => [
                ...prev,
                ...jobs.map((job) => ({
                    id: job.id,
                    name: job.file.name,
                    size: job.file.size,
                    progress: 0,
                    status: 'queued' as UploadStatus,
                })),
            ]);
            queue.current.push(...jobs);
            void runQueue();
        },
        [runQueue],
    );

    const cancel = useCallback(
        (id: string) => {
            const index = queue.current.findIndex((job) => job.id === id);
            if (index >= 0) {
                queue.current.splice(index, 1);
                patch(id, { status: 'error', error: 'Cancelled' });
                return;
            }
            controllers.current.get(id)?.abort();
        },
        [patch],
    );

    const clearFinished = useCallback(() => {
        setItems((prev) => prev.filter((item) => item.status !== 'done' && item.status !== 'error'));
    }, []);

    return { items, addFiles, cancel, clearFinished };
}