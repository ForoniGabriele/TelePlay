/**
 * FileCoverModal - modal for setting or resetting the cover image of a single file
 */
import { useState, useRef, DragEvent } from 'react';
import { X, Upload, Image as ImageIcon, RotateCcw, Check, Film, Loader2 } from 'lucide-react';
import { TelegramFile, Folder, useFiles, useFolderTree, useUploadFileCover, useSetFileCoverFromFile, useDeleteFileCover } from '../lib/api';
import { useAppStore } from '../lib/store';

// Flatten the folder tree into a list with depth, for the folder picker
function flattenTree(nodes: Folder[] | undefined, depth = 0): { id: number; name: string; depth: number }[] {
    if (!nodes) return [];
    return nodes.flatMap(n => [{ id: n.id, name: n.name, depth }, ...flattenTree(n.children, depth + 1)]);
}

interface FileCoverModalProps {
    file: TelegramFile;
    onClose: () => void;
}

export default function FileCoverModal({ file, onClose }: FileCoverModalProps) {
    const { addToast } = useAppStore();
    const [activeTab, setActiveTab] = useState<'upload' | 'files'>('upload');
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [imagesOnly, setImagesOnly] = useState(true);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const uploadCover = useUploadFileCover();
    const setCoverFromFile = useSetFileCoverFromFile();
    const deleteCover = useDeleteFileCover();

    // Folder whose files are shown in the "Choose from Files" tab (any folder, or the root)
    const [browseFolderId, setBrowseFolderId] = useState<number | null>(file.folder_id);
    const { data: folderTree } = useFolderTree();
    const folderOptions = flattenTree(folderTree);

    const { data: browseData, isLoading: filesLoading } = useFiles(browseFolderId, undefined, undefined, 1);
    const candidates = (browseData?.files || []).filter(
        (f) => f.id !== file.id && (!imagesOnly || f.file_type === 'image')
    );

    const token = localStorage.getItem('access_token');
    const withToken = (url: string, updatedAt?: string) =>
        `${url}${url.includes('?') ? '&' : '?'}token=${token}${updatedAt ? `&v=${encodeURIComponent(updatedAt)}` : ''}`;

    const currentCoverUrl = file.thumbnail_url ? withToken(file.thumbnail_url, file.updated_at) : null;

    const handleFileChange = (picked: File | null) => {
        if (!picked) return;
        if (!picked.type.startsWith('image/')) {
            addToast('Please select a valid image file (JPEG, PNG, WEBP)', 'error');
            return;
        }
        if (picked.size > 10 * 1024 * 1024) {
            addToast('Image size must be under 10MB', 'error');
            return;
        }
        setSelectedFile(picked);
        setPreviewUrl(URL.createObjectURL(picked));
    };

    const handleDrop = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFileChange(e.dataTransfer.files[0]);
        }
    };

    const handleSaveUpload = async () => {
        if (!selectedFile) return;
        try {
            await uploadCover.mutateAsync({ fileId: file.id, image: selectedFile });
            addToast('File cover updated successfully!', 'success');
            onClose();
        } catch (err: any) {
            addToast(err?.response?.data?.detail || 'Failed to upload cover', 'error');
        }
    };

    const handleSelectExistingFile = async (sourceFileId: number) => {
        try {
            await setCoverFromFile.mutateAsync({ fileId: file.id, sourceFileId });
            addToast('File cover set!', 'success');
            onClose();
        } catch (err: any) {
            addToast(err?.response?.data?.detail || 'Failed to set cover from file', 'error');
        }
    };

    const handleResetCover = async () => {
        try {
            await deleteCover.mutateAsync(file.id);
            addToast('Cover reset to default', 'success');
            onClose();
        } catch (err: any) {
            addToast(err?.response?.data?.detail || 'Failed to reset cover', 'error');
        }
    };

    const isSubmitting = uploadCover.isPending || setCoverFromFile.isPending || deleteCover.isPending;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="glass-card w-full max-w-lg p-6 rounded-2xl shadow-2xl border border-white/10 animate-scale-in">
                {/* Header */}
                <div className="flex items-center justify-between pb-4 border-b border-white/[0.08]">
                    <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl bg-primary-500/10 border border-primary-500/20 flex items-center justify-center text-primary-400">
                            <ImageIcon className="w-5 h-5" />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-white">File Cover Image</h2>
                            <p className="text-xs text-dark-400 truncate max-w-xs">{file.file_name}</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={isSubmitting}
                        className="p-1.5 text-dark-400 hover:text-white rounded-lg hover:bg-white/[0.06] transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Current Cover Section */}
                {currentCoverUrl && (
                    <div className="my-4 p-3 rounded-xl bg-dark-900/60 border border-white/[0.06] flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="w-16 h-11 rounded-lg overflow-hidden bg-dark-800 border border-white/10 shrink-0">
                                <img src={currentCoverUrl} alt={file.file_name} className="w-full h-full object-cover" />
                            </div>
                            <div>
                                <p className="text-xs font-medium text-white">Current Cover</p>
                                <p className="text-[11px] text-dark-400">Reset to restore the original thumbnail</p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={handleResetCover}
                            disabled={isSubmitting}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-orange-400 hover:text-orange-300 hover:bg-orange-500/10 border border-orange-500/20 transition-all flex items-center gap-1.5"
                        >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Reset
                        </button>
                    </div>
                )}

                {/* Tabs */}
                <div className="flex gap-2 my-4 border-b border-white/[0.08] pb-2">
                    <button
                        type="button"
                        onClick={() => setActiveTab('upload')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${activeTab === 'upload'
                            ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/20'
                            : 'text-dark-400 hover:text-white hover:bg-white/[0.04]'
                            }`}
                    >
                        Upload Image
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('files')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${activeTab === 'files'
                            ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/20'
                            : 'text-dark-400 hover:text-white hover:bg-white/[0.04]'
                            }`}
                    >
                        Choose from Files
                    </button>
                </div>

                {/* Tab: Upload */}
                {activeTab === 'upload' && (
                    <div className="space-y-4">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                                if (e.target.files && e.target.files[0]) {
                                    handleFileChange(e.target.files[0]);
                                }
                            }}
                        />

                        {previewUrl ? (
                            <div className="relative rounded-xl overflow-hidden border border-white/10 aspect-video bg-dark-900 group">
                                <img src={previewUrl} alt="Cover preview" className="w-full h-full object-cover" />
                                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => fileInputRef.current?.click()}
                                        className="px-3 py-1.5 rounded-lg bg-dark-800/90 text-white text-xs hover:bg-dark-700 font-medium transition-colors"
                                    >
                                        Change Image
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setSelectedFile(null);
                                            setPreviewUrl(null);
                                        }}
                                        className="px-3 py-1.5 rounded-lg bg-red-600/80 text-white text-xs hover:bg-red-600 font-medium transition-colors"
                                    >
                                        Clear
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    setIsDragging(true);
                                }}
                                onDragLeave={() => setIsDragging(false)}
                                onDrop={handleDrop}
                                onClick={() => fileInputRef.current?.click()}
                                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-3 ${isDragging
                                    ? 'border-primary-500 bg-primary-500/10'
                                    : 'border-white/10 hover:border-primary-500/50 hover:bg-white/[0.02]'
                                    }`}
                            >
                                <div className="w-12 h-12 rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-dark-300">
                                    <Upload className="w-5 h-5 text-primary-400" />
                                </div>
                                <div>
                                    <p className="text-sm font-medium text-white">Click or drag & drop image here</p>
                                    <p className="text-xs text-dark-400 mt-0.5">Supports JPG, PNG, WEBP up to 10MB</p>
                                </div>
                            </div>
                        )}

                        <div className="flex justify-end gap-2.5 pt-2">
                            <button
                                type="button"
                                onClick={onClose}
                                disabled={isSubmitting}
                                className="px-4 py-2 text-xs font-medium text-dark-400 hover:text-white transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleSaveUpload}
                                disabled={!selectedFile || isSubmitting}
                                className="px-4 py-2 rounded-xl text-xs font-medium bg-primary-600 hover:bg-primary-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-lg shadow-primary-500/20 flex items-center gap-1.5"
                            >
                                {uploadCover.isPending ? (
                                    <>
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        Saving...
                                    </>
                                ) : (
                                    <>
                                        <Check className="w-3.5 h-3.5" />
                                        Save Cover
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                )}

                {/* Tab: Choose from files of any folder */}
                {activeTab === 'files' && (
                    <div className="space-y-4">
                        <div className="flex items-center gap-3">
                            <select
                                value={browseFolderId === null ? '' : String(browseFolderId)}
                                onChange={(e) => setBrowseFolderId(e.target.value === '' ? null : Number(e.target.value))}
                                className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-dark-900 border border-white/10 text-xs text-white focus:outline-none focus:border-primary-500/50"
                            >
                                <option value="">Root (No folder)</option>
                                {folderOptions.map((f) => (
                                    <option key={f.id} value={f.id}>
                                        {'\u00A0\u00A0'.repeat(f.depth)}{f.name}{f.id === file.folder_id ? ' (this folder)' : ''}
                                    </option>
                                ))}
                            </select>
                            <label className="flex items-center gap-1.5 text-xs text-dark-300 shrink-0 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={imagesOnly}
                                    onChange={(e) => setImagesOnly(e.target.checked)}
                                    className="accent-primary-500"
                                />
                                Images only
                            </label>
                        </div>

                        {filesLoading ? (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 className="w-6 h-6 animate-spin text-primary-400" />
                            </div>
                        ) : candidates.length === 0 ? (
                            <div className="py-10 text-center text-dark-400 text-xs">
                                No matching files in the selected folder. Pick another folder above, uncheck "Images only" or upload an image using the "Upload Image" tab.
                            </div>
                        ) : (
                            <div className="max-h-60 overflow-y-auto pr-1 grid grid-cols-2 gap-2.5">
                                {candidates.map((f) => {
                                    const thumbUrl = f.thumbnail_url ? withToken(f.thumbnail_url, f.updated_at) : null;

                                    return (
                                        <div
                                            key={f.id}
                                            onClick={() => !isSubmitting && handleSelectExistingFile(f.id)}
                                            className="p-2 rounded-xl bg-dark-900/60 hover:bg-primary-500/10 border border-white/[0.06] hover:border-primary-500/40 cursor-pointer transition-all flex items-center gap-2.5 group"
                                        >
                                            <div className="w-12 h-12 rounded-lg bg-dark-800 border border-white/10 overflow-hidden shrink-0 flex items-center justify-center">
                                                {thumbUrl ? (
                                                    <img
                                                        src={thumbUrl}
                                                        alt={f.file_name}
                                                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                                                    />
                                                ) : (
                                                    <Film className="w-5 h-5 text-dark-400" />
                                                )}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-xs font-medium text-white truncate group-hover:text-primary-300 transition-colors">
                                                    {f.file_name}
                                                </p>
                                                <p className="text-[10px] text-dark-400 capitalize">{f.file_type}</p>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        <div className="flex justify-end pt-2">
                            <button
                                type="button"
                                onClick={onClose}
                                disabled={isSubmitting}
                                className="px-4 py-2 text-xs font-medium text-dark-400 hover:text-white transition-colors"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}