/**
 * MediaPlayer - versione basata su `movi-player` (elemento <movi-player>)
 *
 *   npm i movi-player
 *
 * Video: <movi-player> (FFmpeg/libavformat in WASM + WebCodecs + canvas).
 *        Tracce audio, sottotitoli incorporati (SRT/ASS/SSA/VTT/PGS), velocita', fullscreen
 *        e scorciatoie sono gestiti dal componente stesso (menu a ingranaggio / tasto destro).
 *        Qui restano solo la cornice (titolo, "Apri in VLC", minimizza, chiudi),
 *        il salvataggio del progresso e il resume.
 * Audio: UI custom con <audio>.
 *
 * Gli header COOP/COEP NON servono (opzionali dalla 0.4): non vanno impostati sul server.
 *
 * Se un file non parte: il componente mostra il proprio errore (con "Try Software Decoding"
 * se serve) e la barra in alto resta disponibile con "Apri in VLC". Gli errori vengono
 * scritti anche nella console del browser con il prefisso "[movi]".
 */
import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
    X, Play, Pause, Volume2, VolumeX, SkipBack, SkipForward,
    ExternalLink, AlertTriangle, Copy, Gauge, ChevronDown, ChevronUp, MonitorPlay,
} from 'lucide-react';
import { TelegramFile, formatDuration, useUpdateProgress, useFile, api } from '../lib/api';
import { useAppStore } from '../lib/store';

