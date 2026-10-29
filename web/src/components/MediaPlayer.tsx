/**
 * MediaPlayer - full screen video/audio player
 * Video: uses MediaFox (canvas) to support multiple audio tracks
 * Audio: keeps the custom UI
 */
import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { X, Play, Pause, Volume2, VolumeX, Maximize, Minimize, SkipBack, SkipForward, Download, ExternalLink, AlertTriangle, Copy, PictureInPicture2, Gauge, ChevronDown, ChevronUp, Languages } from 'lucide-react';
import { useMediaFox } from '@mediafox/react';
import { TelegramFile, formatDuration, useUpdateProgress, useFile, api } from '../lib/api';
import { useAppStore } from '../lib/store';

export default function MediaPlayer() {
    const { previewFile: file, setPreviewFile, isPlayerMinimized, setPlayerMinimized } = useAppStore();

    if (!file) return null;

    return <MediaPlayerContent file={file} onClose={() => setPreviewFile(null)} isMinimized={isPlayerMinimized} setMinimized={setPlayerMinimized} />;
}

interface MediaPlayerContentProps {
    file: TelegramFile;
    onClose: () => void;
    isMinimized: boolean;
    setMinimized: (minimized: boolean) => void;
}

function MediaPlayerContent({ file, onClose, isMinimized, setMinimized }: MediaPlayerContentProps) {
    // --- Refs per MediaFox e audio nativo ---
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // --- Stato locale ---
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [playbackSpeed, setPlaybackSpeed] = useState(1);
    const [isPiP, setIsPiP] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const hideControlsTimeout = useRef<ReturnType<typeof setTimeout>>();
    const [publicUrl, setPublicUrl] = useState<string | null>(null);
    const resumeApplied = useRef(false);

    // --- File esteso e progressi ---
    const { data: extendedFile } = useFile(file.id);
    const { mutate: updateProgress } = useUpdateProgress();

    const isVideo = file.file_type === 'video';
    const token = localStorage.getItem('access_token');

    // --- URL ---
    const getAbsoluteUrl = (url: string) => {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        return `${window.location.origin}${url}`;
    };

    const relativeStreamUrl = `${file.stream_url}?token=${token}`;
    const authorizedStreamUrl = getAbsoluteUrl(relativeStreamUrl);
    const externalUrl = publicUrl || authorizedStreamUrl;
    const vlcUrl = `vlc://${externalUrl}`;
    const relativeThumbnailUrl = file.thumbnail_url ? `${file.thumbnail_url}?token=${token}` : null;
    const authorizedThumbnailUrl = relativeThumbnailUrl ? getAbsoluteUrl(relativeThumbnailUrl) : null;

    // --- MediaFox Hook (solo per video) ---
    const {
        player,
        state: foxState,
        load,
        play: foxPlay,
        pause: foxPause,
        seek: foxSeek,
    } = useMediaFox({
        renderTarget: canvasRef.current,
        volume: 1,
        onError: (err) => {
            console.error('MediaFox error:', err);
            setError("Browser cannot play this video format.");
            setIsLoading(false);
        },
    });

    // --- Sincronizza lo stato di MediaFox con lo stato locale ---
    useEffect(() => {
        if (!isVideo || !foxState) return;

        setCurrentTime(foxState.currentTime || 0);
        setDuration(foxState.duration || 0);
        setIsPlaying(foxState.playing || false);
        setIsLoading(!foxState.canPlay);

        // Applica la ripresa solo una volta quando i metadati sono pronti
        if (foxState.canPlay && !resumeApplied.current && extendedFile?.last_pos) {
            const totalDuration = extendedFile.duration || foxState.duration || 0;
            if (extendedFile.last_pos < totalDuration * 0.95) {
                foxSeek(extendedFile.last_pos);
                setCurrentTime(extendedFile.last_pos);
            }
            resumeApplied.current = true;
        }
    }, [foxState, isVideo, extendedFile, foxSeek]);

    // --- Carica il video in MediaFox ---
    useEffect(() => {
        if (isVideo && authorizedStreamUrl) {
            load(authorizedStreamUrl).catch((err) => {
                console.error('Load failed:', err);
                setError("Failed to load video.");
                setIsLoading(false);
            });
        }
    }, [isVideo, authorizedStreamUrl, load]);

    // --- Ripresa per audio (usa l'elemento audio nativo) ---
    useEffect(() => {
        if (isVideo) return;
        const el = audioRef.current;
        if (!el || resumeApplied.current || !extendedFile?.last_pos) return;
        if (el.readyState < 1) return;
        const totalDuration = extendedFile.duration || el.duration || 0;
        if (extendedFile.last_pos < totalDuration * 0.95) {
            el.currentTime = extendedFile.last_pos;
            setCurrentTime(extendedFile.last_pos);
        }
        resumeApplied.current = true;
    }, [extendedFile, isVideo]);

    // --- Reset flag di ripresa quando cambia file ---
    useEffect(() => {
        resumeApplied.current = false;
    }, [file.id]);

    // --- Salvataggio periodico dei progressi ---
    useEffect(() => {
        const interval = setInterval(() => {
            if (!isPlaying || error) return;
            if (isVideo && foxState) {
                updateProgress({
                    fileId: file.id,
                    position: Math.floor(foxState.currentTime || 0),
                    duration: foxState.duration || 0
                });
            } else if (!isVideo && audioRef.current) {
                updateProgress({
                    fileId: file.id,
                    position: Math.floor(audioRef.current.currentTime),
                    duration: audioRef.current.duration || 0
                });
            }
        }, 10000);

        return () => clearInterval(interval);
    }, [isPlaying, file.id, error, updateProgress, isVideo, foxState]);

    // --- Salvataggio alla chiusura ---
    const saveProgress = useCallback(() => {
        if (error) return;
        if (isVideo && foxState) {
            updateProgress({
                fileId: file.id,
                position: Math.floor(foxState.currentTime || 0),
                duration: foxState.duration || 0
            });
        } else if (!isVideo && audioRef.current) {
            updateProgress({
                fileId: file.id,
                position: Math.floor(audioRef.current.currentTime),
                duration: audioRef.current.duration || 0
            });
        }
    }, [file.id, error, updateProgress, isVideo, foxState]);

    useEffect(() => {
        return () => saveProgress();
    }, [saveProgress]);

    // --- Assicura il link pubblico ---
    useEffect(() => {
        const ensurePublicLink = async () => {
            const fileData = extendedFile || file;
            if (fileData.public_stream_url) {
                setPublicUrl(getAbsoluteUrl(fileData.public_stream_url));
            } else {
                try {
                    const { data } = await api.post<TelegramFile>(`/files/${file.id}/share`);
                    if (data.public_stream_url) {
                        setPublicUrl(getAbsoluteUrl(data.public_stream_url));
                    }
                } catch (err) {
                    console.error('Failed to create public link:', err);
                }
            }
        };
        ensurePublicLink();
    }, [file.id, extendedFile]);

    // --- Controlli Video (MediaFox) ---
    const togglePlayVideo = useCallback(() => {
        if (!isVideo || !player) return;
        if (foxState?.playing) {
            foxPause();
        } else {
            foxPlay();
        }
    }, [isVideo, player, foxState, foxPlay, foxPause]);

    const handleSkipVideo = useCallback((seconds: number) => {
        if (!isVideo || !foxState) return;
        const newTime = Math.max(0, Math.min(foxState.currentTime + seconds, foxState.duration));
        foxSeek(newTime);
        setCurrentTime(newTime);
    }, [isVideo, foxState, foxSeek]);

    const handleSeekVideo = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!isVideo || !player) return;
        const time = parseFloat(e.target.value);
        foxSeek(time);
        setCurrentTime(time);
    };

    // --- Controlli Audio (nativi) ---
    const togglePlayAudio = () => {
        const el = audioRef.current;
        if (!el) return;
        if (el.paused) {
            el.play().catch(() => { });
        } else {
            el.pause();
        }
    };

    const togglePlay = () => {
        if (isVideo) togglePlayVideo();
        else togglePlayAudio();
    };

    const handleSkip = (seconds: number) => {
        if (isVideo) handleSkipVideo(seconds);
        else if (audioRef.current) audioRef.current.currentTime += seconds;
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (isVideo) {
            handleSeekVideo(e);
        } else if (audioRef.current) {
            const time = parseFloat(e.target.value);
            audioRef.current.currentTime = time;
            setCurrentTime(time);
        }
    };

    const toggleMute = () => {
        if (isVideo && player) {
            // MediaFox gestisce il mute tramite il suo stato
            const newMuted = !isMuted;
            player.volume = newMuted ? 0 : volume;
            setIsMuted(newMuted);
        } else if (audioRef.current) {
            audioRef.current.muted = !isMuted;
            setIsMuted(!isMuted);
        }
    };

    const toggleFullscreen = () => {
        if (!document.fullscreenElement) {
            containerRef.current?.requestFullscreen();
            setIsFullscreen(true);
        } else {
            document.exitFullscreen();
            setIsFullscreen(false);
        }
    };

    const togglePiP = async () => {
        // PiP funziona solo con video. MediaFox usa canvas, PiP non è supportato direttamente.
        // Questa funzione è disabilitata per i video con MediaFox.
        console.warn('Picture-in-Picture is not supported with MediaFox canvas rendering.');
    };

    const cycleSpeed = () => {
        const speeds = [0.5, 1, 1.25, 1.5, 2];
        const currentIndex = speeds.indexOf(playbackSpeed);
        const nextSpeed = speeds[(currentIndex + 1) % speeds.length];
        setPlaybackSpeed(nextSpeed);
        if (isVideo && player) {
            player.playbackRate = nextSpeed;
        } else if (audioRef.current) {
            audioRef.current.playbackRate = nextSpeed;
        }
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const vol = parseFloat(e.target.value);
        setVolume(vol);
        setIsMuted(vol === 0);
        if (isVideo && player) {
            player.volume = vol;
        } else if (audioRef.current) {
            audioRef.current.volume = vol;
        }
    };

    // --- Cambio traccia audio (solo video) ---
    const audioTracks = useMemo(() => {
        if (!isVideo || !player) return [];
        try {
            return player.getAudioTracks() || [];
        } catch {
            return [];
        }
    }, [isVideo, player, foxState]); // foxState per forzare il ricalcolo quando le tracce cambiano

    const currentAudioTrackId = foxState?.selectedAudioTrack?.id;

    const handleAudioTrackChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
        if (!player) return;
        const trackId = e.target.value;
        try {
            await player.selectAudioTrack(trackId);
        } catch (err) {
            console.error('Failed to switch audio track:', err);
        }
    };

    // --- Eventi audio nativi ---
    const handleAudioPlay = () => setIsPlaying(true);
    const handleAudioPause = () => {
        setIsPlaying(false);
        saveProgress();
    };
    const handleAudioTimeUpdate = () => {
        if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
    };
    const handleAudioLoadedMetadata = () => {
        if (audioRef.current) {
            setDuration(audioRef.current.duration);
            setIsLoading(false);
        }
    };

    // --- Fullscreen sync ---
    useEffect(() => {
        const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onFsChange);
        return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

    // --- Scorciatoie da tastiera ---
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (error) return;
            switch (e.key) {
                case ' ':
                case 'k':
                    e.preventDefault();
                    togglePlay();
                    break;
                case 'ArrowLeft':
                case 'j':
                    e.preventDefault();
                    handleSkip(-10);
                    break;
                case 'ArrowRight':
                case 'l':
                    e.preventDefault();
                    handleSkip(10);
                    break;
                case 'm':
                    toggleMute();
                    break;
                case 'f':
                    toggleFullscreen();
                    break;
                case 'Escape':
                    if (document.fullscreenElement) {
                        document.exitFullscreen();
                    } else if (!isMinimized) {
                        onClose();
                    }
                    break;
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isFullscreen, onClose, error, isPlaying, isMinimized, isMuted, volume]);

    const handleMouseMove = () => {
        setShowControls(true);
        if (hideControlsTimeout.current) clearTimeout(hideControlsTimeout.current);
        hideControlsTimeout.current = setTimeout(() => {
            if (isPlaying && !isMinimized) setShowControls(false);
        }, 3000);
    };

    // --- Auto-play audio ---
    useEffect(() => {
        if (!isVideo && audioRef.current && !error) {
            audioRef.current.play().catch(() => { });
        }
    }, [error, file.id, isVideo]);

    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
    const overlayVisible = showControls || !isPlaying;

    // --- Rendering Media Element ---
    const VideoElement = (
        <canvas
            ref={canvasRef}
            className={`max-w-full max-h-full w-full h-full object-contain bg-black ${isMinimized ? 'hidden' : ''}`}
        />
    );

    const AudioElement = (
        <audio
            ref={audioRef}
            src={authorizedStreamUrl}
            onPlay={handleAudioPlay}
            onPause={handleAudioPause}
            onTimeUpdate={handleAudioTimeUpdate}
            onLoadedMetadata={handleAudioLoadedMetadata}
            onWaiting={() => setIsLoading(true)}
            onPlaying={() => setIsLoading(false)}
            onError={() => {
                setError("An error occurred while trying to play this audio.");
                setIsLoading(false);
            }}
        />
    );

    const MediaElement = isVideo ? VideoElement : AudioElement;

    // --- Render ---
    return (
        <div
            ref={containerRef}
            className={`fixed transition-all duration-300 ease-in-out z-[100] ${isMinimized
                    ? 'bottom-0 left-0 right-0 h-20 bg-dark-900 border-t border-white/10 shadow-2xl'
                    : 'inset-0 bg-black flex items-center justify-center font-sans'
                }`}
            onMouseMove={!isMinimized ? handleMouseMove : undefined}
            onDoubleClick={!isMinimized && !isVideo ? toggleFullscreen : undefined}
        >
            <div className={`w-full h-full ${isMinimized ? 'hidden' : 'flex items-center justify-center'}`}>
                {error ? (
                    <div className="text-center p-8 max-w-md glass-panel z-10 animate-scale-in">
                        <div className="w-16 h-16 rounded-2xl bg-yellow-500/20 flex items-center justify-center mx-auto mb-5 border border-yellow-500/30">
                            <AlertTriangle className="w-8 h-8 text-yellow-400" />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2">Playback Not Supported</h3>
                        <p className="text-dark-300 mb-6">{error}</p>
                        <div className="flex flex-col gap-3">
                            <a href={vlcUrl} className="btn-primary flex items-center justify-center gap-2">
                                <ExternalLink className="w-4 h-4" /> Open in VLC
                            </a>
                            <div className="flex gap-3">
                                <Button
                                    onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(externalUrl); }}
                                    className="flex-1 btn-secondary flex items-center justify-center gap-2"
                                >
                                    <Copy className="w-4 h-4" /> Copy URL
                                </Button>
                                <a
                                    href={externalUrl}
                                    download={file.file_name}
                                    className="flex-1 btn-secondary flex items-center justify-center gap-2"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <Download className="w-4 h-4" /> Download
                                </a>
                            </div>
                        </div>
                        <button onClick={onClose} className="mt-6 text-dark-400 hover:text-white text-sm transition-colors">
                            Close
                        </button>
                    </div>
                ) : (
                    <>
                        {!isVideo && !isMinimized && (
                            <div className="text-center z-10 glass-panel p-10 animate-scale-in absolute overflow-hidden">
                                {authorizedThumbnailUrl ? (
                                    <div className="w-64 h-64 mx-auto mb-6 rounded-2xl bg-dark-800 shadow-2xl overflow-hidden border border-white/10 relative group">
                                        <img
                                            src={authorizedThumbnailUrl}
                                            alt={file.file_name}
                                            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                                            onError={(e) => {
                                                e.currentTarget.style.display = 'none';
                                                e.currentTarget.parentElement?.classList.add('hidden');
                                            }}
                                        />
                                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex items-end justify-center pb-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <span className="text-white text-sm font-medium">Original Artwork</span>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="w-64 h-64 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-primary-500/20 to-pink-500/20 flex items-center justify-center border border-white/[0.08] shadow-2xl relative overflow-hidden group">
                                        <div className="absolute inset-0 bg-gradient-to-tr from-primary-500/10 to-transparent animate-pulse"></div>
                                        <span className="text-8xl transform transition-transform duration-500 group-hover:scale-125 drop-shadow-lg">🎵</span>
                                    </div>
                                )}
                                <p className="text-2xl font-bold text-white mb-2 drop-shadow-md">{file.file_name}</p>
                                <p className="text-primary-400 font-medium">{formatDuration(currentTime)} / {formatDuration(duration)}</p>
                            </div>
                        )}

                        {MediaElement}

                        {isLoading && !error && !isMinimized && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                                <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary-500"></div>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Controlli minimizzati */}
            {isMinimized && (
                <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 p-3 h-full">
                    <div className="flex items-center gap-3 overflow-hidden flex-1 cursor-pointer" onClick={() => setMinimized(false)}>
                        <div className="w-12 h-12 rounded-lg bg-dark-800 flex items-center justify-center flex-shrink-0 overflow-hidden border border-white/5 relative">
                            {authorizedThumbnailUrl ? (
                                <img src={authorizedThumbnailUrl} alt="Thumb" className="w-full h-full object-cover" />
                            ) : (
                                isVideo ? <span className="text-2xl">🎬</span> : <span className="text-2xl">🎵</span>
                            )}
                        </div>
                        <div className="truncate flex-1 min-w-0">
                            <h4 className="text-sm font-bold text-white truncate leading-tight">{file.file_name}</h4>
                            <p className="text-xs text-dark-400 font-mono">{formatDuration(currentTime)} / {formatDuration(duration)}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(-10); }} className="p-2 text-dark-300 hover:text-white">
                            <SkipBack className="w-5 h-5" />
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                            className="p-2 bg-primary-600 rounded-full text-white hover:bg-primary-500 shadow-lg shadow-primary-500/20"
                        >
                            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(10); }} className="p-2 text-dark-300 hover:text-white">
                            <SkipForward className="w-5 h-5" />
                        </button>
                    </div>
                    <div className="flex items-center gap-2 border-l border-white/10 pl-4">
                        <button onClick={() => setMinimized(false)} className="p-2 text-dark-400 hover:text-white" title="Maximize">
                            <ChevronUp className="w-5 h-5" />
                        </button>
                        <button onClick={onClose} className="p-2 text-dark-400 hover:text-red-400" title="Close">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    <div className="absolute top-0 left-0 right-0 h-0.5 bg-dark-800">
                        <div className="h-full bg-primary-500" style={{ width: `${progressPercent}%` }}></div>
                    </div>
                </div>
            )}

            {/* Overlay controlli completi */}
            {!error && !isMinimized && (
                <div
                    className={`absolute inset-0 transition-opacity duration-300 ${overlayVisible ? 'opacity-100' : 'opacity-0'} ${!isVideo && !overlayVisible ? 'cursor-none' : ''}`}
                    style={{ pointerEvents: isVideo ? 'none' : (overlayVisible ? 'auto' : 'none') }}
                >
                    {/* Top bar */}
                    <div
                        className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/80 to-transparent flex items-start justify-between z-30"
                        style={{ pointerEvents: overlayVisible ? 'auto' : 'none' }}
                    >
                        <div>
                            <h3 className="text-lg font-medium truncate max-w-lg text-white">{file.file_name}</h3>
                            {((extendedFile?.last_pos || 0) > 0) && currentTime < 5 && (
                                <p className="text-xs text-primary-400">Resumed from {formatDuration(extendedFile?.last_pos || 0)}</p>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <button onClick={() => setMinimized(true)} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors" title="Minimize">
                                <ChevronDown className="w-6 h-6" />
                            </button>
                            <button onClick={onClose} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors">
                                <X className="w-6 h-6" />
                            </button>
                        </div>
                    </div>

                    {/* Controlli personalizzati per audio */}
                    {!isVideo && (
                        <>
                            <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex items-center gap-8 z-30">
                                <button onClick={(e) => { e.stopPropagation(); handleSkip(-10); }} className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all">
                                    <SkipBack className="w-8 h-8" />
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="w-20 h-20 bg-white/20 backdrop-blur rounded-full flex items-center justify-center hover:bg-white/30 transition-all scale-100 hover:scale-105">
                                    {isPlaying ? <Pause className="w-10 h-10 text-white" /> : <Play className="w-10 h-10 ml-1 text-white" />}
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); handleSkip(10); }} className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all">
                                    <SkipForward className="w-8 h-8" />
                                </button>
                            </div>
                            <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/95 via-black/70 to-transparent z-30">
                                <div className="flex items-center gap-4 mb-4 group/progress">
                                    <span className="text-sm font-medium text-white/90 min-w-[50px] font-mono">{formatDuration(Math.floor(currentTime))}</span>
                                    <div className="relative flex-1 h-1 bg-white/20 rounded-full cursor-pointer group-hover/progress:h-2 transition-all">
                                        <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary-500 to-primary-400 rounded-full transition-all" style={{ width: `${progressPercent}%` }}>
                                            <div className="absolute right-0 top-1/2 transform -translate-y-1/2 w-4 h-4 bg-white rounded-full opacity-0 group-hover/progress:opacity-100 transition-all shadow-lg shadow-primary-500/50 scale-75 group-hover/progress:scale-100"></div>
                                        </div>
                                        <input type="range" min={0} max={duration || 100} value={currentTime} onChange={handleSeek} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                                    </div>
                                    <span className="text-sm font-medium text-white/90 min-w-[50px] text-right font-mono">{formatDuration(Math.floor(duration))}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <button onClick={togglePlay} className="p-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all hover:scale-105">
                                            {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
                                        </button>
                                        <div className="flex items-center gap-2 group/vol">
                                            <button onClick={toggleMute} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all">
                                                {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                                            </button>
                                            <div className="w-0 overflow-hidden group-hover/vol:w-24 transition-all duration-300">
                                                <input type="range" min={0} max={1} step={0.05} value={isMuted ? 0 : volume} onChange={handleVolumeChange} className="w-20 h-1 bg-white/30 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-lg" />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button onClick={cycleSpeed} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${playbackSpeed !== 1 ? 'bg-primary-500/30 text-primary-300 border border-primary-500/40' : 'bg-white/10 text-white/80 border border-white/10 hover:bg-white/20 hover:text-white'}`} title="Playback Speed">
                                            <Gauge className="w-4 h-4" />
                                            <span>{playbackSpeed}x</span>
                                        </button>
                                        <button onClick={toggleFullscreen} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all" title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}>
                                            {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* Controlli personalizzati per video (MediaFox) - Overlay separato con pointer events */}
            {isVideo && !error && !isMinimized && (
                <div
                    className={`absolute inset-0 transition-opacity duration-300 ${overlayVisible ? 'opacity-100' : 'opacity-0'}`}
                >
                    <div
                        className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/80 to-transparent flex items-start justify-between z-30"
                        style={{ pointerEvents: overlayVisible ? 'auto' : 'none' }}
                    >
                        <div>
                            <h3 className="text-lg font-medium truncate max-w-lg text-white">{file.file_name}</h3>
                            {((extendedFile?.last_pos || 0) > 0) && currentTime < 5 && (
                                <p className="text-xs text-primary-400">Resumed from {formatDuration(extendedFile?.last_pos || 0)}</p>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <button onClick={() => setMinimized(true)} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors" title="Minimize">
                                <ChevronDown className="w-6 h-6" />
                            </button>
                            <button onClick={onClose} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors">
                                <X className="w-6 h-6" />
                            </button>
                        </div>
                    </div>

                    <div
                        className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex items-center gap-8 z-30"
                        style={{ pointerEvents: overlayVisible ? 'auto' : 'none' }}
                    >
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(-10); }} className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all">
                            <SkipBack className="w-8 h-8" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="w-20 h-20 bg-white/20 backdrop-blur rounded-full flex items-center justify-center hover:bg-white/30 transition-all scale-100 hover:scale-105">
                            {isPlaying ? <Pause className="w-10 h-10 text-white" /> : <Play className="w-10 h-10 ml-1 text-white" />}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(10); }} className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all">
                            <SkipForward className="w-8 h-8" />
                        </button>
                    </div>

                    <div
                        className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/95 via-black/70 to-transparent z-30"
                        style={{ pointerEvents: overlayVisible ? 'auto' : 'none' }}
                    >
                        <div className="flex items-center gap-4 mb-4 group/progress">
                            <span className="text-sm font-medium text-white/90 min-w-[50px] font-mono">{formatDuration(Math.floor(currentTime))}</span>
                            <div className="relative flex-1 h-1 bg-white/20 rounded-full cursor-pointer group-hover/progress:h-2 transition-all">
                                <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary-500 to-primary-400 rounded-full transition-all" style={{ width: `${progressPercent}%` }}>
                                    <div className="absolute right-0 top-1/2 transform -translate-y-1/2 w-4 h-4 bg-white rounded-full opacity-0 group-hover/progress:opacity-100 transition-all shadow-lg shadow-primary-500/50 scale-75 group-hover/progress:scale-100"></div>
                                </div>
                                <input type="range" min={0} max={duration || 100} value={currentTime} onChange={handleSeek} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                            </div>
                            <span className="text-sm font-medium text-white/90 min-w-[50px] text-right font-mono">{formatDuration(Math.floor(duration))}</span>
                        </div>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <button onClick={togglePlay} className="p-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all hover:scale-105">
                                    {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
                                </button>
                                <div className="flex items-center gap-2 group/vol">
                                    <button onClick={toggleMute} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all">
                                        {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                                    </button>
                                    <div className="w-0 overflow-hidden group-hover/vol:w-24 transition-all duration-300">
                                        <input type="range" min={0} max={1} step={0.05} value={isMuted ? 0 : volume} onChange={handleVolumeChange} className="w-20 h-1 bg-white/30 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-lg" />
                                    </div>
                                </div>
                                {/* Selettore traccia audio */}
                                {audioTracks.length > 1 && (
                                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 border border-white/10">
                                        <Languages className="w-4 h-4 text-white/70" />
                                        <select
                                            value={currentAudioTrackId || ''}
                                            onChange={handleAudioTrackChange}
                                            className="bg-transparent text-sm text-white/90 focus:outline-none cursor-pointer"
                                        >
                                            {audioTracks.map((track, index) => (
                                                <option key={track.id || index} value={track.id || index} className="bg-dark-800 text-white">
                                                    {track.language || track.label || `Traccia ${index + 1}`}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <button onClick={cycleSpeed} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${playbackSpeed !== 1 ? 'bg-primary-500/30 text-primary-300 border border-primary-500/40' : 'bg-white/10 text-white/80 border border-white/10 hover:bg-white/20 hover:text-white'}`} title="Playback Speed">
                                    <Gauge className="w-4 h-4" />
                                    <span>{playbackSpeed}x</span>
                                </button>
                                <button onClick={toggleFullscreen} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all" title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}>
                                    {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Helper button component
function Button({ onClick, className, children }: { onClick?: (e: any) => void, className?: string, children: React.ReactNode }) {
    return (
        <button onClick={onClick} className={className}>
            {children}
        </button>
    );
}