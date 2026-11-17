/**
 * MediaPlayer - full screen video/audio player
 * Video engines (canvas + Web Audio, no <video> element):
 *   - Movi (movi-player, WebCodecs + FFmpeg WASM): reads embedded audio AND subtitle tracks (SRT/ASS/PGS)
 *     straight from the file. Needs cross-origin isolation (COOP/COEP headers).
 *   - MediaFox: previous engine, used automatically when the page is not cross-origin isolated, or when
 *     localStorage 'player_engine' = 'mediafox'. It cannot read subtitles, so there you get server-extracted
 *     tracks (GET /files/{id}/subtitles[/{index}] -> WebVTT) and local .srt/.vtt files.
 * Audio: keeps the custom UI (<audio> element).
 */
import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
    X, Play, Pause, Volume2, VolumeX, Maximize, Minimize, SkipBack, SkipForward,
    ExternalLink, AlertTriangle, Copy, Gauge, ChevronDown, ChevronUp, Languages, Check, MonitorPlay,
} from 'lucide-react';
import { TelegramFile, formatDuration, useUpdateProgress, useFile, api } from '../lib/api';
import { useAppStore } from '../lib/store';

function describeTrack(track: any, index: number, fallback = 'Track'): string {
    const name = track?.name || track?.label || track?.title;
    const lang = track?.language || track?.lang || track?.languageCode;
    const codec = track?.codec ? String(track.codec).toUpperCase() : null;
    const parts = [name, lang && lang !== 'und' ? String(lang).toUpperCase() : null, codec].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : `${fallback} ${index + 1}`;
}

// ---- Subtitles (SRT / WebVTT) ----
interface Cue { start: number; end: number; text: string }
interface SubtitleTrackInfo { id: string; label: string; kind: 'embedded' | 'remote' | 'local' }

/** Thin adapter so the UI does not care whether Movi or MediaFox is underneath. */
interface Engine {
    play(): Promise<unknown> | void;
    pause(): void;
    seek(time: number): Promise<unknown> | void;
    setVolume(v: number): void;
    setRate(r: number): void;
    getTime(): number;
    selectAudio(id: number | string): Promise<unknown> | unknown;
    /** Embedded subtitle tracks drawn by the engine itself (Movi only). null = off. */
    selectSubtitle?(id: string | null): Promise<unknown> | unknown;
    setSubtitlePadding?(px: number): void;
}

function canUseMovi(): boolean {
    try { if (localStorage.getItem('player_engine') === 'mediafox') return false; } catch { /* ignore */ }
    return typeof window !== 'undefined' && window.crossOriginIsolated === true;
}

function parseTimestamp(raw: string): number {
    const parts = raw.trim().replace(',', '.').split(':').map(parseFloat);
    while (parts.length < 3) parts.unshift(0);
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/** Parses both SRT and WebVTT (same cue structure, only the decimal separator differs). */
function parseSubtitles(raw: string): Cue[] {
    const cues: Cue[] = [];
    const blocks = raw.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split('\n');
        const i = lines.findIndex((l) => l.includes('-->'));
        if (i < 0) continue;
        const [a, b] = lines[i].split('-->');
        const start = parseTimestamp(a);
        const end = parseTimestamp(b.trim().split(/\s+/)[0]);
        const text = lines.slice(i + 1).join('\n')
            .replace(/<[^>]+>/g, '')
            .replace(/\{\\[^}]*\}/g, '')
            .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
            .trim();
        if (text && Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text });
    }
    return cues.sort((x, y) => x.start - y.start);
}

/**
 * Draws the active subtitle cue. It owns its own tiny state and polls the player clock,
 * so a cue change never re-renders the whole MediaPlayer (that was a source of video stutter).
 */