const UI_UPDATE_INTERVAL_MS = 250;

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
    const moviRef = useRef<any>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const vidTime = useRef(0);
    const vidDuration = useRef(0);

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [playbackSpeed, setPlaybackSpeed] = useState(1);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [moviReady, setMoviReady] = useState(false);
    const hideControlsTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [publicUrl, setPublicUrl] = useState<string | null>(null);
    const resumeApplied = useRef(false);
    const publicLinkRequestedFor = useRef<string | number | null>(null);

    const isVideo = file.file_type === 'video';

    const { data: extendedFile } = useFile(file.id);
    const extendedFileRef = useRef(extendedFile);
    extendedFileRef.current = extendedFile;
    const { mutate: updateProgress } = useUpdateProgress();

    const token = localStorage.getItem('access_token');
    const getAbsoluteUrl = (url: string) =>
        !url ? '' : url.startsWith('http') ? url : `${window.location.origin}${url}`;
    const authorizedStreamUrl = getAbsoluteUrl(`${file.stream_url}?token=${token}`);
    const externalUrl = publicUrl || authorizedStreamUrl;
    const vlcUrl = `vlc://${externalUrl}`;

    const relativeThumbnailUrl = file.thumbnail_url ? `${file.thumbnail_url}?token=${token}` : null;
    const authorizedThumbnailUrl = relativeThumbnailUrl ? getAbsoluteUrl(relativeThumbnailUrl) : null;

    // ---- Public link (for VLC / external use) ----
    useEffect(() => {
        const fileData = extendedFile || file;
        if (fileData.public_stream_url) {
            setPublicUrl(getAbsoluteUrl(fileData.public_stream_url));
            return;
        }
        if (publicLinkRequestedFor.current === file.id) return;
        publicLinkRequestedFor.current = file.id;
        (async () => {
            try {
                const { data } = await api.post<TelegramFile>(`/files/${file.id}/share`);
                if (data.public_stream_url) setPublicUrl(getAbsoluteUrl(data.public_stream_url));
            } catch (err) {
                console.error('Failed to create public link:', err);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file.id, extendedFile?.public_stream_url]);

    useEffect(() => { resumeApplied.current = false; }, [file.id]);

    // ---- Progress saving ----
    const snapshotProgress = useCallback(() => {
        if (isVideo) return { position: vidTime.current, duration: vidDuration.current || undefined };
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

    // ---- Video: registra il web component ----
    useEffect(() => {
        if (!isVideo) return;
        let cancelled = false;
        setMoviReady(false);
        setError(null);
        vidTime.current = 0;
        vidDuration.current = 0;
        import('movi-player')
            .then(() => { if (!cancelled) setMoviReady(true); })
            .catch((err) => {
                console.error('[movi] failed to load the library:', err);
                if (!cancelled) setError('Impossibile caricare il player video.');
            });
        return () => { cancelled = true; };
    }, [isVideo, file.id]);

    // ---- Video: eventi del componente ----
    useEffect(() => {
        if (!isVideo || !moviReady) return;
        const el = moviRef.current;
        if (!el) return;

        let lastUi = 0;
        const syncDuration = () => {
            const d = Number(el.duration);
            if (d && Number.isFinite(d) && d !== vidDuration.current) { vidDuration.current = d; setDuration(d); }
        };
        const onTime = (e: any) => {
            const t = typeof e?.detail === 'number' ? e.detail : Number(el.currentTime) || 0;
            vidTime.current = t;
            const now = performance.now();
            if (now - lastUi >= UI_UPDATE_INTERVAL_MS) {
                lastUi = now;
                setCurrentTime(t);
                syncDuration();
            }
        };
        const onPlay = () => setIsPlaying(true);
        const onPause = () => { setIsPlaying(false); saveProgressRef.current(); };
        const onEnded = () => { setIsPlaying(false); saveProgressRef.current(); };
        // `loadedmetadata` e' l'evento documentato; `loadeddata` resta come rete di sicurezza
        const onLoaded = () => {
            syncDuration();
            setIsLoading(false);
            if (resumeApplied.current) return;
            const last = extendedFileRef.current?.last_pos ?? 0;
            if (last > 1) {
                const total = vidDuration.current || extendedFileRef.current?.duration || 0;
                if (!total || last < total * 0.95) {
                    try { el.currentTime = last; } catch (err) { console.error('[movi] resume failed:', err); }
                }
            }
            resumeApplied.current = true;
        };
        // Il componente mostra gia' il suo errore (con "Try Software Decoding"): qui lo scriviamo solo in console.
        const onError = (e: any) => { console.error('[movi] error:', e?.detail ?? e); };

        el.addEventListener('timeupdate', onTime);
        el.addEventListener('play', onPlay);
        el.addEventListener('pause', onPause);
        el.addEventListener('ended', onEnded);
        el.addEventListener('loadedmetadata', onLoaded);
        el.addEventListener('loadeddata', onLoaded);
        el.addEventListener('error', onError);
        return () => {
            el.removeEventListener('timeupdate', onTime);
            el.removeEventListener('play', onPlay);
            el.removeEventListener('pause', onPause);
            el.removeEventListener('ended', onEnded);
            el.removeEventListener('loadedmetadata', onLoaded);
            el.removeEventListener('loadeddata', onLoaded);
            el.removeEventListener('error', onError);
        };
    }, [isVideo, moviReady, file.id]);

    // ---- <audio> handlers ----
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
        if (audioRef.current?.error) {
            setError('An error occurred while trying to play this file.');
            setIsLoading(false);
        }
    };

    // ---- Controls (usati da audio e dalla barra minimizzata) ----
    const togglePlay = (e?: any) => {
        e?.stopPropagation?.();
        if (isVideo) {
            const el = moviRef.current;
            if (!el) return;
            if (el.paused) Promise.resolve(el.play()).catch(() => { });
            else el.pause();
            return;
        }
        const el = audioRef.current;
        if (el) { el.paused ? el.play().catch(() => { }) : el.pause(); }
    };

    const toggleMute = () => {
        if (audioRef.current) { audioRef.current.muted = !isMuted; setIsMuted(!isMuted); }
    };

    const cycleSpeed = () => {
        const speeds = [0.5, 1, 1.25, 1.5, 2];
        const next = speeds[(speeds.indexOf(playbackSpeed) + 1) % speeds.length];
        setPlaybackSpeed(next);
        if (audioRef.current) audioRef.current.playbackRate = next;
    };

    const handleSkip = (seconds: number) => {
        if (isVideo) {
            const el = moviRef.current;
            if (!el) return;
            const max = vidDuration.current || Infinity;
            const target = Math.min(max, Math.max(0, vidTime.current + seconds));
            el.currentTime = target;
            vidTime.current = target;
            setCurrentTime(target);
            return;
        }
        if (audioRef.current) audioRef.current.currentTime += seconds;
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const time = parseFloat(e.target.value);
        if (audioRef.current) { audioRef.current.currentTime = time; setCurrentTime(time); }
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const vol = parseFloat(e.target.value);
        if (audioRef.current) audioRef.current.volume = vol;
        setVolume(vol);
        setIsMuted(vol === 0);
    };

    // ---- Escape chiude il player (le altre scorciatoie video le gestisce <movi-player>) ----
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (error && e.key !== 'Escape') return;
            if (e.key === 'Escape' && !document.fullscreenElement && !isMinimized) onClose();
            if (!isVideo && (e.key === ' ' || e.key === 'k')) { e.preventDefault(); togglePlay(); }
            if (!isVideo && e.key === 'ArrowLeft') { e.preventDefault(); handleSkip(-10); }
            if (!isVideo && e.key === 'ArrowRight') { e.preventDefault(); handleSkip(10); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onClose, error, isMinimized, isVideo, isPlaying]);

    const handleMouseMove = () => {
        setShowControls(true);
        if (hideControlsTimeout.current) clearTimeout(hideControlsTimeout.current);
        hideControlsTimeout.current = setTimeout(() => {
            if (isPlaying && !isMinimized) setShowControls(false);
        }, 3000);
    };

    useEffect(() => () => {
        if (hideControlsTimeout.current) clearTimeout(hideControlsTimeout.current);
    }, []);

    // ---- Audio autoplay ----
    useEffect(() => {
        if (!isVideo && audioRef.current && !error) audioRef.current.play().catch(() => { });
    }, [error, file.id, isVideo]);

    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
    const overlayVisible = showControls || !isPlaying;

    // createElement evita problemi di tipi JSX con elementi custom.
    // sw="auto": se la decodifica hardware fallisce passa da solo a quella software (FFmpeg WASM).
    const moviElement = isVideo && moviReady
        ? React.createElement('movi-player', {
            key: file.id,
            ref: moviRef,
            src: authorizedStreamUrl,
            controls: '',
            autoplay: '',
            sw: 'auto',
            theme: 'dark',
            objectfit: 'contain',
            fastseek: '',
            subtitlepicker: '',
            playsinline: '',
            style: { width: '100%', height: '100%', display: 'block' },
        })
        : null;

    return (
        <div
            ref={containerRef}
            className={`fixed transition-all duration-300 ease-in-out z-[100] ${isMinimized ? 'bottom-0 left-0 right-0 h-20 bg-dark-900 border-t border-white/10 shadow-2xl' : 'inset-0 bg-black flex items-center justify-center font-sans'}`}
            onMouseMove={!isMinimized ? handleMouseMove : undefined}
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
                            <a href={vlcUrl} className="btn-primary flex items-center justify-center gap-2 bg-primary-600 hover:bg-primary-500">
                                <MonitorPlay className="w-5 h-5" />Apri in VLC
                            </a>
                            <a href={externalUrl} className="btn-secondary flex items-center justify-center gap-2">
                                <ExternalLink className="w-4 h-4" />Apri URL Diretto
                            </a>
                            <button
                                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(externalUrl); }}
                                className="btn-secondary flex items-center justify-center gap-2"
                            >
                                <Copy className="w-4 h-4" />Copia URL
                            </button>
                        </div>
                        <button onClick={onClose} className="mt-6 text-dark-400 hover:text-white text-sm transition-colors">Chiudi</button>
                    </div>
                ) : isVideo ? (
                    moviElement
                ) : (
                    <>
                        {!isMinimized && (
                            <div className="text-center z-10 glass-panel p-10 animate-scale-in absolute overflow-hidden">
                                {authorizedThumbnailUrl ? (
                                    <div className="w-64 h-64 mx-auto mb-6 rounded-2xl bg-dark-800 shadow-2xl overflow-hidden border border-white/10">
                                        <img
                                            src={authorizedThumbnailUrl}
                                            alt={file.file_name}
                                            className="w-full h-full object-cover"
                                            onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement?.classList.add('hidden'); }}
                                        />
                                    </div>
                                ) : (
                                    <div className="w-64 h-64 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-primary-500/20 to-pink-500/20 flex items-center justify-center border border-white/[0.08] shadow-2xl">
                                        <span className="text-8xl drop-shadow-lg">🎵</span>
                                    </div>
                                )}
                                <p className="text-2xl font-bold text-white mb-2 drop-shadow-md">{file.file_name}</p>
                                <p className="text-primary-400 font-medium">{formatDuration(currentTime)} / {formatDuration(duration)}</p>
                            </div>
                        )}
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
                        {isLoading && !isMinimized && (
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
                        <div className="w-12 h-12 rounded-lg bg-dark-800 flex items-center justify-center flex-shrink-0 overflow-hidden border border-white/5">
                            {authorizedThumbnailUrl
                                ? <img src={authorizedThumbnailUrl} alt="Thumb" className="w-full h-full object-cover" />
                                : (isVideo ? <span className="text-2xl">🎬</span> : <span className="text-2xl">🎵</span>)}
                        </div>
                        <div className="truncate flex-1 min-w-0">
                            <h4 className="text-sm font-bold text-white truncate leading-tight">{file.file_name}</h4>
                            <p className="text-xs text-dark-400 font-mono">{formatDuration(currentTime)} / {formatDuration(duration)}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(-10); }} className="p-2 text-dark-300 hover:text-white"><SkipBack className="w-5 h-5" /></button>
                        <button onClick={togglePlay} className="p-2 bg-primary-600 rounded-full text-white hover:bg-primary-500 shadow-lg shadow-primary-500/20">
                            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(10); }} className="p-2 text-dark-300 hover:text-white"><SkipForward className="w-5 h-5" /></button>
                    </div>
                    <div className="flex items-center gap-2 border-l border-white/10 pl-4">
                        <button onClick={() => setMinimized(false)} className="p-2 text-dark-400 hover:text-white" title="Maximize"><ChevronUp className="w-5 h-5" /></button>
                        <button onClick={onClose} className="p-2 text-dark-400 hover:text-red-400" title="Close"><X className="w-5 h-5" /></button>
                    </div>
                    <div className="absolute top-0 left-0 right-0 h-0.5 bg-dark-800">
                        <div className="h-full bg-primary-500" style={{ width: `${progressPercent}%` }}></div>
                    </div>
                </div>
            )}

            {/* Barra superiore: lascia passare i click al player, solo i pulsanti sono cliccabili.
                Nota: quando il fullscreen e' attivo sull'elemento del player, questa barra non e' visibile. */}
            {!error && !isMinimized && (
                <div
                    className={`absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/80 to-transparent flex items-start justify-between z-30 transition-opacity duration-300 pointer-events-none ${overlayVisible ? 'opacity-100' : 'opacity-0'}`}
                >
                    <h3 className="text-lg font-medium truncate max-w-lg text-white">{file.file_name}</h3>
                    <div className={`flex items-center gap-2 ${overlayVisible ? 'pointer-events-auto' : 'pointer-events-none'}`}>
                        {isVideo && (
                            <a
                                href={vlcUrl}
                                className="flex items-center gap-2 px-3 py-1.5 bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium rounded-lg transition-colors shadow-lg shadow-primary-500/20"
                                title="Apri in VLC"
                            >
                                <MonitorPlay className="w-4 h-4" />
                                <span className="hidden sm:inline">Apri in VLC</span>
                            </a>
                        )}
                        <button onClick={() => setMinimized(true)} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors ml-2" title="Minimize"><ChevronDown className="w-6 h-6" /></button>
                        <button onClick={onClose} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors"><X className="w-6 h-6" /></button>
                    </div>
                </div>
            )}

            {/* Controlli custom solo per l'audio */}
            {!isVideo && !error && !isMinimized && (
                <div
                    className={`absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/95 via-black/70 to-transparent z-30 transition-opacity duration-300 ${overlayVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                >
                    <div className="flex items-center gap-4 mb-4">
                        <span className="text-sm font-medium text-white/90 min-w-[50px] font-mono">{formatDuration(Math.floor(currentTime))}</span>
                        <div className="relative flex-1 h-1 bg-white/20 rounded-full">
                            <div className="absolute inset-y-0 left-0 bg-primary-500 rounded-full" style={{ width: `${progressPercent}%` }} />
                            <input
                                type="range"
                                min={0}
                                max={duration || 100}
                                value={currentTime}
                                onChange={handleSeek}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                            />
                        </div>
                        <span className="text-sm font-medium text-white/90 min-w-[50px] text-right font-mono">{formatDuration(Math.floor(duration))}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <button onClick={() => handleSkip(-10)} className="p-2 text-white/70 hover:text-white"><SkipBack className="w-6 h-6" /></button>
                            <button onClick={togglePlay} className="p-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all">
                                {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
                            </button>
                            <button onClick={() => handleSkip(10)} className="p-2 text-white/70 hover:text-white"><SkipForward className="w-6 h-6" /></button>
                            <button onClick={toggleMute} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white">
                                {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                            </button>
                            <input type="range" min={0} max={1} step={0.05} value={isMuted ? 0 : volume} onChange={handleVolumeChange} className="w-24" />
                        </div>
                        <button
                            onClick={cycleSpeed}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${playbackSpeed !== 1 ? 'bg-primary-500/30 text-primary-300 border border-primary-500/40' : 'bg-white/10 text-white/80 border border-white/10 hover:bg-white/20 hover:text-white'}`}
                            title="Playback Speed"
                        >
                            <Gauge className="w-4 h-4" /><span>{playbackSpeed}x</span>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}