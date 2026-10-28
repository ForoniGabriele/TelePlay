/**
 * FolderCoverModal - modal for setting or removing a folder's cover image
 */
import { useState, useRef, DragEvent } from 'react';
import { X, Upload, Image as ImageIcon, Trash2, Check, Film, Loader2 } from 'lucide-react';
import { Folder, useFiles, useUploadFolderCover, useSetFolderCoverFromFile, useDeleteFolderCover } from '../lib/api';
import { useAppStore } from '../lib/store';

interface FolderCoverModalProps {
    folder: Folder;
    onClose: () => void;
}

export default function FolderCoverModal({ folder, onClose }: FolderCoverModalProps) {
    const { addToast } = useAppStore();
    const [activeTab, setActiveTab] = useState<'upload' | 'files'>('upload');
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const uploadCover = useUploadFolderCover();
    const setCoverFromFile = useSetFolderCoverFromFile();
    const deleteCover = useDeleteFolderCover();

    // Fetch files in this folder so the user can easily pick one
    const { data: folderFilesData, isLoading: filesLoading } = useFiles(folder.id, undefined, undefined, 1);
    const folderFiles = folderFilesData?.files || [];

    // Current cover URL with token
    const token = localStorage.getItem('access_token');
    const currentCoverUrl = folder.cover_url
        ? `${folder.cover_url}${folder.cover_url.includes('?') ? '&' : '?'}token=${token}`
        : null;

    const handleFileChange = (file: File | null) => {
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            addToast('Please select a valid image file (JPEG, PNG, WEBP)', 'error');
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            addToast('Image size must be under 10MB', 'error');
            return;
        }

        setSelectedFile(file);
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
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
            await uploadCover.mutateAsync({
                folderId: folder.id,
                file: selectedFile,
            });
            addToast('Folder cover updated successfully!', 'success');
            onClose();
        } catch (err: any) {
            addToast(err?.response?.data?.detail || 'Failed to upload cover', 'error');
        }
    };

    const handleSelectExistingFile = async (fileId: number) => {
        try {
            await setCoverFromFile.mutateAsync({
                folderId: folder.id,
                fileId,
            });
            addToast('Folder cover set from file!', 'success');
            onClose();
        } catch (err: any) {
            addToast(err?.response?.data?.detail || 'Failed to set cover from file', 'error');
        }
    };

    const handleRemoveCover = async () => {
        try {
            await deleteCover.mutateAsync(folder.id);
            addToast('Folder cover removed', 'success');
            onClose();
        } catch (err: any) {
            addToast(err?.response?.data?.detail || 'Failed to remove cover', 'error');
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
                            <h2 className="text-base font-semibold text-white">Folder Cover Image</h2>
                            <p className="text-xs text-dark-400 truncate max-w-xs">{folder.name}</p>
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
                                <img
                                    src={currentCoverUrl}
                                    alt={folder.name}
                                    className="w-full h-full object-cover"
                                />
                            </div>
                            <div>
                                <p className="text-xs font-medium text-white">Current Cover</p>
                                <p className="text-[11px] text-dark-400">Active cover image</p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={handleRemoveCover}
                            disabled={isSubmitting}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/20 transition-all flex items-center gap-1.5"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Remove
                        </button>
                    </div>
                )}

                {/* Tabs */}
                <div className="flex gap-2 my-4 border-b border-white/[0.08] pb-2">
                    <button
                        type="button"
                        onClick={() => setActiveTab('upload')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                            activeTab === 'upload'
                                ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/20'
                                : 'text-dark-400 hover:text-white hover:bg-white/[0.04]'
                        }`}
                    >
                        Upload Image
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('files')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                            activeTab === 'files'
                                ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/20'
                                : 'text-dark-400 hover:text-white hover:bg-white/[0.04]'
                        }`}
                    >
                        Choose from Folder Files ({folderFiles.length})
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
                                <img
                                    src={previewUrl}
                                    alt="Cover preview"
                                    className="w-full h-full object-cover"
                                />
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
                                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-3 ${
                                    isDragging
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

                {/* Tab: Files in this folder */}
                {activeTab === 'files' && (
                    <div className="space-y-4">
                        {filesLoading ? (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 className="w-6 h-6 animate-spin text-primary-400" />
                            </div>
                        ) : folderFiles.length === 0 ? (
                            <div className="py-10 text-center text-dark-400 text-xs">
                                No files found in this folder. You can upload an image using the "Upload Image" tab.
                            </div>
                        ) : (
                            <div className="max-h-60 overflow-y-auto pr-1 grid grid-cols-2 gap-2.5">
                                {folderFiles.map((f) => {
                                    const thumbUrl = f.thumbnail_url
                                        ? `${f.thumbnail_url}${f.thumbnail_url.includes('?') ? '&' : '?'}token=${token}`
                                        : null;

                                    return (
                                        <div
                                            key={f.id}
                                            onClick={() => handleSelectExistingFile(f.id)}
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
