/**
 * MediaPlayer - full screen video/audio player
 * Video:
 *   - DEFAULTS to the advanced MediaFox player (canvas + Web Audio) for seamless MKV and multi-track audio.
 *   - Allows instant switching to native browser <video> player if desired.
 *   - Subtitles: fast EBML header probing (< 200ms) with progressive cluster extraction (2MB chunks)
 *     and IndexedDB caching so subtitles appear in ~1s without freezing or hammering the backend.
 *   - "Apri in VLC" button prominently provided in top bar and fallback screen.
 * Audio: keeps custom UI.
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import {
    X, Play, Pause, Volume2, VolumeX, Maximize, Minimize, SkipBack, SkipForward,
    ExternalLink, AlertTriangle, Copy, Gauge, ChevronDown, ChevronUp, Languages,
    Check, MonitorPlay, Subtitles, SlidersHorizontal
} from 'lucide-react';
import { TelegramFile, formatDuration, useUpdateProgress, useFile, api } from '../lib/api';
import { useAppStore } from '../lib/store';
import {
    probeMkvSubtitleTracks,
    extractMkvSubtitleCues,
    getCachedSubtitles,
    saveCachedSubtitles,
    SubtitleCue,
    SubtitleTrackOption,
    MkvFileInfo
} from '../lib/mkvSubtitles';

function describeTrack(track: any, index: number): string {
    const name = track?.name || track?.label || track?.title;
    const lang = track?.language || track?.lang || track?.languageCode;
    const parts = [name, lang && lang !== 'und' ? String(lang).toUpperCase() : null].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : `Track ${index + 1}`;
}

export default function MediaPlayer() {
    const { previewFile: file, setPreviewFile, isPlayerMinimized, setPlayerMinimized } = useAppStore();
    if (!file) return null;
    return (
        <MediaPlayerContent
            file={file}
            onClose={() => setPreviewFile(null)}
            isMinimized={isPlayerMinimized}
            setMinimized={setPlayerMinimized}
        />
    );
}

interface MediaPlayerContentProps {
    file: TelegramFile;
    onClose: () => void;
    isMinimized: boolean;
    setMinimized: (minimized: boolean) => void;
}

function MediaPlayerContent({ file, onClose, isMinimized, setMinimized }: MediaPlayerContentProps) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const playerRef = useRef<any>(null); // MediaFox instance
    const advTime = useRef(0);
    const advDuration = useRef(0);

    const isVideo = file.file_type === 'video';

    // Player Mode: ALWAYS defaults to 'advanced' as requested by the user
    const [playerMode, setPlayerMode] = useState<'advanced' | 'native'>('advanced');

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [playbackSpeed, setPlaybackSpeed] = useState(1);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const hideControlsTimeout = useRef<ReturnType<typeof setTimeout>>();
    const [publicUrl, setPublicUrl] = useState<string | null>(null);
    const resumeApplied = useRef(false);

    // ---- Audio tracks (MediaFox) ----
    const [audioTracks, setAudioTracks] = useState<any[]>([]);
    const [selectedAudio, setSelectedAudio] = useState<number | string | null>(null);
    const [showAudioMenu, setShowAudioMenu] = useState(false);

    // ---- Subtitle tracks ----
    const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackOption[]>([]);
    const [selectedSubtitle, setSelectedSubtitle] = useState<number | string | null>(null);
    const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
    const [isProbingSubs, setIsProbingSubs] = useState(false);
    const [isExtractingSubs, setIsExtractingSubs] = useState(false);
    const subtitleCuesRef = useRef<SubtitleCue[]>([]);
    const subtitleCacheRef = useRef<Map<number | string, SubtitleCue[]>>(new Map());
    const mkvInfoRef = useRef<MkvFileInfo | null>(null);
    const abortExtractorRef = useRef<AbortController | null>(null);
    const [, setCueUpdateTick] = useState(0); // Trigger re-render when new cues are discovered

    const { data: extendedFile } = useFile(file.id);
    const { mutate: updateProgress } = useUpdateProgress();

    const token = localStorage.getItem('access_token');
    const getAbsoluteUrl = (url: string) => !url ? '' : url.startsWith('http') ? url : `${window.location.origin}${url}`;
    const relativeStreamUrl = `${file.stream_url}?token=${token}`;
    const authorizedStreamUrl = getAbsoluteUrl(relativeStreamUrl);
    const externalUrl = publicUrl || authorizedStreamUrl;

    // VLC Protocol URL
    const vlcUrl = `vlc://${externalUrl}`;

    const relativeThumbnailUrl = file.thumbnail_url ? `${file.thumbnail_url}?token=${token}` : null;
    const authorizedThumbnailUrl = relativeThumbnailUrl ? getAbsoluteUrl(relativeThumbnailUrl) : null;

    // Ensure public link exists for VLC and external tools
    useEffect(() => {
        const ensurePublicLink = async () => {
            const fileData = extendedFile || file;
            if (fileData.public_stream_url) {
                setPublicUrl(getAbsoluteUrl(fileData.public_stream_url));
            } else {
                try {
                    const { data } = await api.post<TelegramFile>(`/files/${file.id}/share`);
                    if (data.public_stream_url) setPublicUrl(getAbsoluteUrl(data.public_stream_url));
                } catch (err) {
                    console.error('Failed to create public link:', err);
                }
            }
        };
        ensurePublicLink();
    }, [file.id, extendedFile]);

    useEffect(() => {
        resumeApplied.current = false;
    }, [file.id]);

    const snapshotProgress = useCallback(() => {
        if (isVideo && playerMode === 'advanced') {
            return { position: advTime.current, duration: advDuration.current || undefined };
        }
        const el = isVideo ? videoRef.current : audioRef.current;
        if (!el) return null;
        return { position: el.currentTime, duration: el.duration };
    }, [isVideo, playerMode]);

    const saveProgress = useCallback(() => {
        if (error) return;
        const snap = snapshotProgress();
        if (!snap) return;
        updateProgress({ fileId: file.id, position: Math.floor(snap.position), duration: snap.duration });
    }, [file.id, error, updateProgress, snapshotProgress]);

    const saveProgressRef = useRef(saveProgress);
    saveProgressRef.current = saveProgress;

    useEffect(() => {
        const interval = setInterval(() => {
            if (isPlaying && !error) saveProgressRef.current();
        }, 10000);
        return () => clearInterval(interval);
    }, [isPlaying, error]);

    useEffect(() => () => saveProgress(), [saveProgress]);

    // Native HTML5 media event handlers
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => { setIsPlaying(false); saveProgress(); };
    const handleTimeUpdate = () => {
        const el = isVideo ? videoRef.current : audioRef.current;
        if (el) setCurrentTime(el.currentTime);
    };
    const handleLoadedMetadata = () => {
        const el = isVideo ? videoRef.current : audioRef.current;
        if (el) {
            setDuration(el.duration);
            setIsLoading(false);
            if (!resumeApplied.current && extendedFile?.last_pos) {
                const totalDuration = extendedFile.duration || el.duration || 0;
                if (extendedFile.last_pos < totalDuration * 0.95) {
                    el.currentTime = extendedFile.last_pos;
                    setCurrentTime(extendedFile.last_pos);
                }
                resumeApplied.current = true;
            }
        }
    };
    const handleWaiting = () => setIsLoading(true);
    const handlePlaying = () => setIsLoading(false);
    const handleError = () => {
        const el = isVideo ? videoRef.current : audioRef.current;
        if (el?.error) {
            setError("Impossibile riprodurre questo file nel player nativo. Prova il Player Avanzato o VLC.");
            setIsLoading(false);
        }
    };

    // Controls
    const togglePlay = (e?: any) => {
        e?.stopPropagation();
        if (isVideo && playerMode === 'advanced') {
            const p = playerRef.current;
            if (p) {
                isPlaying ? p.pause() : Promise.resolve(p.play()).catch(() => { });
                return;
            }
        }
        const el = isVideo ? videoRef.current : audioRef.current;
        if (el) {
            el.paused ? el.play().catch(() => { }) : el.pause();
        }
    };

    const toggleMute = () => {
        if (isVideo && playerMode === 'advanced') {
            const p = playerRef.current;
            if (p) {
                p.volume = isMuted ? (volume || 1) : 0;
                setIsMuted(!isMuted);
                return;
            }
        }
        const el = isVideo ? videoRef.current : audioRef.current;
        if (el) {
            el.muted = !isMuted;
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

    const cycleSpeed = () => {
        const speeds = [0.5, 1, 1.25, 1.5, 2];
        const nextSpeed = speeds[(speeds.indexOf(playbackSpeed) + 1) % speeds.length];
        setPlaybackSpeed(nextSpeed);
        if (isVideo && playerMode === 'advanced' && playerRef.current) {
            playerRef.current.playbackRate = nextSpeed;
        } else {
            const el = isVideo ? videoRef.current : audioRef.current;
            if (el) el.playbackRate = nextSpeed;
        }
    };

    const handleSkip = (seconds: number) => {
        if (isVideo && playerMode === 'advanced') {
            const p = playerRef.current;
            if (p) {
                const target = Math.max(0, advTime.current + seconds);
                Promise.resolve(p.seek(target)).catch(() => { });
                setCurrentTime(target);
                return;
            }
        }
        const el = isVideo ? videoRef.current : audioRef.current;
        if (el) el.currentTime += seconds;
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const time = parseFloat(e.target.value);
        if (isVideo && playerMode === 'advanced') {
            const p = playerRef.current;
            if (p) {
                Promise.resolve(p.seek(time)).catch(() => { });
                setCurrentTime(time);
                return;
            }
        }
        const el = isVideo ? videoRef.current : audioRef.current;
        if (el) {
            el.currentTime = time;
            setCurrentTime(time);
        }
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const vol = parseFloat(e.target.value);
        if (isVideo && playerMode === 'advanced') {
            if (playerRef.current) playerRef.current.volume = vol;
        } else {
            const el = isVideo ? videoRef.current : audioRef.current;
            if (el) el.volume = vol;
        }
        setVolume(vol);
        setIsMuted(vol === 0);
    };

    const selectAudioTrack = async (id: number | string) => {
        const p = playerRef.current;
        if (!p) return;
        try {
            await p.selectAudioTrack(id);
            setSelectedAudio(id);
        } catch (err) {
            console.error('Failed to switch audio track:', err);
        }
        setShowAudioMenu(false);
    };

    // Toggle player mode (advanced default vs native fallback)
    const togglePlayerMode = () => {
        const targetPos = currentTime;
        saveProgress();
        setPlayerMode((prev) => (prev === 'advanced' ? 'native' : 'advanced'));
        setError(null);
        // Position will be restored in the respective player effect
        setTimeout(() => {
            if (targetPos > 0) {
                if (playerRef.current) playerRef.current.seek(targetPos);
                if (videoRef.current) videoRef.current.currentTime = targetPos;
            }
        }, 300);
    };

    // ---- Subtitle Probe (< 200ms) & Progressive Extraction ----
    useEffect(() => {
        if (!isVideo) return;
        let cancelled = false;

        const initSubtitles = async () => {
            setIsProbingSubs(true);
            try {
                // Check IndexedDB cache first
                const cached = await getCachedSubtitles(file.id);
                if (cancelled) return;

                if (cached && cached.tracks.length > 0) {
                    setSubtitleTracks(cached.tracks);
                    Object.entries(cached.cues).forEach(([tId, cues]) => {
                        subtitleCacheRef.current.set(Number(tId) || tId, cues);
                    });
                    setIsProbingSubs(false);
                    return;
                }

                // Fast probe of MKV header
                const { tracks, info } = await probeMkvSubtitleTracks(authorizedStreamUrl);
                if (cancelled) return;

                mkvInfoRef.current = info;
                setSubtitleTracks(tracks);
            } catch (err) {
                console.warn('Subtitle probe failed:', err);
            } finally {
                if (!cancelled) setIsProbingSubs(false);
            }
        };

        initSubtitles();
        return () => {
            cancelled = true;
            abortExtractorRef.current?.abort();
        };
    }, [isVideo, file.id, authorizedStreamUrl]);

    // Handle subtitle track selection and extraction
    const selectSubtitleTrack = async (trackId: number | string | null) => {
        setShowSubtitleMenu(false);
        if (trackId === null) {
            setSelectedSubtitle(null);
            subtitleCuesRef.current = [];
            setCueUpdateTick((t) => t + 1);
            return;
        }

        setSelectedSubtitle(trackId);

        // Check if already in memory
        const cachedCues = subtitleCacheRef.current.get(trackId);
        if (cachedCues && cachedCues.length > 0) {
            subtitleCuesRef.current = cachedCues;
            setCueUpdateTick((t) => t + 1);
            return;
        }

        const track = subtitleTracks.find((t) => t.id === trackId);
        if (!track || !mkvInfoRef.current) return;

        // Abort previous extraction if any
        abortExtractorRef.current?.abort();
        const controller = new AbortController();
        abortExtractorRef.current = controller;

        setIsExtractingSubs(true);

        try {
            await extractMkvSubtitleCues(
                authorizedStreamUrl,
                track,
                mkvInfoRef.current,
                (cues) => {
                    subtitleCacheRef.current.set(trackId, cues);
                    subtitleCuesRef.current = cues;
                    setCueUpdateTick((t) => t + 1);
                },
                controller.signal
            );

            // Save to IndexedDB
            const allCached: Record<string, SubtitleCue[]> = {};
            subtitleCacheRef.current.forEach((c, k) => {
                allCached[String(k)] = c;
            });
            saveCachedSubtitles(file.id, { tracks: subtitleTracks, cues: allCached });
        } catch (err: any) {
            if (err?.name !== 'AbortError') {
                console.error('Subtitle extraction error:', err);
            }
        } finally {
            setIsExtractingSubs(false);
        }
    };

    // Calculate active subtitle text for HTML overlay
    const activeSubtitleText = (() => {
        if (selectedSubtitle === null) return '';
        const cues = subtitleCuesRef.current;
        if (!cues || cues.length === 0) return '';
        const active = cues.filter((c) => currentTime >= c.start && currentTime <= c.end);
        if (active.length === 0) return '';
        return active.map((c) => c.text).join('\n');
    })();

    // Inizializzazione MediaFox (Player Avanzato)
    useEffect(() => {
        if (!isVideo || playerMode !== 'advanced' || !canvasRef.current) return;

        let cancelled = false;
        let player: any = null;
        const unsubscribers: Array<() => void> = [];

        setIsLoading(true);
        setError(null);
        advTime.current = 0;

        (async () => {
            try {
                const { MediaFox } = await import('@mediafox/core');
                if (cancelled || !canvasRef.current) return;

                player = new MediaFox({ renderTarget: canvasRef.current, volume: isMuted ? 0 : volume });
                playerRef.current = player;

                let wasPlaying = false;
                const unsubscribe = player.subscribe((s: any) => {
                    const playing = !!(s.playing ?? s.state === 'playing');
                    advTime.current = s.currentTime ?? advTime.current;
                    setCurrentTime(advTime.current);
                    if (s.duration) {
                        advDuration.current = s.duration;
                        setDuration(s.duration);
                    }
                    setIsPlaying(playing);
                    if (wasPlaying && !playing) saveProgressRef.current();
                    wasPlaying = playing;
                });
                if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);

                player.on?.('error', () => {
                    if (cancelled) return;
                    setError('Il player avanzato non è riuscito a riprodurre questo file. Prova con il Player Nativo o VLC.');
                    setIsLoading(false);
                });

                await player.load(authorizedStreamUrl);
                if (cancelled) return;

                const tracks: any[] = player.getAudioTracks?.() ?? [];
                setAudioTracks(tracks.map((t, i) => ({ id: t.id, label: describeTrack(t, i) })));
                setSelectedAudio(tracks[0]?.id ?? null);

                const start = extendedFile?.last_pos ?? 0;
                if (start > 1) await player.seek(start);
                if (cancelled) return;

                setIsLoading(false);
                await player.play();
            } catch (err) {
                console.error('Advanced player failed:', err);
                if (!cancelled) {
                    setError('Impossibile caricare il file nel player avanzato. Prova con il Player Nativo o VLC.');
                    setIsLoading(false);
                }
            }
        })();

        return () => {
            cancelled = true;
            unsubscribers.forEach((u) => u());
            try {
                const dispose = player?.dispose ?? player?.destroy;
                dispose?.call(player);
            } catch { }
            playerRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVideo, playerMode, file.id]);

    useEffect(() => {
        const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onFsChange);
        return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

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
                case 's':
                case 'c':
                    // Toggle subtitles
                    if (subtitleTracks.length > 0) {
                        if (selectedSubtitle === null) {
                            selectSubtitleTrack(subtitleTracks[0].id);
                        } else {
                            selectSubtitleTrack(null);
                        }
                    }
                    break;
                case 'v':
                    // Open in VLC shortcut
                    if (externalUrl) window.location.href = vlcUrl;
                    break;
                case 'Escape':
                    if (document.fullscreenElement) document.exitFullscreen();
                    else if (!isMinimized) onClose();
                    break;
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isFullscreen, onClose, error, isPlaying, isMinimized, isMuted, selectedSubtitle, subtitleTracks]);

    const handleMouseMove = () => {
        setShowControls(true);
        if (hideControlsTimeout.current) clearTimeout(hideControlsTimeout.current);
        hideControlsTimeout.current = setTimeout(() => {
            if (isPlaying && !isMinimized) setShowControls(false);
        }, 3000);
    };

    useEffect(() => {
        if (!isVideo && audioRef.current && !error) audioRef.current.play().catch(() => { });
    }, [error, file.id, isVideo]);

    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

    const MediaElement = isVideo ? (
        playerMode === 'advanced' ? (
            <canvas
                ref={canvasRef}
                onClick={togglePlay}
                className={`max-w-full max-h-full w-full h-full object-contain bg-black ${isMinimized ? 'hidden' : ''}`}
            />
        ) : (
            <video
                ref={videoRef}
                src={authorizedStreamUrl}
                onClick={togglePlay}
                onPlay={handlePlay}
                onPause={handlePause}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onWaiting={handleWaiting}
                onPlaying={handlePlaying}
                onError={handleError}
                playsInline
                className={`max-w-full max-h-full w-full h-full object-contain bg-black ${isMinimized ? 'hidden' : ''}`}
            />
        )
    ) : (
        <audio
            ref={audioRef}
            src={authorizedStreamUrl}
            onPlay={handlePlay}
            onPause={handlePause}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onWaiting={handleWaiting}
            onPlaying={handlePlaying}
            onError={handleError}
        />
    );

    const overlayVisible = showControls || !isPlaying;

    return (
        <div
            ref={containerRef}
            className={`fixed transition-all duration-300 ease-in-out z-[100] ${isMinimized ? 'bottom-0 left-0 right-0 h-20 bg-dark-900 border-t border-white/10 shadow-2xl' : 'inset-0 bg-black flex items-center justify-center font-sans'}`}
            onMouseMove={!isMinimized ? handleMouseMove : undefined}
            onDoubleClick={!isMinimized ? toggleFullscreen : undefined}
        >
            <div className={`w-full h-full ${isMinimized ? 'hidden' : 'flex items-center justify-center relative overflow-hidden'}`}>
                {error ? (
                    <div className="text-center p-8 max-w-md glass-panel z-10 animate-scale-in">
                        <div className="w-16 h-16 rounded-2xl bg-yellow-500/20 flex items-center justify-center mx-auto mb-5 border border-yellow-500/30">
                            <AlertTriangle className="w-8 h-8 text-yellow-400" />
                        </div>
                        <h3 className="text-xl font-bold text-white mb-2">Riproduzione Non Supportata</h3>
                        <p className="text-dark-300 mb-6">{error}</p>
                        <div className="flex flex-col gap-3">
                            <a
                                href={vlcUrl}
                                className="btn-primary flex items-center justify-center gap-2 bg-primary-600 hover:bg-primary-500"
                            >
                                <MonitorPlay className="w-5 h-5" />
                                Apri in VLC
                            </a>
                            {isVideo && (
                                <button
                                    onClick={togglePlayerMode}
                                    className="btn-secondary flex items-center justify-center gap-2"
                                >
                                    <SlidersHorizontal className="w-4 h-4" />
                                    Passa al Player {playerMode === 'advanced' ? 'Nativo' : 'Avanzato'}
                                </button>
                            )}
                            <a href={externalUrl} className="btn-secondary flex items-center justify-center gap-2">
                                <ExternalLink className="w-4 h-4" />
                                Apri URL Diretto
                            </a>
                            <div className="flex gap-3 mt-1">
                                <Button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        navigator.clipboard.writeText(externalUrl);
                                    }}
                                    className="flex-1 btn-secondary flex items-center justify-center gap-2"
                                >
                                    <Copy className="w-4 h-4" />
                                    Copia URL
                                </Button>
                            </div>
                        </div>
                        <button onClick={onClose} className="mt-6 text-dark-400 hover:text-white text-sm transition-colors">
                            Chiudi
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
                                            <span className="text-white text-sm font-medium">Artwork</span>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="w-64 h-64 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-primary-500/20 to-pink-500/20 flex items-center justify-center border border-white/[0.08] shadow-2xl relative overflow-hidden group">
                                        <div className="absolute inset-0 bg-gradient-to-tr from-primary-500/10 to-transparent animate-pulse"></div>
                                        <span className="text-8xl transform transition-transform duration-500 group-hover:scale-125 drop-shadow-lg">🎵</span>
                                    </div>
                                )}
                                <p className="text-2xl font-bold text-white mb-2 drop-shadow-md">{file.file_name}</p>
                                <p className="text-primary-400 font-medium">
                                    {formatDuration(currentTime)} / {formatDuration(duration)}
                                </p>
                            </div>
                        )}

                        {MediaElement}

                        {/* HTML Subtitle Overlay */}
                        {!isMinimized && activeSubtitleText && (
                            <div className="absolute bottom-24 left-0 right-0 px-6 flex justify-center pointer-events-none z-20">
                                <div className="max-w-4xl px-4 py-1.5 rounded-lg bg-black/80 backdrop-blur-sm border border-white/10 text-center shadow-2xl animate-fade-in">
                                    <p className="text-white text-base md:text-xl lg:text-2xl font-semibold leading-relaxed tracking-wide drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)] whitespace-pre-line font-sans">
                                        {activeSubtitleText}
                                    </p>
                                </div>
                            </div>
                        )}

                        {isLoading && !error && !isMinimized && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                                <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary-500"></div>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Minimized controls */}
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
                            <p className="text-xs text-dark-400 font-mono">
                                {formatDuration(currentTime)} / {formatDuration(duration)}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(-10); }} className="p-2 text-dark-300 hover:text-white">
                            <SkipBack className="w-5 h-5" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="p-2 bg-primary-600 rounded-full text-white hover:bg-primary-500 shadow-lg shadow-primary-500/20">
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

            {/* Overlay: top bar and custom controls */}
            {!error && !isMinimized && (
                <div
                    className={`absolute inset-0 transition-opacity duration-300 ${overlayVisible ? 'opacity-100' : 'opacity-0'} ${!overlayVisible ? 'cursor-none' : ''}`}
                    style={{ pointerEvents: overlayVisible ? 'auto' : 'none' }}
                >
                    {/* Top bar */}
                    <div
                        className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/80 to-transparent flex items-start justify-between z-30"
                        style={{ pointerEvents: overlayVisible ? 'auto' : 'none' }}
                    >
                        <div>
                            <h3 className="text-lg font-medium truncate max-w-lg text-white">{file.file_name}</h3>
                            {((extendedFile?.last_pos || 0) > 0) && currentTime < 5 && (
                                <p className="text-xs text-primary-400">Ripreso da {formatDuration(extendedFile?.last_pos || 0)}</p>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            {/* Pulsante VLC in primo piano */}
                            {isVideo && (
                                <a
                                    href={vlcUrl}
                                    className="flex items-center gap-2 px-3 py-1.5 bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium rounded-lg transition-colors shadow-lg shadow-primary-500/20"
                                    title="Apri in VLC (Riproduzione esterna con supporto completo tracce)"
                                >
                                    <MonitorPlay className="w-4 h-4" />
                                    <span className="hidden sm:inline">Apri in VLC</span>
                                </a>
                            )}

                            {/* Player Mode Switch (Default: Avanzato) */}
                            {isVideo && (
                                <button
                                    onClick={togglePlayerMode}
                                    className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-all flex items-center gap-1.5 ${
                                        playerMode === 'advanced'
                                            ? 'bg-primary-600/30 text-primary-300 border-primary-500/40 hover:bg-primary-600/40'
                                            : 'bg-white/10 text-white/80 border-white/10 hover:bg-white/20 hover:text-white'
                                    }`}
                                    title={playerMode === 'advanced' ? "Player Avanzato attivo - Clicca per passare al Nativo" : "Player Nativo attivo - Clicca per passare all'Avanzato"}
                                >
                                    <SlidersHorizontal className="w-3.5 h-3.5" />
                                    <span className="hidden md:inline">{playerMode === 'advanced' ? 'Avanzato' : 'Nativo'}</span>
                                </button>
                            )}

                            {/* Audio menu (MediaFox) */}
                            {isVideo && playerMode === 'advanced' && (
                                <div className="relative">
                                    <button
                                        onClick={() => setShowAudioMenu((v) => !v)}
                                        className="p-2 text-white hover:bg-white/20 rounded-full transition-colors flex items-center gap-1.5"
                                        title="Tracce Audio"
                                    >
                                        <Languages className="w-5 h-5" />
                                    </button>
                                    {showAudioMenu && (
                                        <div className="absolute right-0 top-full mt-2 min-w-[230px] bg-dark-800/95 backdrop-blur border border-white/10 rounded-xl shadow-2xl p-1 z-40 animate-fade-in">
                                            <p className="px-3 py-2 text-xs text-dark-400">Audio</p>
                                            {audioTracks.length === 0 && (
                                                <p className="px-3 py-2 text-sm text-dark-300">Nessuna traccia audio trovata</p>
                                            )}
                                            {audioTracks.map((track) => (
                                                <button
                                                    key={String(track.id)}
                                                    onClick={() => selectAudioTrack(track.id)}
                                                    className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors hover:bg-white/10 ${selectedAudio === track.id ? 'text-primary-300 font-medium' : 'text-white'}`}
                                                >
                                                    <span className="truncate">{track.label}</span>
                                                    {selectedAudio === track.id && <Check className="w-4 h-4 shrink-0" />}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Subtitle menu */}
                            {isVideo && (
                                <div className="relative">
                                    <button
                                        onClick={() => setShowSubtitleMenu((v) => !v)}
                                        className="relative p-2 text-white hover:bg-white/20 rounded-full transition-colors flex items-center gap-1.5"
                                        title="Sottotitoli"
                                    >
                                        <Subtitles className="w-5 h-5" />
                                        {isExtractingSubs ? (
                                            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-yellow-400 animate-pulse" title="Ricerca sottotitoli in corso" />
                                        ) : selectedSubtitle !== null ? (
                                            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-primary-400" />
                                        ) : null}
                                    </button>
                                    {showSubtitleMenu && (
                                        <div className="absolute right-0 top-full mt-2 min-w-[240px] bg-dark-800/95 backdrop-blur border border-white/10 rounded-xl shadow-2xl p-1 z-40 animate-fade-in">
                                            <div className="px-3 py-2 flex items-center justify-between border-b border-white/5">
                                                <span className="text-xs font-semibold text-dark-400 uppercase tracking-wider">Sottotitoli</span>
                                                {isExtractingSubs && (
                                                    <span className="text-[10px] text-yellow-400 font-medium">Scansione...</span>
                                                )}
                                            </div>
                                            <button
                                                onClick={() => selectSubtitleTrack(null)}
                                                className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors hover:bg-white/10 ${selectedSubtitle === null ? 'text-primary-300 font-medium' : 'text-white'}`}
                                            >
                                                <span>Disattivati</span>
                                                {selectedSubtitle === null && <Check className="w-4 h-4 shrink-0" />}
                                            </button>
                                            {isProbingSubs && (
                                                <p className="px-3 py-2 text-xs text-dark-400 animate-pulse">Ricerca tracce in corso...</p>
                                            )}
                                            {!isProbingSubs && subtitleTracks.length === 0 && (
                                                <p className="px-3 py-2 text-xs text-dark-400">Nessun sottotitolo trovato nel file</p>
                                            )}
                                            {subtitleTracks.map((track) => (
                                                <button
                                                    key={String(track.id)}
                                                    onClick={() => selectSubtitleTrack(track.id)}
                                                    className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors hover:bg-white/10 ${selectedSubtitle === track.id ? 'text-primary-300 font-medium' : 'text-white'}`}
                                                >
                                                    <span className="truncate">{track.label}</span>
                                                    {selectedSubtitle === track.id && <Check className="w-4 h-4 shrink-0" />}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            <button onClick={() => setMinimized(true)} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors ml-1" title="Riduci a icona">
                                <ChevronDown className="w-6 h-6" />
                            </button>
                            <button onClick={onClose} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors" title="Chiudi">
                                <X className="w-6 h-6" />
                            </button>
                        </div>
                    </div>

                    {/* Center controls */}
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex items-center gap-8 z-30">
                        <button
                            onClick={(e) => { e.stopPropagation(); handleSkip(-10); }}
                            className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all"
                            title="Indietro 10s"
                        >
                            <SkipBack className="w-8 h-8" />
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                            className="w-20 h-20 bg-white/20 backdrop-blur rounded-full flex items-center justify-center hover:bg-white/30 transition-all scale-100 hover:scale-105"
                        >
                            {isPlaying ? <Pause className="w-10 h-10 text-white" /> : <Play className="w-10 h-10 ml-1 text-white" />}
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); handleSkip(10); }}
                            className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all"
                            title="Avanti 10s"
                        >
                            <SkipForward className="w-8 h-8" />
                        </button>
                    </div>

                    {/* Bottom controls */}
                    <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/95 via-black/70 to-transparent z-30">
                        <div className="flex items-center gap-4 mb-4 group/progress">
                            <span className="text-sm font-medium text-white/90 min-w-[50px] font-mono">
                                {formatDuration(Math.floor(currentTime))}
                            </span>
                            <div className="relative flex-1 h-1 bg-white/20 rounded-full cursor-pointer group-hover/progress:h-2 transition-all">
                                <div
                                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary-500 to-primary-400 rounded-full transition-all"
                                    style={{ width: `${progressPercent}%` }}
                                >
                                    <div className="absolute right-0 top-1/2 transform -translate-y-1/2 w-4 h-4 bg-white rounded-full opacity-0 group-hover/progress:opacity-100 transition-all shadow-lg shadow-primary-500/50 scale-75 group-hover/progress:scale-100"></div>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={duration || 100}
                                    value={currentTime}
                                    onChange={handleSeek}
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                />
                            </div>
                            <span className="text-sm font-medium text-white/90 min-w-[50px] text-right font-mono">
                                {formatDuration(Math.floor(duration))}
                            </span>
                        </div>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={togglePlay}
                                    className="p-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all hover:scale-105"
                                >
                                    {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
                                </button>
                                <div className="flex items-center gap-2 group/vol">
                                    <button
                                        onClick={toggleMute}
                                        className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all"
                                    >
                                        {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                                    </button>
                                    <div className="w-0 overflow-hidden group-hover/vol:w-24 transition-all duration-300">
                                        <input
                                            type="range"
                                            min={0}
                                            max={1}
                                            step={0.05}
                                            value={isMuted ? 0 : volume}
                                            onChange={handleVolumeChange}
                                            className="w-20 h-1 bg-white/30 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-lg"
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={cycleSpeed}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                                        playbackSpeed !== 1
                                            ? 'bg-primary-500/30 text-primary-300 border border-primary-500/40'
                                            : 'bg-white/10 text-white/80 border border-white/10 hover:bg-white/20 hover:text-white'
                                    }`}
                                    title="Velocità di riproduzione"
                                >
                                    <Gauge className="w-4 h-4" />
                                    <span>{playbackSpeed}x</span>
                                </button>
                                <button
                                    onClick={toggleFullscreen}
                                    className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all"
                                    title={isFullscreen ? "Esci dallo Schermo Intero" : "Schermo Intero"}
                                >
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

function Button({ onClick, className, children }: { onClick?: (e: any) => void; className?: string; children: React.ReactNode }) {
    return <button onClick={onClick} className={className}>{children}</button>;
}
