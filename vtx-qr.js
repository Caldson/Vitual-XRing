/*
 * VTXQR —— 极简二维码生成器（无依赖）
 * 只实现 QR Code Model 2、字节模式、纠错等级 M、版本 1-10，足够放收款码链接。
 * 用法：
 *   VTXQR.encode("https://...") -> { size, modules }   // modules[row][col] = 0/1
 *   VTXQR.canvas("https://...", { scale: 8 })          -> HTMLCanvasElement
 */
(function (global) {
    "use strict";

    /* ---------- GF(256) ---------- */

    const EXP = new Uint8Array(512);
    const LOG = new Uint8Array(256);

    (function initTables() {
        let value = 1;
        for (let i = 0; i < 255; i += 1) {
            EXP[i] = value;
            LOG[value] = i;
            value <<= 1;
            if (value & 0x100) {
                value ^= 0x11d;
            }
        }
        for (let i = 255; i < 512; i += 1) {
            EXP[i] = EXP[i - 255];
        }
    })();

    function gfMul(left, right) {
        if (left === 0 || right === 0) {
            return 0;
        }
        return EXP[LOG[left] + LOG[right]];
    }

    function rsGenerator(degree) {
        let poly = [1];
        for (let i = 0; i < degree; i += 1) {
            const next = new Array(poly.length + 1).fill(0);
            for (let j = 0; j < poly.length; j += 1) {
                next[j] ^= poly[j];
                next[j + 1] ^= gfMul(poly[j], EXP[i]);
            }
            poly = next;
        }
        return poly;
    }

    function rsRemainder(data, degree) {
        const generator = rsGenerator(degree);
        const result = new Uint8Array(degree);
        for (const byte of data) {
            const factor = byte ^ result[0];
            result.copyWithin(0, 1);
            result[degree - 1] = 0;
            for (let i = 0; i < degree; i += 1) {
                result[i] ^= gfMul(generator[i + 1], factor);
            }
        }
        return result;
    }

    /* ---------- 版本表（纠错等级 M） ---------- */

    // blocks: [块数, 每块数据码字数]，第二组比第一组多 1 个数据码字
    const VERSIONS = {
        1: { ec: 10, blocks: [[1, 16]] },
        2: { ec: 16, blocks: [[1, 28]] },
        3: { ec: 26, blocks: [[1, 44]] },
        4: { ec: 18, blocks: [[2, 32]] },
        5: { ec: 24, blocks: [[2, 43]] },
        6: { ec: 16, blocks: [[4, 27]] },
        7: { ec: 18, blocks: [[4, 31]] },
        8: { ec: 22, blocks: [[2, 38], [2, 39]] },
        9: { ec: 22, blocks: [[3, 36], [2, 37]] },
        10: { ec: 26, blocks: [[4, 43], [1, 44]] }
    };

    const ALIGN = {
        1: [],
        2: [6, 18],
        3: [6, 22],
        4: [6, 26],
        5: [6, 30],
        6: [6, 34],
        7: [6, 22, 38],
        8: [6, 24, 42],
        9: [6, 26, 46],
        10: [6, 28, 50]
    };

    function dataCodewordCount(spec) {
        return spec.blocks.reduce((sum, [count, size]) => sum + count * size, 0);
    }

    function pickVersion(byteLength) {
        for (let version = 1; version <= 10; version += 1) {
            const spec = VERSIONS[version];
            const lengthBits = version >= 10 ? 16 : 8;
            const neededBits = 4 + lengthBits + byteLength * 8;
            if (neededBits <= dataCodewordCount(spec) * 8) {
                return version;
            }
        }
        throw new Error("内容太长，放不进二维码（上限约 210 字节）");
    }

    /* ---------- 位流 ---------- */

    function buildDataCodewords(bytes, version) {
        const spec = VERSIONS[version];
        const total = dataCodewordCount(spec);
        const bits = [];

        const push = (value, length) => {
            for (let i = length - 1; i >= 0; i -= 1) {
                bits.push((value >> i) & 1);
            }
        };

        push(0b0100, 4);
        push(bytes.length, version >= 10 ? 16 : 8);
        for (const byte of bytes) {
            push(byte, 8);
        }

        const capacity = total * 8;
        const terminator = Math.min(4, capacity - bits.length);
        for (let i = 0; i < terminator; i += 1) {
            bits.push(0);
        }
        while (bits.length % 8 !== 0) {
            bits.push(0);
        }

        const codewords = [];
        for (let i = 0; i < bits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8; j += 1) {
                byte = (byte << 1) | bits[i + j];
            }
            codewords.push(byte);
        }

        let pad = 0;
        while (codewords.length < total) {
            codewords.push(pad % 2 === 0 ? 0xec : 0x11);
            pad += 1;
        }
        return codewords;
    }

    function interleave(codewords, version) {
        const spec = VERSIONS[version];
        const blocks = [];
        let offset = 0;

        for (const [count, size] of spec.blocks) {
            for (let i = 0; i < count; i += 1) {
                const data = codewords.slice(offset, offset + size);
                offset += size;
                blocks.push({ data, ec: rsRemainder(data, spec.ec) });
            }
        }

        const result = [];
        const maxData = Math.max(...blocks.map((block) => block.data.length));

        for (let i = 0; i < maxData; i += 1) {
            for (const block of blocks) {
                if (i < block.data.length) {
                    result.push(block.data[i]);
                }
            }
        }
        for (let i = 0; i < spec.ec; i += 1) {
            for (const block of blocks) {
                result.push(block.ec[i]);
            }
        }
        return result;
    }

    /* ---------- 矩阵 ---------- */

    function createMatrix(size) {
        const rows = [];
        const reserved = [];
        for (let i = 0; i < size; i += 1) {
            rows.push(new Array(size).fill(0));
            reserved.push(new Array(size).fill(false));
        }
        return { rows, reserved };
    }

    function placeFinder(rows, reserved, row, col, size) {
        for (let r = -1; r <= 7; r += 1) {
            for (let c = -1; c <= 7; c += 1) {
                const y = row + r;
                const x = col + c;
                if (y < 0 || y >= size || x < 0 || x >= size) {
                    continue;
                }
                const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
                let dark = 0;
                if (inside) {
                    const ring = r === 0 || r === 6 || c === 0 || c === 6;
                    const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
                    dark = ring || core ? 1 : 0;
                }
                rows[y][x] = dark;
                reserved[y][x] = true;
            }
        }
    }

    function placeAlignment(rows, reserved, centerRow, centerCol, size) {
        for (let r = -2; r <= 2; r += 1) {
            for (let c = -2; c <= 2; c += 1) {
                const y = centerRow + r;
                const x = centerCol + c;
                if (y < 0 || y >= size || x < 0 || x >= size || reserved[y][x]) {
                    continue;
                }
                const ring = Math.max(Math.abs(r), Math.abs(c));
                rows[y][x] = ring === 1 ? 0 : 1;
                reserved[y][x] = true;
            }
        }
    }

    function placeFunctionPatterns(rows, reserved, version) {
        const size = rows.length;

        placeFinder(rows, reserved, 0, 0, size);
        placeFinder(rows, reserved, 0, size - 7, size);
        placeFinder(rows, reserved, size - 7, 0, size);

        for (let i = 8; i < size - 8; i += 1) {
            const dark = i % 2 === 0 ? 1 : 0;
            rows[6][i] = dark;
            reserved[6][i] = true;
            rows[i][6] = dark;
            reserved[i][6] = true;
        }

        const centers = ALIGN[version] || [];
        for (const row of centers) {
            for (const col of centers) {
                const nearFinder =
                    (row <= 8 && col <= 8) ||
                    (row <= 8 && col >= size - 9) ||
                    (row >= size - 9 && col <= 8);
                if (!nearFinder) {
                    placeAlignment(rows, reserved, row, col, size);
                }
            }
        }

        // 保留格式信息区 + 固定暗模块
        for (let i = 0; i <= 8; i += 1) {
            if (!reserved[8][i]) reserved[8][i] = true;
            if (!reserved[i][8]) reserved[i][8] = true;
        }
        for (let i = 0; i < 8; i += 1) {
            reserved[8][size - 1 - i] = true;
            reserved[size - 1 - i][8] = true;
        }
        rows[size - 8][8] = 1;

        if (version >= 7) {
            for (let i = 0; i < 6; i += 1) {
                for (let j = 0; j < 3; j += 1) {
                    reserved[i][size - 11 + j] = true;
                    reserved[size - 11 + j][i] = true;
                }
            }
        }
    }

    function placeData(rows, reserved, codewords) {
        const size = rows.length;
        let bitIndex = 0;
        const totalBits = codewords.length * 8;
        let upward = true;

        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) {
                right = 5;
            }
            for (let step = 0; step < size; step += 1) {
                const row = upward ? size - 1 - step : step;
                for (let k = 0; k < 2; k += 1) {
                    const col = right - k;
                    if (reserved[row][col]) {
                        continue;
                    }
                    let bit = 0;
                    if (bitIndex < totalBits) {
                        bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
                    }
                    rows[row][col] = bit;
                    bitIndex += 1;
                }
            }
            upward = !upward;
        }
    }

    const MASKS = [
        (row, col) => (row + col) % 2 === 0,
        (row) => row % 2 === 0,
        (row, col) => col % 3 === 0,
        (row, col) => (row + col) % 3 === 0,
        (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
        (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
        (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
        (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
    ];

    function applyMask(rows, reserved, maskIndex) {
        const mask = MASKS[maskIndex];
        const size = rows.length;
        for (let row = 0; row < size; row += 1) {
            for (let col = 0; col < size; col += 1) {
                if (!reserved[row][col] && mask(row, col)) {
                    rows[row][col] ^= 1;
                }
            }
        }
    }

    function penalty(rows) {
        const size = rows.length;
        let score = 0;

        for (let i = 0; i < size; i += 1) {
            let runRow = 1;
            let runCol = 1;
            for (let j = 1; j < size; j += 1) {
                if (rows[i][j] === rows[i][j - 1]) {
                    runRow += 1;
                } else {
                    if (runRow >= 5) score += runRow - 2;
                    runRow = 1;
                }
                if (rows[j][i] === rows[j - 1][i]) {
                    runCol += 1;
                } else {
                    if (runCol >= 5) score += runCol - 2;
                    runCol = 1;
                }
            }
            if (runRow >= 5) score += runRow - 2;
            if (runCol >= 5) score += runCol - 2;
        }

        for (let row = 0; row < size - 1; row += 1) {
            for (let col = 0; col < size - 1; col += 1) {
                const value = rows[row][col];
                if (value === rows[row][col + 1] && value === rows[row + 1][col] && value === rows[row + 1][col + 1]) {
                    score += 3;
                }
            }
        }

        const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
        const reversed = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
        const matches = (getter, index) => {
            let hit = 0;
            for (let k = 0; k < pattern.length; k += 1) {
                if (getter(index + k) !== pattern[k]) break;
                if (k === pattern.length - 1) hit += 1;
            }
            for (let k = 0; k < reversed.length; k += 1) {
                if (getter(index + k) !== reversed[k]) break;
                if (k === reversed.length - 1) hit += 1;
            }
            return hit;
        };

        for (let i = 0; i < size; i += 1) {
            for (let j = 0; j <= size - pattern.length; j += 1) {
                score += 40 * matches((index) => rows[i][index], j);
                score += 40 * matches((index) => rows[index][i], j);
            }
        }

        let dark = 0;
        for (let row = 0; row < size; row += 1) {
            for (let col = 0; col < size; col += 1) {
                dark += rows[row][col];
            }
        }
        const percent = (dark * 100) / (size * size);
        score += Math.floor(Math.abs(percent - 50) / 5) * 10;

        return score;
    }

    function bchFormat(maskIndex) {
        const ecBits = 0b00; // 纠错等级 M
        const data = (ecBits << 3) | maskIndex;
        let remainder = data << 10;
        for (let i = 14; i >= 10; i -= 1) {
            if ((remainder >> i) & 1) {
                remainder ^= 0x537 << (i - 10);
            }
        }
        return (((data << 10) | remainder) ^ 0x5412) & 0x7fff;
    }

    function placeFormat(rows, reserved, maskIndex) {
        const size = rows.length;
        const bits = bchFormat(maskIndex);
        const bit = (index) => (bits >> index) & 1;

        for (let i = 0; i <= 5; i += 1) {
            rows[8][i] = bit(14 - i);
            reserved[8][i] = true;
        }
        rows[8][7] = bit(8);
        rows[8][8] = bit(7);
        rows[7][8] = bit(6);
        for (let i = 9; i <= 14; i += 1) {
            rows[14 - i][8] = bit(14 - i);
            reserved[14 - i][8] = true;
        }

        for (let i = 0; i <= 7; i += 1) {
            rows[size - 1 - i][8] = bit(14 - i);
        }
        for (let i = 8; i <= 14; i += 1) {
            rows[8][size - 15 + i] = bit(14 - i);
        }
    }

    function placeVersionInfo(rows, reserved, version) {
        if (version < 7) {
            return;
        }
        const size = rows.length;
        let remainder = version << 12;
        for (let i = 17; i >= 12; i -= 1) {
            if ((remainder >> i) & 1) {
                remainder ^= 0x1f25 << (i - 12);
            }
        }
        const bits = (version << 12) | remainder;

        for (let i = 0; i < 18; i += 1) {
            const bit = (bits >> i) & 1;
            const row = Math.floor(i / 3);
            const col = size - 11 + (i % 3);
            rows[row][col] = bit;
            rows[col][row] = bit;
            reserved[row][col] = true;
            reserved[col][row] = true;
        }
    }

    function encode(text) {
        const bytes = Array.from(new TextEncoder().encode(String(text)));
        const version = pickVersion(bytes.length);
        const codewords = interleave(buildDataCodewords(bytes, version), version);

        let best = null;

        for (let maskIndex = 0; maskIndex < 8; maskIndex += 1) {
            const { rows, reserved } = createMatrix(17 + version * 4);
            placeFunctionPatterns(rows, reserved, version);
            placeVersionInfo(rows, reserved, version);
            placeData(rows, reserved, codewords);
            applyMask(rows, reserved, maskIndex);
            placeFormat(rows, reserved, maskIndex);

            const score = penalty(rows);
            if (!best || score < best.score) {
                best = { score, rows };
            }
        }

        return { version, size: best.rows.length, modules: best.rows };
    }

    function canvas(text, options) {
        const { modules, size } = encode(text);
        const scale = (options && options.scale) || 8;
        const quiet = (options && options.quiet) === undefined ? 4 : options.quiet;
        const canvasEl = document.createElement("canvas");
        const total = (size + quiet * 2) * scale;
        canvasEl.width = total;
        canvasEl.height = total;

        const ctx = canvasEl.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, total, total);
        ctx.fillStyle = "#000000";
        for (let row = 0; row < size; row += 1) {
            for (let col = 0; col < size; col += 1) {
                if (modules[row][col]) {
                    ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
                }
            }
        }
        return canvasEl;
    }

    global.VTXQR = { encode, canvas };
})(typeof window !== "undefined" ? window : globalThis);
