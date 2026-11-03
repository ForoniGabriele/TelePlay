/**
 * Fast MKV/EBML Subtitle Extractor & Cache
 * - Probes subtitle tracks from the MKV header in < 200ms
 * - Progressively scans clusters with large chunks (2MB) instead of 100,000 tiny requests
 * - Yields cues immediately so opening scenes display subtitles in ~1-2 seconds
 * - Caches parsed tracks and cues in IndexedDB for instant reopening
 */

export interface SubtitleCue {
    start: number; // in seconds
    end: number;   // in seconds
    text: string;
}

export interface SubtitleTrackOption {
    id: number | string;
    label: string;
    language?: string;
    trackNumber: number;
    codecId: string;
}

export interface MkvFileInfo {
    segmentDataOffset: number;
    tracksPosition?: number;
    cuesPosition?: number;
    firstClusterOffset: number;
    fileSize: number;
    timestampScale: number; // in ns, default 1,000,000 (1ms)
}

// ---- EBML Primitives ----

function readElementId(data: Uint8Array, offset: number = 0): { id: number; length: number } | null {
    if (offset >= data.length) return null;
    const firstByte = data[offset];
    let mask = 0x80;
    let length = 1;
    while (length <= 4 && (firstByte & mask) === 0) {
        mask >>= 1;
        length++;
    }
    if (length > 4) return null;
    let id = 0;
    for (let i = 0; i < length; i++) {
        if (offset + i >= data.length) return null;
        id = (id * 256) + data[offset + i];
    }
    return { id, length };
}

function readVint(data: Uint8Array, offset: number = 0): { value: number; length: number } | null {
    if (offset >= data.length) return null;
    const firstByte = data[offset];
    let mask = 0x80;
    let length = 1;
    while (length <= 8 && (firstByte & mask) === 0) {
        mask >>= 1;
        length++;
    }
    if (length > 8) return null;
    let value = firstByte & (mask - 1);
    for (let i = 1; i < length; i++) {
        if (offset + i >= data.length) return null;
        value = (value * 256) + data[offset + i];
    }
    return { value, length };
}

function readUint(data: Uint8Array, offset: number, size: number): number {
    let val = 0;
    for (let i = 0; i < size; i++) {
        val = (val * 256) + data[offset + i];
    }
    return val;
}

function readString(data: Uint8Array, offset: number, size: number): string {
    return new TextDecoder().decode(data.subarray(offset, offset + size));
}

interface EbmlElement {
    id: number;
    offset: number;
    dataOffset: number;
    dataSize: number;
}

function* iterateElements(data: Uint8Array, start: number = 0, end: number = data.length): Generator<EbmlElement> {
    let offset = start;
    while (offset < end) {
        const idInfo = readElementId(data, offset);
        if (!idInfo) break;
        const sizeInfo = readVint(data, offset + idInfo.length);
        if (!sizeInfo) break;
        const headerSize = idInfo.length + sizeInfo.length;
        const dataOffset = offset + headerSize;
        const dataSize = sizeInfo.value;
        yield { id: idInfo.id, offset, dataOffset, dataSize };
        offset = dataOffset + dataSize;
    }
}

// Format track label (e.g. "Italiano · Track 3", "English · ASS")
export function describeSubtitleTrack(track: any, index: number): string {
    const name = track?.name || track?.label || track?.title;
    const lang = track?.language || track?.lang;
    const parts = [
        name,
        lang && lang !== 'und' ? String(lang).toUpperCase() : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : `Traccia ${index + 1}`;
}

// Clean ASS/SSA / SRT formatting
export function cleanSubtitleText(raw: string, codecId?: string): string {
    let text = raw;
    if (codecId === 'S_TEXT/ASS' || codecId === 'S_TEXT/SSA') {
        // ASS dialogue lines format: ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
        let commas = 0;
        let idx = 0;
        while (commas < 8 && idx < text.length) {
            if (text[idx] === ',') commas++;
            idx++;
        }
        if (commas === 8) {
            text = text.slice(idx);
        }
    }
    return text
        .replace(/\{[^}]*\}/g, '')            // strip ASS style override tags {\b1}, {\an8}, etc.
        .replace(/<[^>]+>/g, '')             // strip HTML tags
        .replace(/\\[Nn]/g, '\n')            // convert \N to newlines
        .replace(/\\h/g, ' ')                // non-breaking space
        .trim();
}