function SubtitleOverlay({ cues, getTime, lifted }: { cues: Cue[] | null; getTime: () => number; lifted: boolean }) {
    const [text, setText] = useState('');
    useEffect(() => {
        if (!cues || cues.length === 0) { setText(''); return; }
        const tick = () => {
            const t = getTime();
            let active = '';
            for (const c of cues) {
                if (c.start > t) break;
                if (t < c.end) active += (active ? '\n' : '') + c.text;
            }
            setText(active);
        };
        tick();
        const id = setInterval(tick, 100);
        return () => clearInterval(id);
    }, [cues, getTime]);

    if (!text) return null;
    return (
        <div
            className={`absolute left-0 right-0 flex justify-center px-6 pointer-events-none z-20 transition-[bottom] duration-200 ${lifted ? 'bottom-36' : 'bottom-10'}`}
        >
            <p
                className="max-w-4xl text-center text-white text-xl sm:text-2xl font-medium leading-snug whitespace-pre-line px-3 py-1 rounded bg-black/55"
                style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}
            >
                {text}
            </p>
        </div>
    );
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
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const playerRef = useRef<Engine | null>(null);
    const moviOverlayRef = useRef<HTMLDivElement>(null);
    const lastPosRef = useRef(0);
    const useMovi = useMemo(() => canUseMovi(), []);
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
    const hideControlsTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [publicUrl, setPublicUrl] = useState<string | null>(null);
    const resumeApplied = useRef(false);

    // ---- Audio tracks ----
    const [audioTracks, setAudioTracks] = useState<{ id: number | string; label: string }[]>([]);
    const [selectedAudio, setSelectedAudio] = useState<number | string | null>(null);
    const [showAudioMenu, setShowAudioMenu] = useState(false);

    // ---- Subtitles ----
    const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackInfo[]>([]);
    const [selectedSub, setSelectedSub] = useState<string | null>(null);
    const [activeCues, setActiveCues] = useState<Cue[] | null>(null);
    const [subLoading, setSubLoading] = useState(false);
    const [subError, setSubError] = useState<string | null>(null);
    const cueCache = useRef<Map<string, Cue[]>>(new Map());
    const subRequest = useRef(0);
    const subInputRef = useRef<HTMLInputElement>(null);
    // true only while something on screen actually shows the clock (controls visible / minimized bar)
    const uiActiveRef = useRef(true);

    const isVideo = file.file_type === 'video';

    const { data: extendedFile } = useFile(file.id);
    lastPosRef.current = extendedFile?.last_pos ?? 0;
    const { mutate: updateProgress } = useUpdateProgress();

    const token = localStorage.getItem('access_token');
    const getAbsoluteUrl = (url: string) =>
        !url ? '' : url.startsWith('http') ? url : `${window.location.origin}${url}`;
    const relativeStreamUrl = `${file.stream_url}?token=${token}`;
    const authorizedStreamUrl = getAbsoluteUrl(relativeStreamUrl);
    const externalUrl = publicUrl || authorizedStreamUrl;

    // VLC Desktop usually needs vlc://<url>
    const vlcUrl = `vlc://${externalUrl}`;

    const relativeThumbnailUrl = file.thumbnail_url ? `${file.thumbnail_url}?token=${token}` : null;
    const authorizedThumbnailUrl = relativeThumbnailUrl ? getAbsoluteUrl(relativeThumbnailUrl) : null;

    // ---- Public link (for VLC / external use) ----
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file.id, extendedFile]);

    useEffect(() => { resumeApplied.current = false; }, [file.id]);

    // ---- Progress saving ----
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

    // ---- Controls ----
    const togglePlay = (e?: any) => {
        e?.stopPropagation?.();
        const p = playerRef.current;
        if (p) {
            if (isPlaying) p.pause();
            else Promise.resolve(p.play()).catch(() => { });
            return;
        }
        const el = audioRef.current;
        if (el) { el.paused ? el.play().catch(() => { }) : el.pause(); }
    };

    const toggleMute = () => {
        const p = playerRef.current;
        if (p) { p.setVolume(isMuted ? (volume || 1) : 0); setIsMuted(!isMuted); return; }
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
        if (playerRef.current) playerRef.current.setRate(nextSpeed);
        else if (audioRef.current) audioRef.current.playbackRate = nextSpeed;
    };

    const handleSkip = (seconds: number) => {
        const p = playerRef.current;
        if (p) {
            const max = advDuration.current || Infinity;
            const target = Math.min(max, Math.max(0, advTime.current + seconds));
            Promise.resolve(p.seek(target)).catch(() => { });
            setCurrentTime(target);
            return;
        }
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
        if (playerRef.current) playerRef.current.setVolume(vol);
        else if (audioRef.current) audioRef.current.volume = vol;
        setVolume(vol);
        setIsMuted(vol === 0);
    };

    const selectAudioTrack = async (id: number | string) => {
        const p = playerRef.current;
        if (!p) return;
        try { await p.selectAudio(id); setSelectedAudio(id); }
        catch (err) { console.error('Failed to switch audio track:', err); }
        setShowAudioMenu(false);
    };

    // Player clock for the subtitle overlay (falls back to the last value pushed by subscribe)
    const getPlayerTime = useCallback(() => {
        const t = playerRef.current?.getTime();
        return typeof t === 'number' && Number.isFinite(t) ? t : advTime.current;
    }, []);

    const selectSubtitle = async (id: string | null) => {
        const req = ++subRequest.current;
        setSubError(null);
        const track = subtitleTracks.find((t) => t.id === id);
        const engine = playerRef.current;

        // Off, or an embedded track drawn by the engine itself (Movi)
        if (id === null || track?.kind === 'embedded') {
            setActiveCues(null);
            try {
                await engine?.selectSubtitle?.(id);
                setSelectedSub(id);
                setShowAudioMenu(false);
            } catch (err) {
                console.error('Failed to switch subtitle track:', err);
                setSubError('Impossibile attivare questa traccia di sottotitoli');
            }
            return;
        }

        // Our own renderer (server-extracted or local file): make sure the engine draws nothing
        try { await engine?.selectSubtitle?.(null); } catch { /* ignore */ }
        setSelectedSub(id);

        const cached = cueCache.current.get(id);
        if (cached) { setActiveCues(cached); setShowAudioMenu(false); return; }

        setSubLoading(true);
        try {
            // Backend: GET /files/{id}/subtitles/{index} -> WebVTT text
            const { data } = await api.get<string>(`/files/${file.id}/subtitles/${id}`, {
                responseType: 'text',
                transformResponse: (r: any) => r,
            });
            if (req !== subRequest.current) return;
            const cues = parseSubtitles(String(data));
            if (cues.length === 0) throw new Error('empty subtitle track');
            cueCache.current.set(id, cues);
            setActiveCues(cues);
            setShowAudioMenu(false);
        } catch (err) {
            console.error('Failed to load subtitles:', err);
            if (req !== subRequest.current) return;
            setSelectedSub(null);
            setActiveCues(null);
            setSubError('Impossibile caricare questa traccia di sottotitoli');
        } finally {
            if (req === subRequest.current) setSubLoading(false);
        }
    };

    const handleSubtitleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try {
            const buf = await f.arrayBuffer();
            let text: string;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
            catch { text = new TextDecoder('windows-1252').decode(buf); } // old SRT files
            const cues = parseSubtitles(text);
            if (cues.length === 0) { setSubError('File sottotitoli non valido (supportati .srt e .vtt)'); return; }
            const id = `local-${Date.now()}`;
            cueCache.current.set(id, cues);
            subRequest.current++;
            try { await playerRef.current?.selectSubtitle?.(null); } catch { /* ignore */ }
            setSubtitleTracks((prev) => [...prev.filter((t) => t.kind !== 'local'), { id, label: f.name, kind: 'local' }]);
            setSelectedSub(id);
            setActiveCues(cues);
            setSubError(null);
            setShowAudioMenu(false);
        } catch (err) {
            console.error('Failed to read subtitle file:', err);
            setSubError('Impossibile leggere il file');
        }
    };

    // Embedded subtitle list (extracted server-side, since MediaFox/Mediabunny cannot read subtitle tracks)
    useEffect(() => {
        if (!isVideo) return;
        let cancelled = false;
        subRequest.current++;
        cueCache.current.clear();
        setSubtitleTracks([]);
        setSelectedSub(null);
        setActiveCues(null);
        setSubError(null);
        if (useMovi) return; // Movi lists the embedded tracks itself once the file is loaded
        api.get(`/files/${file.id}/subtitles`)
            .then(({ data }) => {
                if (cancelled || !Array.isArray(data)) return;
                setSubtitleTracks((prev) => [
                    ...data.map((t: any, i: number): SubtitleTrackInfo => ({
                        id: String(t.index ?? i),
                        label: describeTrack(t, i, 'Sottotitoli'),
                        kind: 'remote',
                    })),
                    ...prev.filter((t) => t.kind === 'local'),
                ]);
            })
            .catch(() => { /* endpoint not available: only local .srt/.vtt files can be loaded */ });
        return () => { cancelled = true; };
    }, [file.id, isVideo]);

    // ---- Engine initialization (video only) ----
    useEffect(() => {
        if (!isVideo || !canvasRef.current) return;

        let cancelled = false;
        let dispose: (() => void) | null = null;
        const unsubscribers: Array<() => void> = [];
        let lastUiUpdate = 0;
        let wasPlaying = false;

        setIsLoading(true);
        setError(null);
        advTime.current = 0;
        advDuration.current = 0;

        // Shared clock handling. The clock always goes into a ref (free); React state is updated at most
        // ~4x/second and only if something visible uses it. Re-rendering this big component on every
        // player tick starves the main thread and makes the canvas drop frames while audio keeps going.
        const pushUi = (force: boolean) => {
            const now = performance.now();
            if (uiActiveRef.current && (force || now - lastUiUpdate >= 250)) {
                lastUiUpdate = now;
                setCurrentTime(advTime.current);
            }
        };
        const onTime = (t: number) => { if (Number.isFinite(t)) { advTime.current = t; pushUi(false); } };
        const onDuration = (d: number) => {
            if (d && Number.isFinite(d) && d !== advDuration.current) { advDuration.current = d; setDuration(d); }
        };
        const onPlaying = (playing: boolean) => {
            setIsPlaying(playing);
            if (wasPlaying && !playing) saveProgressRef.current();
            const changed = playing !== wasPlaying;
            wasPlaying = playing;
            pushUi(changed);
        };
        const onFail = (msg: string) => { if (!cancelled) { setError(msg); setIsLoading(false); } };

        // ---------- Movi ----------
        const startMovi = async () => {
            const { MoviPlayer } = await import('movi-player/player');
            if (cancelled || !canvasRef.current) return;
            const canvas = canvasRef.current;
            const player: any = new MoviPlayer({
                source: { type: 'url', url: authorizedStreamUrl },
                canvas,
                renderer: 'canvas',
                decoder: 'auto',
            });
            dispose = () => player.destroy();

            // method names differ slightly between releases (select* in the docs, set* in older builds)
            const call = (names: string[], ...args: any[]) => {
                for (const n of names) if (typeof player[n] === 'function') return player[n](...args);
                throw new Error(`MoviPlayer: ${names.join(' / ')} not available`);
            };

            playerRef.current = {
                play: () => player.play(),
                pause: () => player.pause(),
                seek: (t) => player.seek(t),
                setVolume: (v) => player.setVolume(v),
                setRate: (r) => player.setPlaybackRate(r),
                getTime: () => player.getCurrentTime(),
                selectAudio: (id) => {
                    if (call(['selectAudioTrack', 'setAudioTrack'], Number(id)) === false) throw new Error('audio switch failed');
                },
                selectSubtitle: async (id) => {
                    const ok = await call(['selectSubtitleTrack', 'setSubtitleTrack'], id === null ? null : Number(id));
                    if (ok === false) throw new Error('subtitle switch failed');
                },
                setSubtitlePadding: (px) => player.setSubtitleControlsPadding?.(px),
            };

            // Canvas backing store follows the element size (MoviPlayer does not observe it by itself)
            player.setFitMode?.('contain');
            const resize = () => {
                const r = canvas.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) player.resizeCanvas?.(Math.round(r.width), Math.round(r.height));
            };
            const ro = new ResizeObserver(resize);
            ro.observe(canvas);
            unsubscribers.push(() => ro.disconnect());
            resize();

            player.setSubtitleOverlay?.(moviOverlayRef.current);
            playerRef.current.setSubtitlePadding?.(uiActiveRef.current ? 120 : 24);
            player.setVolume(isMuted ? 0 : volume);

            player.on('timeUpdate', onTime);
            player.on('durationChange', onDuration);
            player.on('stateChange', (state: string) => {
                onPlaying(state === 'playing');
                if (state === 'loading' || state === 'buffering' || state === 'seeking') setIsLoading(true);
                else if (state !== 'idle') setIsLoading(false);
            });
            player.on('ended', () => { setIsPlaying(false); saveProgressRef.current(); });
            player.on('error', (e: any) => {
                console.error('Movi player error:', e);
                onFail('The player could not play this file. The format may not be supported.');
            });

            await player.load();
            if (cancelled) return;
            onDuration(player.getDuration());

            const audio: any[] = player.getAudioTracks?.() ?? [];
            setAudioTracks(audio.map((t, i) => ({ id: t.id, label: describeTrack(t, i) })));
            setSelectedAudio(audio[0]?.id ?? null);

            const subs: any[] = player.getSubtitleTracks?.() ?? [];
            setSubtitleTracks(subs.map((t, i): SubtitleTrackInfo => ({
                id: String(t.id),
                label: describeTrack(t, i, 'Sottotitoli'),
                kind: 'embedded',
            })));

            const start = lastPosRef.current;
            if (start > 1) await player.seek(start);
            if (cancelled) return;

            setIsLoading(false);
            await player.play();
        };

        // ---------- MediaFox (fallback) ----------
        const startMediaFox = async () => {
            const { MediaFox } = await import('@mediafox/core');
            if (cancelled || !canvasRef.current) return;

            const player: any = new MediaFox({ renderTarget: canvasRef.current, volume: isMuted ? 0 : volume });
            dispose = () => { const d = player?.dispose ?? player?.destroy; d?.call(player); };

            playerRef.current = {
                play: () => player.play(),
                pause: () => player.pause(),
                seek: (t) => player.seek(t),
                setVolume: (v) => { player.volume = v; },
                setRate: (r) => { player.playbackRate = r; },
                getTime: () => (typeof player.currentTime === 'number' ? player.currentTime : advTime.current),
                selectAudio: (id) => player.selectAudioTrack(id),
            };

            const unsubscribe = player.subscribe((s: any) => {
                onTime(s.currentTime ?? advTime.current);
                onDuration(s.duration);
                onPlaying(!!(s.playing ?? s.state === 'playing'));
            });
            if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);

            player.on?.('error', () => onFail('The player could not play this file. The format may not be supported.'));

            await player.load(authorizedStreamUrl);
            if (cancelled) return;

            const tracks: any[] = player.getAudioTracks?.() ?? [];
            setAudioTracks(tracks.map((t, i) => ({ id: t.id, label: describeTrack(t, i) })));
            setSelectedAudio(tracks[0]?.id ?? null);

            const start = lastPosRef.current;
            if (start > 1) await player.seek(start);
            if (cancelled) return;

            setIsLoading(false);
            await player.play();
        };

        (async () => {
            try {
                await (useMovi ? startMovi() : startMediaFox());
            } catch (err) {
                console.error('Video engine failed:', err);
                onFail('The player could not load this file. The format may not be supported.');
            }
        })();

        return () => {
            cancelled = true;
            unsubscribers.forEach((u) => u());
            try { dispose?.(); } catch { /* ignore */ }
            playerRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVideo, file.id]);

    // ---- Fullscreen state ----
    useEffect(() => {
        const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onFsChange);
        return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

    // ---- Keyboard shortcuts ----
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isFullscreen, onClose, error, isPlaying, isMinimized, isMuted]);

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

    const MediaElement = isVideo ? (
        <canvas ref={canvasRef} className="w-full h-full object-contain" />
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
    uiActiveRef.current = overlayVisible || isMinimized;

    // Keep Movi's own subtitles clear of the control bar
    useEffect(() => {
        playerRef.current?.setSubtitlePadding?.(overlayVisible ? 120 : 24);
    }, [overlayVisible]);

    // When the controls show up again, catch the clock up immediately
    useEffect(() => {
        if (isVideo && (overlayVisible || isMinimized)) setCurrentTime(advTime.current);
    }, [isVideo, overlayVisible, isMinimized]);

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
                            <a href={vlcUrl} className="btn-primary flex items-center justify-center gap-2 bg-primary-600 hover:bg-primary-500">
                                <MonitorPlay className="w-5 h-5" />Apri in VLC
                            </a>
                            <a href={externalUrl} className="btn-secondary flex items-center justify-center gap-2">
                                <ExternalLink className="w-4 h-4" />Apri URL Diretto
                            </a>
                            <div className="flex gap-3 mt-2">
                                <Button
                                    onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(externalUrl); }}
                                    className="flex-1 btn-secondary flex items-center justify-center gap-2"
                                >
                                    <Copy className="w-4 h-4" />Copia URL
                                </Button>
                            </div>
                        </div>
                        <button onClick={onClose} className="mt-6 text-dark-400 hover:text-white text-sm transition-colors">Chiudi</button>
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
                                            onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement?.classList.add('hidden'); }}
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
                        {useMovi && isVideo && (
                            <div
                                ref={moviOverlayRef}
                                className="absolute inset-0 pointer-events-none z-20"
                                style={{ color: '#fff', textAlign: 'center', fontSize: 'clamp(18px, 2.4vw, 34px)', textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}
                            />
                        )}
                        {isVideo && !isMinimized && (
                            <SubtitleOverlay cues={activeCues} getTime={getPlayerTime} lifted={overlayVisible} />
                        )}
                        {isLoading && !error && !isMinimized && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                                <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary-500"></div>
                            </div>
                        )}
                    </>
                )}
            </div>

            <input
                ref={subInputRef}
                type="file"
                accept=".srt,.vtt,text/vtt"
                className="hidden"
                onChange={handleSubtitleFile}
            />

            {/* Minimized controls */}
            {isMinimized && (
                <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 p-3 h-full">
                    <div className="flex items-center gap-3 overflow-hidden flex-1 cursor-pointer" onClick={() => setMinimized(false)}>
                        <div className="w-12 h-12 rounded-lg bg-dark-800 flex items-center justify-center flex-shrink-0 overflow-hidden border border-white/5 relative">
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
                        <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="p-2 bg-primary-600 rounded-full text-white hover:bg-primary-500 shadow-lg shadow-primary-500/20">
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

            {/* Overlay: top bar and custom controls */}
            {!error && !isMinimized && (
                <div
                    className={`absolute inset-0 transition-opacity duration-300 ${overlayVisible ? 'opacity-100' : 'opacity-0'} ${!overlayVisible ? 'cursor-none' : ''}`}
                    style={{ pointerEvents: overlayVisible ? 'auto' : 'none' }}
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

                            {/* VLC button */}
                            {isVideo && (
                                <a
                                    href={vlcUrl}
                                    className="flex items-center gap-2 px-3 py-1.5 bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium rounded-lg transition-colors shadow-lg shadow-primary-500/20"
                                    title="Apri in VLC (Consigliato per MKV con sottotitoli)"
                                >
                                    <MonitorPlay className="w-4 h-4" />
                                    <span className="hidden sm:inline">Apri in VLC</span>
                                </a>
                            )}

                            {/* Audio & subtitles menu */}
                            {isVideo && (
                                <div className="relative ml-2">
                                    <button
                                        onClick={() => setShowAudioMenu((v) => !v)}
                                        className={`p-2 hover:bg-white/20 rounded-full transition-colors flex items-center gap-1.5 ${selectedSub ? 'text-primary-300' : 'text-white'}`}
                                        title="Audio e sottotitoli"
                                    >
                                        <Languages className="w-5 h-5" />
                                    </button>
                                    {showAudioMenu && (
                                        <div className="absolute right-0 top-full mt-2 min-w-[250px] max-h-[70vh] overflow-y-auto bg-dark-800 border border-white/10 rounded-xl shadow-2xl p-1 z-40">
                                            <p className="px-3 py-2 text-xs text-dark-400">Audio</p>
                                            {audioTracks.length === 0 && <p className="px-3 py-2 text-sm text-dark-300">No audio tracks found</p>}
                                            {audioTracks.map((track) => (
                                                <button
                                                    key={String(track.id)}
                                                    onClick={() => selectAudioTrack(track.id)}
                                                    className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors hover:bg-white/10 ${selectedAudio === track.id ? 'text-primary-300' : 'text-white'}`}
                                                >
                                                    <span className="truncate">{track.label}</span>
                                                    {selectedAudio === track.id && <Check className="w-4 h-4 shrink-0" />}
                                                </button>
                                            ))}

                                            <p className="px-3 py-2 mt-1 text-xs text-dark-400 border-t border-white/10">Sottotitoli</p>
                                            <button
                                                onClick={() => selectSubtitle(null)}
                                                className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors hover:bg-white/10 ${selectedSub === null ? 'text-primary-300' : 'text-white'}`}
                                            >
                                                <span>Disattivati</span>
                                                {selectedSub === null && <Check className="w-4 h-4 shrink-0" />}
                                            </button>
                                            {subtitleTracks.map((track) => (
                                                <button
                                                    key={track.id}
                                                    onClick={() => selectSubtitle(track.id)}
                                                    className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors hover:bg-white/10 ${selectedSub === track.id ? 'text-primary-300' : 'text-white'}`}
                                                >
                                                    <span className="truncate">{track.label}</span>
                                                    {selectedSub === track.id && <Check className="w-4 h-4 shrink-0" />}
                                                </button>
                                            ))}
                                            <button
                                                onClick={() => subInputRef.current?.click()}
                                                className="w-full px-3 py-2 rounded-lg text-sm text-left text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                                            >
                                                Carica file .srt / .vtt…
                                            </button>
                                            {subLoading && <p className="px-3 py-2 text-xs text-dark-300">Caricamento sottotitoli…</p>}
                                            {subError && <p className="px-3 py-2 text-xs text-red-400">{subError}</p>}
                                        </div>
                                    )}
                                </div>
                            )}

                            <button onClick={() => setMinimized(true)} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors ml-2" title="Minimize"><ChevronDown className="w-6 h-6" /></button>
                            <button onClick={onClose} className="p-2 text-white hover:bg-white/20 rounded-full transition-colors"><X className="w-6 h-6" /></button>
                        </div>
                    </div>

                    {/* Center controls */}
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex items-center gap-8 z-30">
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(-10); }} className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all"><SkipBack className="w-8 h-8" /></button>
                        <button onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="w-20 h-20 bg-black/50 rounded-full flex items-center justify-center hover:bg-black/70 transition-colors">
                            {isPlaying ? <Pause className="w-10 h-10 text-white" /> : <Play className="w-10 h-10 ml-1 text-white" />}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleSkip(10); }} className="p-4 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-all"><SkipForward className="w-8 h-8" /></button>
                    </div>

                    {/* Bottom controls */}
                    <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/95 via-black/70 to-transparent z-30">
                        <div className="flex items-center gap-4 mb-4 group/progress">
                            <span className="text-sm font-medium text-white/90 min-w-[50px] font-mono">{formatDuration(Math.floor(currentTime))}</span>
                            <div className="relative flex-1 h-1 bg-white/20 rounded-full cursor-pointer group-hover/progress:h-2 transition-all">
                                <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary-500 to-primary-400 rounded-full transition-[width] duration-300 ease-linear" style={{ width: `${progressPercent}%` }}>
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
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${playbackSpeed !== 1 ? 'bg-primary-500/30 text-primary-300 border border-primary-500/40' : 'bg-white/10 text-white/80 border border-white/10 hover:bg-white/20 hover:text-white'}`}
                                    title="Playback Speed"
                                >
                                    <Gauge className="w-4 h-4" /><span>{playbackSpeed}x</span>
                                </button>
                                <button
                                    onClick={toggleFullscreen}
                                    className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-all"
                                    title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
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