/**
 * UploadPanel - floating list showing the progress of web uploads
 */
import { X, CheckCircle2, AlertCircle, Loader2, Upload } from 'lucide-react';
import { formatFileSize } from '../lib/api';
import { UploadItem, UploadStatus } from '../lib/useUploader';

interface UploadPanelProps {
    items: UploadItem[];
    onCancel: (id: string) => void;
    onClearFinished: () => void;
}

const isActive = (status: UploadStatus) =>
    status === 'queued' || status === 'preparing' || status === 'uploading' || status === 'processing';

function statusText(item: UploadItem): string {
    switch (item.status) {
        case 'queued':
            return 'Waiting...';
        case 'preparing':
            return 'Reading file info...';
        case 'uploading':
            return `${item.progress}% of ${formatFileSize(item.size)}`;
        case 'processing':
            return 'Saving to Telegram...';
        case 'done':
            return `Done · ${formatFileSize(item.size)}`;
        case 'error':
            return item.error || 'Failed';
    }
}

export default function UploadPanel({ items, onCancel, onClearFinished }: UploadPanelProps) {
    if (items.length === 0) return null;

    const activeCount = items.filter((item) => isActive(item.status)).length;

    return (
        <div className="fixed bottom-4 right-4 z-[110] w-80 max-w-[calc(100vw-2rem)] glass-card p-3 shadow-2xl animate-slide-up">
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Upload className="w-4 h-4 text-primary-400" />
                    {activeCount > 0
                        ? `Uploading ${activeCount} file${activeCount !== 1 ? 's' : ''}`
                        : 'Uploads finished'}
                </div>
                <button onClick={onClearFinished} className="text-xs text-dark-400 hover:text-white transition-colors">
                    Clear
                </button>
            </div>

            <div className="max-h-60 overflow-y-auto space-y-2 custom-scrollbar">
                {items.map((item) => (
                    <div key={item.id} className="rounded-lg bg-dark-800/60 p-2">
                        <div className="flex items-center gap-2">
                            {item.status === 'done' && <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />}
                            {item.status === 'error' && <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />}
                            {isActive(item.status) && <Loader2 className="w-4 h-4 text-primary-400 shrink-0 animate-spin" />}
                            <p className="text-sm truncate flex-1" title={item.name}>{item.name}</p>
                            {isActive(item.status) && (
                                <button
                                    onClick={() => onCancel(item.id)}
                                    className="p-0.5 text-dark-400 hover:text-white"
                                    title="Cancel"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </div>
                        <p className={`text-xs mt-1 ${item.status === 'error' ? 'text-red-400' : 'text-dark-400'}`}>
                            {statusText(item)}
                        </p>
                        {(item.status === 'uploading' || item.status === 'processing') && (
                            <div className="h-1 mt-1.5 bg-white/10 rounded-full overflow-hidden">
                                <div
                                    className={`h-full bg-primary-500 transition-all ${item.status === 'processing' ? 'animate-pulse' : ''}`}
                                    style={{ width: `${item.progress}%` }}
                                />
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}