// ---- IndexedDB Cache ----

interface CachedData {
    tracks: SubtitleTrackOption[];
    cues: Record<string, SubtitleCue[]>;
}

const DB_NAME = 'teleplay-subtitles-cache';
const DB_VERSION = 1;
const STORE_NAME = 'files';

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE_NAME)) {
                req.result.createObjectStore(STORE_NAME);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function getCachedSubtitles(fileId: string | number): Promise<CachedData | null> {
    try {
        const db = await openDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(String(fileId));
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}

export async function saveCachedSubtitles(fileId: string | number, data: CachedData): Promise<void> {
    try {
        const db = await openDb();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(data, String(fileId));
    } catch {
        // Cache is best-effort
    }
}

// ---- MKV Header Probe (< 200ms) ----

const ID_EBML = 0x1A45DFA3;
const ID_SEGMENT = 0x18538067;
const ID_SEEKHEAD = 0x114D9B74;
const ID_SEEK = 0x4DBB;
const ID_SEEK_ID = 0x53AB;
const ID_SEEK_POSITION = 0x53AC;
const ID_INFO = 0x1549A966;
const ID_TIMESTAMPSCALE = 0x2AD7B1;
const ID_TRACKS = 0x1654AE6B;
const ID_TRACK_ENTRY = 0xAE;
const ID_TRACK_NUMBER = 0xD7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_LANGUAGE = 0x22B59C;
const ID_TRACK_NAME = 0x536E;
const ID_CUES = 0x1C53BB6B;
const ID_CLUSTER = 0x1F43B675;
const ID_CLUSTER_TIMESTAMP = 0xE7;
const ID_SIMPLE_BLOCK = 0xA3;
const ID_BLOCK_GROUP = 0xA0;
const ID_BLOCK = 0xA1;
const ID_BLOCK_DURATION = 0x9B;

export async function probeMkvSubtitleTracks(
    url: string,
    customHeaders: Record<string, string> = {}
): Promise<{ tracks: SubtitleTrackOption[]; info: MkvFileInfo | null }> {
    try {
        // Fetch first 512KB to inspect EBML Header, Segment & SeekHead
        const probeLength = 512 * 1024;
        const res = await fetch(url, {
            headers: {
                ...customHeaders,
                Range: `bytes=0-${probeLength - 1}`,
            },
        });

        if (!res.ok && res.status !== 206 && res.status !== 200) {
            return { tracks: [], info: null };
        }

        // Get total file size from Content-Range header
        const contentRange = res.headers.get('Content-Range');
        let fileSize = 0;
        if (contentRange) {
            const match = contentRange.match(/\/(\d+)$/);
            if (match) fileSize = parseInt(match[1], 10);
        }

        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length < 16) return { tracks: [], info: null };

        // Parse EBML Header
        let offset = 0;
        const ebmlEl = readElementId(buf, offset);
        if (!ebmlEl || ebmlEl.id !== ID_EBML) {
            return { tracks: [], info: null };
        }
        const ebmlSize = readVint(buf, offset + ebmlEl.length);
        if (!ebmlSize) return { tracks: [], info: null };
        offset = offset + ebmlEl.length + ebmlSize.length + ebmlSize.value;

        // Next element should be Segment
        const segmentEl = readElementId(buf, offset);
        if (!segmentEl || segmentEl.id !== ID_SEGMENT) {
            return { tracks: [], info: null };
        }
        const segmentSize = readVint(buf, offset + segmentEl.length);
        if (!segmentSize) return { tracks: [], info: null };

        const segmentDataOffset = offset + segmentEl.length + segmentSize.length;
        offset = segmentDataOffset;

        let tracksPosition: number | undefined;
        let cuesPosition: number | undefined;
        let firstClusterOffset: number = segmentDataOffset + 512 * 1024;
        let timestampScale = 1_000_000; // default: 1ms

        // Parse children inside Segment (up to end of probe buffer)
        let tracksData: Uint8Array | null = null;

        for (const el of iterateElements(buf, offset, buf.length)) {
            if (el.id === ID_SEEKHEAD) {
                // Parse Seek entries
                for (const seekEl of iterateElements(buf, el.dataOffset, el.dataOffset + el.dataSize)) {
                    if (seekEl.id === ID_SEEK) {
                        let seekId = 0;
                        let seekPos = 0;
                        for (const sf of iterateElements(buf, seekEl.dataOffset, seekEl.dataOffset + seekEl.dataSize)) {
                            if (sf.id === ID_SEEK_ID) {
                                seekId = readUint(buf, sf.dataOffset, sf.dataSize);
                            } else if (sf.id === ID_SEEK_POSITION) {
                                seekPos = readUint(buf, sf.dataOffset, sf.dataSize);
                            }
                        }
                        if (seekId === ID_TRACKS) tracksPosition = seekPos;
                        else if (seekId === ID_CUES) cuesPosition = seekPos;
                        else if (seekId === ID_CLUSTER && !firstClusterOffset) firstClusterOffset = segmentDataOffset + seekPos;
                    }
                }
            } else if (el.id === ID_INFO) {
                for (const infoField of iterateElements(buf, el.dataOffset, el.dataOffset + el.dataSize)) {
                    if (infoField.id === ID_TIMESTAMPSCALE) {
                        timestampScale = readUint(buf, infoField.dataOffset, infoField.dataSize);
                    }
                }
            } else if (el.id === ID_TRACKS) {
                // Tracks is already inside the 512KB buffer!
                tracksData = buf.subarray(el.offset, el.dataOffset + el.dataSize);
            } else if (el.id === ID_CLUSTER) {
                if (firstClusterOffset > el.offset) firstClusterOffset = el.offset;
            }
        }

        // If Tracks was not within the first 512KB but SeekHead gave its position, fetch it targeted:
        if (!tracksData && tracksPosition !== undefined) {
            const tracksAbsOffset = segmentDataOffset + tracksPosition;
            const tRes = await fetch(url, {
                headers: {
                    ...customHeaders,
                    Range: `bytes=${tracksAbsOffset}-${tracksAbsOffset + 65535}`,
                },
            });
            if (tRes.ok || tRes.status === 206) {
                const tBuf = new Uint8Array(await tRes.arrayBuffer());
                tracksData = tBuf;
            }
        }

        if (!tracksData) {
            return { tracks: [], info: null };
        }

        // Parse Tracks element for subtitle tracks (TrackType === 17)
        const tracks: SubtitleTrackOption[] = [];
        let rootOffset = 0;
        const tracksRoot = readElementId(tracksData, 0);
        if (tracksRoot && tracksRoot.id === ID_TRACKS) {
            const rSize = readVint(tracksData, tracksRoot.length);
            if (rSize) rootOffset = tracksRoot.length + rSize.length;
        }

        let idx = 0;
        for (const trEl of iterateElements(tracksData, rootOffset, tracksData.length)) {
            if (trEl.id === ID_TRACK_ENTRY) {
                let trackNumber = 0;
                let trackType = 0;
                let codecId = '';
                let language = '';
                let name = '';

                for (const field of iterateElements(tracksData, trEl.dataOffset, trEl.dataOffset + trEl.dataSize)) {
                    if (field.id === ID_TRACK_NUMBER) {
                        trackNumber = readUint(tracksData, field.dataOffset, field.dataSize);
                    } else if (field.id === ID_TRACK_TYPE) {
                        trackType = readUint(tracksData, field.dataOffset, field.dataSize);
                    } else if (field.id === ID_CODEC_ID) {
                        codecId = readString(tracksData, field.dataOffset, field.dataSize);
                    } else if (field.id === ID_LANGUAGE) {
                        language = readString(tracksData, field.dataOffset, field.dataSize);
                    } else if (field.id === ID_TRACK_NAME) {
                        name = readString(tracksData, field.dataOffset, field.dataSize);
                    }
                }

                // Subtitle tracks in Matroska have TrackType 17 (0x11)
                // We support text formats: S_TEXT/UTF8 (SRT), S_TEXT/ASS, S_TEXT/SSA, S_TEXT/WEBVTT
                if (trackType === 17 && (codecId.startsWith('S_TEXT/') || codecId.includes('UTF8') || codecId.includes('ASS') || codecId.includes('SSA'))) {
                    tracks.push({
                        id: trackNumber,
                        trackNumber,
                        codecId,
                        language,
                        label: describeSubtitleTrack({ name, language, trackNumber }, idx),
                    });
                    idx++;
                }
            }
        }

        const info: MkvFileInfo = {
            segmentDataOffset,
            tracksPosition,
            cuesPosition,
            firstClusterOffset,
            fileSize: fileSize || buf.length,
            timestampScale,
        };

        return { tracks, info };
    } catch (err) {
        console.error('Fast MKV probe failed:', err);
        return { tracks: [], info: null };
    }
}

// ---- Progressive Subtitle Extraction ----

export async function extractMkvSubtitleCues(
    url: string,
    track: SubtitleTrackOption,
    info: MkvFileInfo,
    onProgress?: (cues: SubtitleCue[]) => void,
    signal?: AbortSignal,
    customHeaders: Record<string, string> = {}
): Promise<SubtitleCue[]> {
    const allCues: SubtitleCue[] = [];
    const tsMultiplier = (info.timestampScale || 1_000_000) / 1e6; // to milliseconds
    const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB reads (matches backend chunking)

    let currentOffset = info.firstClusterOffset || info.segmentDataOffset + 512 * 1024;
    const maxOffset = info.fileSize ? Math.min(info.fileSize, currentOffset + 150 * 1024 * 1024) : currentOffset + 100 * 1024 * 1024;

    try {
        while (currentOffset < maxOffset) {
            if (signal?.aborted) break;

            const readEnd = Math.min(currentOffset + CHUNK_SIZE - 1, (info.fileSize || maxOffset) - 1);
            const res = await fetch(url, {
                headers: {
                    ...customHeaders,
                    Range: `bytes=${currentOffset}-${readEnd}`,
                },
                signal,
            });

            if (!res.ok && res.status !== 206 && res.status !== 200) {
                break;
            }

            const chunkBuf = new Uint8Array(await res.arrayBuffer());
            if (chunkBuf.length < 16) break;

            // Scan through clusters and blocks in this 2MB buffer in memory
            let chunkOffset = 0;
            let currentClusterTs = 0;
            let foundNewInChunk = false;

            while (chunkOffset < chunkBuf.length - 8) {
                const elId = readElementId(chunkBuf, chunkOffset);
                if (!elId) {
                    chunkOffset++;
                    continue;
                }

                // If element is a Cluster
                if (elId.id === ID_CLUSTER) {
                    const elSize = readVint(chunkBuf, chunkOffset + elId.length);
                    if (!elSize) {
                        chunkOffset += elId.length;
                        continue;
                    }
                    chunkOffset += elId.length + elSize.length;
                    continue;
                }

                // If Cluster Timestamp
                if (elId.id === ID_CLUSTER_TIMESTAMP) {
                    const elSize = readVint(chunkBuf, chunkOffset + elId.length);
                    if (elSize) {
                        const dOffset = chunkOffset + elId.length + elSize.length;
                        currentClusterTs = readUint(chunkBuf, dOffset, elSize.value);
                        chunkOffset = dOffset + elSize.value;
                        continue;
                    }
                }

                // If SimpleBlock or Block inside BlockGroup
                if (elId.id === ID_SIMPLE_BLOCK || elId.id === ID_BLOCK) {
                    const elSize = readVint(chunkBuf, chunkOffset + elId.length);
                    if (elSize && elSize.value > 3) {
                        const dOffset = chunkOffset + elId.length + elSize.length;
                        const blockTrack = readVint(chunkBuf, dOffset);

                        if (blockTrack && blockTrack.value === track.trackNumber) {
                            const relTimeOffset = dOffset + blockTrack.length;
                            if (relTimeOffset + 3 <= chunkBuf.length) {
                                const view = new DataView(chunkBuf.buffer, chunkBuf.byteOffset + relTimeOffset, 2);
                                const relTime = view.getInt16(0, false);
                                const payloadOffset = relTimeOffset + 3;
                                const payloadSize = (dOffset + elSize.value) - payloadOffset;

                                if (payloadSize > 0 && payloadOffset + payloadSize <= chunkBuf.length) {
                                    const rawText = readString(chunkBuf, payloadOffset, payloadSize);
                                    const cleanText = cleanSubtitleText(rawText, track.codecId);

                                    if (cleanText) {
                                        const startSec = (currentClusterTs + relTime * tsMultiplier) / 1000;
                                        // Default duration 3.5s if not specified by BlockDuration
                                        const endSec = startSec + 3.5;

                                        // Deduplicate
                                        if (!allCues.some(c => Math.abs(c.start - startSec) < 0.1 && c.text === cleanText)) {
                                            allCues.push({ start: Math.max(0, startSec), end: Math.max(startSec + 0.5, endSec), text: cleanText });
                                            foundNewInChunk = true;
                                        }
                                    }
                                }
                            }
                        }
                        chunkOffset = dOffset + elSize.value;
                        continue;
                    }
                }

                // If BlockGroup container, inspect Block and BlockDuration
                if (elId.id === ID_BLOCK_GROUP) {
                    const elSize = readVint(chunkBuf, chunkOffset + elId.length);
                    if (elSize) {
                        const bgDataOffset = chunkOffset + elId.length + elSize.length;
                        const bgEnd = bgDataOffset + elSize.value;
                        let blockDurationSec: number | null = null;

                        // Look for BlockDuration inside BlockGroup
                        for (const bgChild of iterateElements(chunkBuf, bgDataOffset, bgEnd)) {
                            if (bgChild.id === ID_BLOCK_DURATION) {
                                const durVal = readUint(chunkBuf, bgChild.dataOffset, bgChild.dataSize);
                                blockDurationSec = (durVal * tsMultiplier) / 1000;
                            }
                        }

                        // Look for Block
                        for (const bgChild of iterateElements(chunkBuf, bgDataOffset, bgEnd)) {
                            if (bgChild.id === ID_BLOCK) {
                                const blockTrack = readVint(chunkBuf, bgChild.dataOffset);
                                if (blockTrack && blockTrack.value === track.trackNumber) {
                                    const relTimeOffset = bgChild.dataOffset + blockTrack.length;
                                    if (relTimeOffset + 3 <= chunkBuf.length) {
                                        const view = new DataView(chunkBuf.buffer, chunkBuf.byteOffset + relTimeOffset, 2);
                                        const relTime = view.getInt16(0, false);
                                        const payloadOffset = relTimeOffset + 3;
                                        const payloadSize = (bgChild.dataOffset + bgChild.dataSize) - payloadOffset;
                                        if (payloadSize > 0 && payloadOffset + payloadSize <= chunkBuf.length) {
                                            const rawText = readString(chunkBuf, payloadOffset, payloadSize);
                                            const cleanText = cleanSubtitleText(rawText, track.codecId);
                                            if (cleanText) {
                                                const startSec = (currentClusterTs + relTime * tsMultiplier) / 1000;
                                                const duration = blockDurationSec || 3.5;
                                                const endSec = startSec + duration;
                                                if (!allCues.some(c => Math.abs(c.start - startSec) < 0.1 && c.text === cleanText)) {
                                                    allCues.push({ start: Math.max(0, startSec), end: Math.max(startSec + 0.5, endSec), text: cleanText });
                                                    foundNewInChunk = true;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        chunkOffset = bgEnd;
                        continue;
                    }
                }

                // Skip other elements
                const elSize = readVint(chunkBuf, chunkOffset + elId.length);
                if (elSize && elSize.value > 0) {
                    chunkOffset += elId.length + elSize.length + elSize.value;
                } else {
                    chunkOffset += elId.length + 1;
                }
            }

            if (foundNewInChunk) {
                allCues.sort((a, b) => a.start - b.start);
                onProgress?.([...allCues]);
            }

            currentOffset += CHUNK_SIZE;

            // Non-blocking yield to keep video stream & UI responsive
            await new Promise(r => setTimeout(r, 10));
        }
    } catch (err: any) {
        if (err?.name !== 'AbortError') {
            console.warn('Subtitle extraction scan warning:', err);
        }
    }

    allCues.sort((a, b) => a.start - b.start);
    return allCues;
}
