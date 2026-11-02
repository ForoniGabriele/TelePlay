/**
 * MediaPlayer - full screen video/audio player
 * Video: uses ONLY the advanced MediaFox player (canvas + Web Audio).
 *   Subtitles are rendered via a MediaFox overlay plugin (onOverlay).
 *   NOTE: MediaFox does NOT extract embedded MKV subtitles automatically.
 *   You must provide subtitle cues (e.g. from an external .srt/.vtt file,
 *   or extracted via @cryguy/mkv-subtitle-extractor) to see them.
 * Audio: keeps the custom UI.
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import { X, Play, Pause, Volume2, VolumeX, Maximize, Minimize, SkipBack, SkipForward, Download, ExternalLink, AlertTriangle, Copy, Gauge, ChevronDown, ChevronUp, Languages, Check, Subtitles } from 'lucide-react';
import { TelegramFile, formatDuration, useUpdateProgress, useFile, api } from '../lib/api';
import { useAppStore } from '../lib/store';

// ---- Subtitle types ----
interface SubtitleCue {
    start: number; // seconds
    end: number;   // seconds
    text: string;
}

interface SubtitleTrackOption {
    id: number | string;
    label: string;
}

// Minimal SRT/VTT parser: returns an array of cues.
// Supports both "00:00:01,000 --> 00:00:04,000" (SRT) and "00:00:01.000 --> 00:00:04.000" (VTT)
function parseSubtitles(raw: string): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    const blocks = raw.replace(/\r\n/g, '\n').split(/\n{2,}/);
    const timeRe = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/;
    for (const block of blocks) {
        const lines = block.trim().split('\n');
        const timeLine = lines.find(l => timeRe.test(l));
        if (!timeLine) continue;
        const m = timeLine.match(timeRe);
        if (!m) continue;
        const toSec = (h: string, mnt: string, s: string, ms: string) =>
            parseInt(h) * 3600 + parseInt(mnt) * 60 + parseInt(s) + parseInt(ms) / 1000;
        const start = toSec(m[1], m[2], m[3], m[4]);
        const end = toSec(m[5], m[6], m[7], m[8]);
        const textLines = lines.filter(l => l !== timeLine && !/^\d+$/.test(l.trim()));
        const text = textLines.join('\n').trim();
        if (text) cues.push({ start, end, text });
    }
    return cues;
}

// Builds a readable name for an audio/subtitle track
function describeTrack(track: any, index: number): string {
    const name = track?.name || track?.label || track?.title;
    const lang = track?.language || track?.lang || track?.languageCode;
    const parts = [name, lang && lang !== 'und' ? String(lang).toUpperCase() : null].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : `Track ${index + 1}`;
}

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
    const audioRef = useRef<HTMLAudioElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const playerRef = useRef<any>(null);
    const advTime = useRef(0);
    const advDuration = useRef(0);

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

    // ---- Audio tracks ----
    const [audioTracks, setAudioTracks] = useState<SubtitleTrackOption[]>([]);
    const [selectedAudio, setSelectedAudio] = useState<number | string | null>(null);
    const [showAudioMenu, setShowAudioMenu] = useState(false);

    // ---- Subtitle tracks (cues are what we actually render) ----
    const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackOption[]>([]);
    const [selectedSubtitle, setSelectedSubtitle] = useState<number | string | null>(null);
    const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
    const subtitleCuesRef = useRef<SubtitleCue[]>([]);
    const selectedSubtitleRef = useRef<number | string | null>(null);

    // Keep the ref in sync so the overlay plugin can read it
    useEffect(() => {
        selectedSubtitleRef.current = selectedSubtitle;
    }, [selectedSubtitle]);

    const isVideo = file.file_type === 'video';

    const { data: extendedFile } = useFile(file.id);
    const { mutate: updateProgress } = useUpdateProgress();

    // Auto-ensure public link exists
    useEffect(() => {
        const ensurePublicLink = async () => {
            const fileData = extendedFile || file;
            if (fileData.public_stream_url) {
                setPublicUrl(getAbsoluteUrl(fileData.public_stream_url));
            } else {
                try {
                    const { data } = await api.post<TelegramFile>(`/files/${file.id}/share`);
                    if (data.public_stream_url) setPublicUrl(getAbsoluteUrl(data.public_stream_url));
                } catch (err) { console.error('Failed to create public link:', err); }
            }
        };
        ensurePublicLink();
    }, [file.id, extendedFile]);

    useEffect(() => { resumeApplied.current = false; }, [file.id]);

    const snapshotProgress = useCallback(() => {
        if (isVideo) return { position: advTime.current, duration: advDuration.current || undefined };
        const el = audioRef.current;
        if (!el) return null;
        return { position: el.currentTime, duration: el.duration };
    }, [isVideo]);

    const saveProgress = useCallback(() => {
        if (error) return;
        const snap = snapshotProgress();
        if (!snap) return;
        updateProgress({ fileId: file.id, position: Math.floor(snap.position), duration: snap.duration });
    }, [file.id, error, updateProgress, snapshotProgress]);

    const saveProgressRef = useRef(saveProgress);
    saveProgressRef.current = saveProgress;

    useEffect(() => {
        const interval = setInterval(() => { if (isPlaying && !error) saveProgressRef.current(); }, 10000);
        return () => clearInterval(interval);
    }, [isPlaying, error]);

    useEffect(() => () => saveProgress(), [saveProgress]);

    // ---- Audio element events (audio files only) ----
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => { setIsPlaying(false); saveProgress(); };
    const handleTimeUpdate = () => { if (audioRef.current) setCurrentTime(audioRef.current.currentTime); };
    const handleLoadedMetadata = () => {
        const el = audioRef.current;
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
        if (audioRef.current?.error) { setError("An error occurred while trying to play this file."); setIsLoading(false); }
    };

    // ---- Playback controls ----
    const togglePlay = (e?: any) => {
        e?.stopPropagation();
        const p = playerRef.current;
        if (p) { isPlaying ? p.pause() : Promise.resolve(p.play()).catch(() => { }); return; }
        const el = audioRef.current;
        if (el) { el.paused ? el.play().catch(() => { }) : el.pause(); }
    };

    const toggleMute = () => {
        const p = playerRef.current;
        if (p) { p.volume = isMuted ? (volume || 1) : 0; setIsMuted(!isMuted); return; }
        if (audioRef.current) { audioRef.current.muted = !isMuted; setIsMuted(!isMuted); }
    };

    const toggleFullscreen = () => {
        if (!document.fullscreenElement) { containerRef.current?.requestFullscreen(); setIsFullscreen(true); }
        else { document.exitFullscreen(); setIsFullscreen(false); }
    };

    const cycleSpeed = () => {
        const speeds = [0.5, 1, 1.25, 1.5, 2];
        const nextSpeed = speeds[(speeds.indexOf(playbackSpeed) + 1) % speeds.length];
        setPlaybackSpeed(nextSpeed);
        if (playerRef.current) playerRef.current.playbackRate = nextSpeed;
        else if (audioRef.current) audioRef.current.playbackRate = nextSpeed;
    };

    const handleSkip = (seconds: number) => {
        const p = playerRef.current;
        if (p) { const target = Math.max(0, advTime.current + seconds); Promise.resolve(p.seek(target)).catch(() => { }); setCurrentTime(target); return; }
        if (audioRef.current) audioRef.current.currentTime += seconds;
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const time = parseFloat(e.target.value);
        const p = playerRef.current;
        if (p) { Promise.resolve(p.seek(time)).catch(() => { }); setCurrentTime(time); return; }
        if (audioRef.current) { audioRef.current.currentTime = time; setCurrentTime(time); }
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const vol = parseFloat(e.target.value);
        if (playerRef.current) { playerRef.current.volume = vol; setVolume(vol); setIsMuted(vol === 0); }
        else if (audioRef.current) { audioRef.current.volume = vol; setVolume(vol); setIsMuted(vol === 0); }
    };

    // ---- Track selection ----
    const selectAudioTrack = async (id: number | string) => {
        const p = playerRef.current;
        if (!p) return;
        try { await p.selectAudioTrack(id); setSelectedAudio(id); }
        catch (err) { console.error('Failed to switch audio track:', err); }
        setShowAudioMenu(false);
    };

    const selectSubtitleTrack = (id: number | string) => {
        // The overlay plugin reads selectedSubtitleRef; no player API call is needed
        // because MediaFox's selectSubtitleTrack only enables a track internally,
        // it does NOT render cues on the canvas.
        setSelectedSubtitle(id);
        setShowSubtitleMenu(false);
    };

    // Load subtitle cues for the selected track.
    // This is where you plug in your subtitle source:
    // - If you have an external .srt/.vtt URL, fetch it here.
    // - If subtitles are embedded in the MKV, use mkv-subtitle-extractor first.
    useEffect(() => {
        if (!selectedSubtitle || !isVideo) {
            subtitleCuesRef.current = [];
            return;
        }
        // PLACEHOLDER: replace with real subtitle loading.
        // Example with an external URL:
        // fetch('/subtitles/movie.srt').then(r => r.text()).then(raw => {
        //     subtitleCuesRef.current = parseSubtitles(raw);
        // });
        //
        // For now, show a demo cue so you can verify the overlay works.
        subtitleCuesRef.current = [
            { start: 0, end: 99999, text: 'Sottotitoli demo attivi (sostituisci con il caricamento reale)' },
        ];
    }, [selectedSubtitle, isVideo]);

    // Create / destroy the MediaFox player and register the subtitle overlay plugin
    useEffect(() => {
        if (!isVideo || !canvasRef.current) return;

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

                // ---- Subtitle overlay plugin ----
                // MediaFox renders on canvas, so subtitles must be drawn manually
                // via the onOverlay render hook [citation:1].
                const subtitlePlugin = {
                    name: 'subtitles',
                    install(ctx: any) {
                        ctx.setPluginState({ subtitles: [] as SubtitleCue[] });
                    },
                    hooks: {
                        render: {
                            onOverlay: {
                                zIndex: 100,
                                render(ctx: CanvasRenderingContext2D, time: number, { width, height }: { width: number; height: number }) {
                                    // Only draw if a subtitle track is selected
                                    if (selectedSubtitleRef.current == null) return;
                                    const cues = subtitleCuesRef.current;
                                    const cue = cues.find((c: SubtitleCue) => time >= c.start && time <= c.end);
                                    if (!cue) return;

                                    const lines = cue.text.split('\n');
                                    const fontSize = Math.max(16, Math.floor(height * 0.045));
                                    ctx.font = `bold ${fontSize}px sans-serif`;
                                    ctx.textAlign = 'center';
                                    ctx.textBaseline = 'bottom';
                                    ctx.fillStyle = 'white';
                                    ctx.strokeStyle = 'black';
                                    ctx.lineWidth = Math.max(2, fontSize / 10);

                                    const lineHeight = fontSize * 1.3;
                                    const baseY = height - height * 0.08;
                                    lines.forEach((line, i) => {
                                        const y = baseY - (lines.length - 1 - i) * lineHeight;
                                        ctx.strokeText(line, width / 2, y);
                                        ctx.fillText(line, width / 2, y);
                                    });
                                },
                            },
                        },
                    },
                };

                await player.use(subtitlePlugin);

                let wasPlaying = false;
                const unsubscribe = player.subscribe((s: any) => {
                    const playing = !!(s.playing ?? s.state === 'playing');
                    advTime.current = s.currentTime ?? advTime.current;
                    setCurrentTime(advTime.current);
                    if (s.duration) { advDuration.current = s.duration; setDuration(s.duration); }
                    setIsPlaying(playing);
                    if (wasPlaying && !playing) saveProgressRef.current();
                    wasPlaying = playing;
                });
                if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);

                player.on?.('error', () => {
                    if (cancelled) return;
                    setError('The player could not play this file. The format may not be supported.');
                    setIsLoading(false);
                });

                await player.load(authorizedStreamUrl);
                if (cancelled) return;

                // Audio tracks (as before)
                const tracks: any[] = player.getAudioTracks?.() ?? [];
                setAudioTracks(tracks.map((t, i) => ({ id: t.id, label: describeTrack(t, i) })));
                setSelectedAudio(tracks[0]?.id ?? null);

                // Subtitle tracks: for now we expose a single "Italiano" option.
                // Replace this with real track metadata from your extraction logic.
                setSubtitleTracks([{ id: 'it', label: 'Italiano' }]);
                setSelectedSubtitle('it');

                const start = extendedFile?.last_pos ?? 0;
                if (start > 1) await player.seek(start);
                if (cancelled) return;

                setIsLoading(false);
                await player.play();
            } catch (err) {
                console.error('Advanced player failed:', err);
                if (!cancelled) { setError('The player could not load this file. The format may not be supported.'); setIsLoading(false); }
            }
        })();

        return () => {
            cancelled = true;
            unsubscribers.forEach((u) => u());
            try { const dispose = player?.dispose ?? player?.destroy; dispose?.call(player); } catch { }
            playerRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVideo, file.id]);

    // Fullscreen sync
    useEffect(() => {
        const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onFsChange);
        return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

    // Keyboard controls
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (error) return;
            switch (e.key) {
                case ' ': case 'k': e.preventDefault(); togglePlay(); break;
                case 'ArrowLeft': case 'j': e.preventDefault(); handleSkip(-10); break;
                case 'ArrowRight': case 'l': e.preventDefault(); handleSkip(10); break;
                case 'm': toggleMute(); break;
                case 'f': toggleFullscreen(); break;
                case 'Escape':
                    if (document.fullscreenElement) document.exitFullscreen();
                    else if (!isMinimized) onClose();
                    break;
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isFullscreen, onClose, error, isPlaying, isMinimized, isMuted]);

    const handleMouseMove = () => {
        setShowControls(true);
        if (hideControlsTimeout.current) clearTimeout(hideControlsTimeout.current);
        hideControlsTimeout.current = setTimeout(() => { if (isPlaying && !isMinimized) setShowControls(false); }, 3000);
    };

    // Audio autoplay
    useEffect(() => {
        if (!isVideo && audioRef.current && !error) audioRef.current.play().catch(() => { });
    }, [error, file.id, isVideo]);

    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

    const token = localStorage.getItem('access_token');
    const getAbsoluteUrl = (url: string) => !url ? '' : url.startsWith('http') ? url : `${window.location.origin}${url}`;
    const relativeStreamUrl = `${file.stream_url}?token=${token}`;
    const authorizedStreamUrl = getAbsoluteUrl(relativeStreamUrl);
    const externalUrl = publicUrl || authorizedStreamUrl;
    const vlcUrl = `vlc://${externalUrl}`;
    const relativeThumbnailUrl = file.thumbnail_url ? `${file.thumbnail_url}?token=${token}` : null;
    const authorizedThumbnailUrl = relativeThumbnailUrl ? getAbsoluteUrl(relativeThumbnailUrl) : null;

    const MediaElement = isVideo ? (
        <canvas ref={canvasRef} onClick={togglePlay} className={`max-w-full max-h-full w-full h-full object-contain bg-black ${isMinimized ? 'hidden' : ''}`} />
    ) : (
        <audio ref={audioRef} src={authorizedStreamUrl} onPlay={handlePlay} onPause={handlePause} onTimeUpdate={handleTimeUpdate} onLoadedMetadata={handleLoadedMetadata} onWaiting={handleWaiting} onPlaying={handlePlaying} onError={handleError} />
    );

    const overlayVisible = showControls || !isPlaying;

    return (
        <div
            ref={containerRef}
            className={`fixed transition-all duration-300 ease-in-out z-[100] ${isMinimized ? 'bottom-0 left-0 right-0 h-20 bg-dark-900 border-t border-white/10 shadow-2xl' : 'inset-0 bg-black flex items-center justify-center font-sans'}`}
            onMouseMove={!isMinimized ? handleMouseMove : undefined}
            onDoubleClick={!isMinimized ? toggleFullscreen : undefined}
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
                            <a href={vlcUrl} className="btn-primary flex items-center justify-center gap-2"><ExternalLink className="w-4 h-4" />Open in VLC</a>
                            <div className="flex gap-3">
                                <Button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(externalUrl); }} className="flex-1 btn-secondary flex items-center justify-center gap-2"><Copy className="w-4 h-4" />Copy URL</Button>
                                <a href={externalUrl} download={file.file_name} className="flex-1 btn-secondary flex items-center justify-center gap-2" onClick={(e) => e.stopPropagation()}><Download className="w-4 h-4" />Download</a>
                            </div>
                        </div>
                        <button onClick={onClose} className="mt-6 text-dark-400 hover:text-white text-sm transition-colors">Close</button>
                    </div>
                ) : (
                    <>
                        {!isVideo && !isMinimized && (
                            <div className="text-center z-10 glass-panel p-10 animate-scale-in absolute overflow-hidden">
                                {authorizedThumbnailUrl ? (
                                    <div className="w-64 h-64 mx-auto mb-6 rounded-2xl bg-dark-800 shadow-2xl overflow-hidden border border-white/10 relative group">
                                        <img src={authorizedThumbnailUrl} alt={file.file_name} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement?.classList.add('hidden'); }} />
                                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex items-end justify-center pb-4 opacity-0 group-hover:opacity-100 transition-opacity"><span className="text-white text-sm font-medium">Original Artwork</span></div>
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
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20"><div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary-500"></div></div>
                        )}
                    </>
                )}
            </div>

            {/* Minimized controls */}
            {isMinimized && (
                <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 p-3 h-full">
                    <div className="flex items-center gap-3 overflow-hidden flex-1 cursor-pointer" onClick={() => setMinimized(false)}>
                        <div className="w-12 h-12 rounded-lg bg-dark-800 flex items-center justify-center flex-shrink-0 overflow-hidden border border-white/5 relative">
                            {authorizedThumbnailUrl ? <img src={authorizedThumbnailUrl} alt="Thumb" className="w-full h-full object-cover" /> : (isVideo ? <span className="text-2xl">🎬</span> : <span className="text-2xl">🎵</span>)}
                        </div>
                        <div className="truncate flex-1 min-w-0">
                            <h4 className="text-sm font-bold text-white truncate leading-tight">{file.file_name}</h4>
                            <p className="text-xs text-dark-400 font-mono">{formatDuration(currentTime)} / {formatDuration(duration)}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(-10); }} className="p-2 text-dark-300 hover:text-white"><SkipBack className="w-5 h-5" /></button>
                        <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="p-2 bg-primary-600 rounded-full text-white hover:bg-primary-500 shadow-lg shadow-primary-500/20">{isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}</button>
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(10); }} className="p-2 text-dark-300 hover:text-white"><SkipForward className="w-5 h-5" /></button>
                    </div>
                    <div className="flex items-center gap-2 border-l border-white/10 pl-4">
                        <button onClick={() => setMinimized(false)} className="p-2 text-dark-400 hover:text-white" title="Maximize"><ChevronUp className="w-5 h-5" /></button>
                        <button onClick={onClose} className="p-2 text-dark-400 hover:text-red-400" title="Close"><X className="w-5 h-5" /></button>
                    </div>
                    <div className="absolute top-0 left-0 right-0 h-0.5 bg-dark-800"><div className="h-full bg-primary-500" style={{ width: `${progressPercent}%` }}></div></div>
                </div>
            )}

            {/* Overlay: top bar and custom controls */}
            {!error && !isMinimized && (
                <div className={`absolute inset-0 transition-opacity duration-300 ${overlayVisible ? 'opacity-100' : 'opacity-0'} ${!overlayVisible ? 'cursor-none' : ''}`} style={{ pointerEvents: overlayVisible ? 'auto' : 'none' }}>
                    <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/80 to-transparent flex items-start justify-between z-30" style={{ pointerEvents: overlayVisible ? 'auto' : 'none' }}>
                        <div>
                            <h3 className="text-lg font-medium truncate max-w-lg text-white">{file.file_name}</h3>
                            {((extendedFile?.last_pos || 0) > 0) && currentTime < 5 && <p className="text-xs text-primary-400">Resumed from {formatDuration(extendedFile?.last_pos || 0)}</p>}
                        </div>
                        <div className="flex items-center gap-2">
                            {/* Audio menu */}
                            {isVideo && (
                                <div className="relative">
                                    <button onClick={() => setShowAudioMenu((v) => !v)} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors flex items-center gap-1.5" title="Audio tracks"><Languages className="w-5 h-5" /></button>
                                    {showAudioMenu && (
                                        <div className="absolute right-0 top-full mt-2 min-w-[230px] bg-dark-800/95 backdrop-blur border border-white/10 rounded-xl shadow-2xl p-1 z-40">
                                            <p className="px-3 py-2 text-xs text-dark-400">Audio</p>
                                            {audioTracks.length === 0 && <p className="px-3 py-2 text-sm text-dark-300">No audio tracks found</p>}
                                            {audioTracks.map((track) => (
                                                <button key={String(track.id)} onClick={() => selectAudioTrack(track.id)} className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors hover:bg-white/10 ${selectedAudio === track.id ? 'text-primary-300' : 'text-white'}`}>
                                                    <span className="truncate">{track.label}</span>{selectedAudio === track.id && <Check className="w-4 h-4 shrink-0" />}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                            {/* Subtitle menu */}
                            {isVideo && (
                                <div className="relative">
                                    <button onClick={() => setShowSubtitleMenu((v) => !v)} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors flex items-center gap-1.5" title="Subtitles"><Subtitles className="w-5 h-5" /></button>
                                    {showSubtitleMenu && (
                                        <div className="absolute right-0 top-full mt-2 min-w-[230px] bg-dark-800/95 backdrop-blur border border-white/10 rounded-xl shadow-2xl p-1 z-40">
                                            <p className="px-3 py-2 text-xs text-dark-400">Sottotitoli</p>
                                            <button onClick={() => { setSelectedSubtitle(null); setShowSubtitleMenu(false); }} className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors hover:bg-white/10 ${selectedSubtitle === null ? 'text-primary-300' : 'text-white'}`}><span>Disattivati</span>{selectedSubtitle === null && <Check className="w-4 h-4 shrink-0" />}</button>
                                            {subtitleTracks.map((track) => (
                                                <button key={String(track.id)} onClick={() => selectSubtitleTrack(track.id)} className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors hover:bg-white/10 ${selectedSubtitle === track.id ? 'text-primary-300' : 'text-white'}`}>
                                                    <span className="truncate">{track.label}</span>{selectedSubtitle === track.id && <Check className="w-4 h-4 shrink-0" />}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                            <button onClick={() => setMinimized(true)} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors" title="Minimize"><ChevronDown className="w-6 h-6" /></button>
                            <button onClick={onClose} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors"><X className="w-6 h-6" /></button>
                        </div>
                    </div>

                    {/* Center controls */}
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex items-center gap-8 z-30">
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(-10); }} className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all"><SkipBack className="w-8 h-8" /></button>
                        <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="w-20 h-20 bg-white/20 backdrop-blur rounded-full flex items-center justify-center hover:bg-white/30 transition-all scale-100 hover:scale-105">{isPlaying ? <Pause className="w-10 h-10 text-white" /> : <Play className="w-10 h-10 ml-1 text-white" />}</button>
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(10); }} className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all"><SkipForward className="w-8 h-8" /></button>
                    </div>

                    {/* Bottom controls */}
                    <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/95 via-black/70 to-transparent z-30">
                        <div className="flex items-center gap-4 mb-4 group/progress">
                            <span className="text-sm font-medium text-white/90 min-w-[50px] font-mono">{formatDuration(Math.floor(currentTime))}</span>
                            <div className="relative flex-1 h-1 bg-white/20 rounded-full cursor-pointer group-hover/progress:h-2 transition-all">
                                <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary-500 to-primary-400 rounded-full transition-all" style={{ width: `${progressPercent}%` }}><div className="absolute right-0 top-1/2 transform -translate-y-1/2 w-4 h-4 bg-white rounded-full opacity-0 group-hover/progress:opacity-100 transition-all shadow-lg shadow-primary-500/50 scale-75 group-hover/progress:scale-100"></div></div>
                                <input type="range" min={0} max={duration || 100} value={currentTime} onChange={handleSeek} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                            </div>
                            <span className="text-sm font-medium text-white/90 min-w-[50px] text-right font-mono">{formatDuration(Math.floor(duration))}</span>
                        </div>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <button onClick={togglePlay} className="p-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all hover:scale-105">{isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}</button>
                                <div className="flex items-center gap-2 group/vol">
                                    <button onClick={toggleMute} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all">{isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}</button>
                                    <div className="w-0 overflow-hidden group-hover/vol:w-24 transition-all duration-300">
                                        <input type="range" min={0} max={1} step={0.05} value={isMuted ? 0 : volume} onChange={handleVolumeChange} className="w-20 h-1 bg-white/30 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-lg" />
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button onClick={cycleSpeed} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${playbackSpeed !== 1 ? 'bg-primary-500/30 text-primary-300 border border-primary-500/40' : 'bg-white/10 text-white/80 border border-white/10 hover:bg-white/20 hover:text-white'}`} title="Playback Speed"><Gauge className="w-4 h-4" /><span>{playbackSpeed}x</span></button>
                                <button onClick={toggleFullscreen} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all" title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}>{isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function Button({ onClick, className, children }: { onClick?: (e: any) => void, className?: string, children: React.ReactNode }) {
    return <button onClick={onClick} className={className}>{children}</button>;
}