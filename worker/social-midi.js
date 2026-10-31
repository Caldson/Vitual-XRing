/*
 * Vitual XRing 3.1.0：MIDI 解析与“以曲识 MIDI”用的指纹。
 *
 * 浏览器里没有现成的 MIDI 解析器，Vimidi 上传的 .mid 在 Worker 里解析：
 *   - 取出音轨名 / 文本 / 版权 / 速度 / 时长；
 *   - 生成 note 序列指纹（FNV-1a），用于精确匹配 VMusic 已关联的 MIDI；
 *   - 生成 24 格音高直方图，用于没有精确指纹时的近似匹配。
 * 这里只做“识别”，不渲染、不播放；播放交给页面里的 <audio> 或外部音源。
 */

function ascii(bytes, start, length) {
    let text = "";
    for (let i = 0; i < length; i += 1) {
        text += String.fromCharCode(bytes[start + i] || 0);
    }
    return text;
}

function readU16(bytes, offset) {
    return ((bytes[offset] || 0) << 8) | (bytes[offset + 1] || 0);
}

function readU32(bytes, offset) {
    return (((bytes[offset] || 0) << 24) >>> 0)
        + ((bytes[offset + 1] || 0) << 16)
        + ((bytes[offset + 2] || 0) << 8)
        + (bytes[offset + 3] || 0);
}

function readVar(bytes, offset) {
    let value = 0;
    let pos = offset;
    for (let i = 0; i < 4; i += 1) {
        if (pos >= bytes.length) {
            return { value, next: pos };
        }
        const byte = bytes[pos];
        pos += 1;
        value = (value << 7) | (byte & 0x7f);
        if (!(byte & 0x80)) {
            break;
        }
    }
    return { value, next: pos };
}

function decodeText(bytes) {
    if (!bytes.length) {
        return "";
    }
    let text = "";
    try {
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (error) {
        text = "";
    }
    if (!text.trim()) {
        text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    }
    return text.replace(/\u0000+/g, "").replace(/\s+/g, " ").trim();
}

function fnv1a(text) {
    let hash = 2166136261;
    const source = String(text);
    for (let i = 0; i < source.length; i += 1) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/* 把 “tick” 换算成秒。tempos 按 tick 升序，tick 从 0 开始。 */
function secondsAtTick(tempos, division, targetTick) {
    if (!division) {
        return 0;
    }
    let seconds = 0;
    let lastTick = 0;
    let tempo = 500000;
    for (const item of tempos) {
        if (item.tick >= targetTick) {
            break;
        }
        seconds += ((item.tick - lastTick) / division) * (tempo / 1000000);
        lastTick = item.tick;
        if (Number(item.usPerQuarter) > 0) {
            tempo = Number(item.usPerQuarter);
        }
    }
    seconds += ((targetTick - lastTick) / division) * (tempo / 1000000);
    return Math.max(0, Math.round(seconds * 100) / 100);
}

/* 24 格音高直方图（0-23 = C..B 跨两个八度），返回和为 1 的数组。 */
function buildPitchProfile(notes) {
    const bins = new Array(24).fill(0);
    let total = 0;
    for (const note of notes) {
        const value = Math.max(0, Math.min(127, Number(note.note) || 0));
        const bin = value % 24;
        const weight = Math.max(1, Math.min(127, Number(note.velocity) || 64));
        bins[bin] += weight;
        total += weight;
    }
    if (!total) {
        return bins;
    }
    return bins.map((value) => Math.round((value / total) * 1000) / 1000);
}

export function analyzeMidi(input, fileName = "") {
    const bytes = input instanceof Uint8Array
        ? input
        : new Uint8Array(input instanceof ArrayBuffer ? input : (input && input.buffer) || []);
    let offset = 0;

    if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF") {
        let cursor = 12;
        while (cursor + 8 <= bytes.length) {
            const id = ascii(bytes, cursor, 4);
            const length = readU32(bytes, cursor + 4);
            if (id === "MThd") {
                offset = cursor;
                break;
            }
            cursor += 8 + length + (length & 1);
        }
    }

    if (offset + 14 > bytes.length || ascii(bytes, offset, 4) !== "MThd") {
        throw new Error("不是有效的 MIDI 文件（缺少 MThd）");
    }

    const headerLength = readU32(bytes, offset + 4);
    if (headerLength < 6) {
        throw new Error("MIDI 头长度不合法");
    }
    const format = readU16(bytes, offset + 8);
    const declaredTracks = readU16(bytes, offset + 10);
    const division = readU16(bytes, offset + 12);

    if (!division) {
        throw new Error("MIDI 时间分辨率不合法");
    }
    if (division & 0x8000) {
        throw new Error("暂不支持 SMPTE 时间格式的 MIDI");
    }

    let position = offset + 8 + headerLength;
    const notes = [];
    const tempos = [];
    const names = [];
    const texts = [];
    let copyright = "";
    let endTick = 0;
    let trackCount = 0;

    while (position + 8 <= bytes.length && trackCount < 64) {
        const chunkId = ascii(bytes, position, 4);
        const chunkLength = readU32(bytes, position + 4);
        const start = position + 8;
        const end = Math.min(bytes.length, start + chunkLength);
        position = end;

        if (chunkId !== "MTrk") {
            continue;
        }
        trackCount += 1;

        let cursor = start;
        let tick = 0;
        let running = 0;

        while (cursor < end) {
            const delta = readVar(bytes, cursor);
            tick += delta.value;
            cursor = delta.next;
            if (cursor >= end) {
                break;
            }

            let status = bytes[cursor];
            if (status < 0x80) {
                if (!running) {
                    cursor += 1;
                    continue;
                }
                status = running;
            } else {
                cursor += 1;
                if (status < 0xf0) {
                    running = status;
                }
            }

            if (status === 0xff) {
                if (cursor >= end) {
                    break;
                }
                const type = bytes[cursor++];
                const length = readVar(bytes, cursor);
                cursor = length.next;
                const payload = bytes.subarray(cursor, Math.min(end, cursor + length.value));
                cursor += length.value;

                if (type === 0x03) {
                    const text = decodeText(payload);
                    if (text) {
                        names.push(text);
                    }
                } else if (type === 0x01 || type === 0x04) {
                    const text = decodeText(payload);
                    if (text) {
                        texts.push(text);
                    }
                } else if (type === 0x02) {
                    const text = decodeText(payload);
                    if (text && !copyright) {
                        copyright = text;
                    }
                } else if (type === 0x51 && payload.length >= 3) {
                    const usPerQuarter = (payload[0] << 16) + (payload[1] << 8) + payload[2];
                    if (usPerQuarter > 0) {
                        tempos.push({ tick, usPerQuarter });
                    }
                }
                if (type === 0x2f) {
                    break;
                }
                continue;
            }

            if (status === 0xf0 || status === 0xf7) {
                const length = readVar(bytes, cursor);
                cursor = length.next + length.value;
                continue;
            }

            const high = status & 0xf0;
            const channel = status & 0x0f;

            if (high === 0xc0 || high === 0xd0) {
                cursor += 1;
                continue;
            }
            if (cursor + 1 >= end) {
                break;
            }
            const data1 = bytes[cursor++];
            const data2 = bytes[cursor++];
            if (high === 0x90 && data2 > 0 && notes.length < 60000) {
                notes.push({
                    tick,
                    note: data1 & 0x7f,
                    velocity: data2 & 0x7f,
                    channel: channel + 1
                });
            }
        }

        if (tick > endTick) {
            endTick = tick;
        }
    }

    tempos.sort((left, right) => left.tick - right.tick);
    const durationSeconds = secondsAtTick(tempos, division, endTick);
    const notesByTick = notes.slice().sort((left, right) => left.tick - right.tick);

    /* 指纹只取前 4000 个音，包含起始 tick、音高和力度，足以区分常见的改编。 */
    let signatureSeed = `${division}|${format}|`;
    for (let i = 0; i < Math.min(4000, notesByTick.length); i += 1) {
        const note = notesByTick[i];
        signatureSeed += `${note.tick}:${note.note}:${note.velocity};`;
    }
    const signature = fnv1a(signatureSeed);

    const bpm = tempos.length
        ? Math.round(60000000 / tempos[0].usPerQuarter)
        : 120;
    const fallbackName = String(fileName || "").replace(/\.(mid|midi|rmi)$/i, "").trim();
    const title = (names[0] || texts[0] || fallbackName || "未命名 MIDI").slice(0, 120);
    const artist = (names[1] || "").slice(0, 80);
    let minNote = 0;
    let maxNote = 0;
    for (const note of notes) {
        if (!minNote || note.note < minNote) {
            minNote = note.note;
        }
        if (note.note > maxNote) {
            maxNote = note.note;
        }
    }

    return {
        ok: true,
        format,
        tracks: declaredTracks,
        parsedTracks: trackCount,
        division,
        title,
        artist,
        copyright,
        texts: texts.slice(0, 8),
        bpm,
        durationSeconds,
        noteCount: notes.length,
        uniqueNotes: new Set(notes.map((note) => note.note)).size,
        minNote,
        maxNote,
        signature,
        pitchProfile: buildPitchProfile(notes)
    };
}

/* 余弦相似度，用于 MIDI 没有精确指纹时的近似识曲。 */
export function pitchSimilarity(left, right) {
    const a = Array.isArray(left) ? left : [];
    const b = Array.isArray(right) ? right : [];
    if (!a.length || !b.length) {
        return 0;
    }
    let dot = 0;
    let aa = 0;
    let bb = 0;
    const size = Math.min(a.length, b.length);
    for (let i = 0; i < size; i += 1) {
        const x = Number(a[i]) || 0;
        const y = Number(b[i]) || 0;
        dot += x * y;
        aa += x * x;
        bb += y * y;
    }
    if (!aa || !bb) {
        return 0;
    }
    return dot / Math.sqrt(aa * bb);
}

export function isMidiName(name) {
    return /\.(mid|midi|rmi)$/i.test(String(name || ""));
}

export function midiFileType(name) {
    return isMidiName(name) ? "audio/midi" : "audio/midi";
}
