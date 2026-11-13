/*
 * Vitual XRing 10.1.0 — 全站 BGM 播放器 + 听歌赚钱
 *
 * - 由 vtx-theme.js 自动加载，不需要每个页面单独引 script；
 * - 右下角常驻一个可折叠播放器，目前 1 首 BGM；
 * - 单曲 / 顺序 / 随机循环、播放暂停、音量；
 * - 播放时每 20 秒调用 /api/me/bgm/reward，服务端按真实时间发 0.01 VTX；
 * - manager.html 打开时额外播放 Opening 音效。
 */
(function () {
    "use strict";

    if (window.__vtxBgmLoaded) return;
    window.__vtxBgmLoaded = true;

    const TRACKS = [
        {
            src: "audio/your-beat.mp3",
            title: "Your beat, that's your beat",
            artist: "Vitual XRing"
        }
    ];
    const OPENING_SRC = "audio/opening.mp3";
    const KEY_VOLUME = "vtx:bgm:volume";
    const KEY_MODE = "vtx:bgm:mode";
    const KEY_PLAYING = "vtx:bgm:playing";
    const KEY_TIME = "vtx:bgm:time";
    const MODES = [
        { id: "single", label: "单曲循环", icon: "🔂" },
        { id: "sequence", label: "顺序循环", icon: "🔁" },
        { id: "shuffle", label: "随机循环", icon: "🔀" }
    ];
    let apiLoading = null;

    /* 10.1.0：首页 / 商店等页面不一定加载 vtx-api.js。播放器按需补上，
       否则登录检测和听歌奖励只在聊天室 / 账户页有效。 */
    function ensureApi() {
        if (window.VTXApi) return Promise.resolve(window.VTXApi);
        if (apiLoading) return apiLoading;
        apiLoading = new Promise((resolve) => {
            try {
                const script = document.createElement("script");
                script.src = "vtx-api.js";
                script.async = true;
                script.onload = () => resolve(window.VTXApi || null);
                script.onerror = () => resolve(null);
                document.head.appendChild(script);
            } catch (error) {
                resolve(null);
            }
        });
        return apiLoading;
    }
    const el = (id) => document.getElementById(id);
    let audio = null;
    let playingIndex = 0;
    let mode = "single";
    let sessionStarted = false;
    let rewardTimer = 0;
    let saveTimer = 0;
    let toastTimer = 0;
    let expanded = false;
    let openingAudio = null;

    function read(key, fallback) {
        try {
            const value = localStorage.getItem(key);
            return value === null ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function write(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch (error) {
            /* 隐私模式忽略 */
        }
    }

    function toast(text) {
        let node = el("vtx-bgm-toast");
        if (!node) {
            node = document.createElement("div");
            node.id = "vtx-bgm-toast";
            node.className = "vtx-bgm-toast";
            document.body.appendChild(node);
        }
        node.textContent = text;
        node.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
    }

    function injectStyle() {
        if (el("vtx-bgm-style")) return;
        const style = document.createElement("style");
        style.id = "vtx-bgm-style";
        style.textContent = `
            #vtx-bgm { position: fixed; right: 16px; bottom: calc(16px + var(--vtx-widget-lift, 0px)); z-index: 9998; font-family: var(--vtx-font, "Segoe UI", "Microsoft YaHei", sans-serif); color: var(--vtx-text); }
            #vtx-bgm * { box-sizing: border-box; }
            body.vtx-bgm-on .vtx-theme-widget { bottom: calc(80px + var(--vtx-widget-lift, 0px)) !important; }
            .vtx-bgm-toggle { width: 52px; height: 52px; display: grid; place-items: center; padding: 0; border: 1px solid color-mix(in srgb, var(--vtx-accent) 26%, var(--vtx-border)); border-radius: 50%; background: linear-gradient(135deg, color-mix(in srgb, var(--vtx-accent) 88%, #fff), color-mix(in srgb, var(--vtx-accent-2) 68%, #2636b8)); color: #fff; font-size: 23px; cursor: pointer; box-shadow: 0 14px 34px color-mix(in srgb, var(--vtx-accent) 36%, transparent), 0 4px 12px rgba(15, 23, 42, .18); transition: transform 150ms; }
            .vtx-bgm-toggle:hover { transform: translateY(-2px); }
            .vtx-bgm-toggle.playing { animation: vtx-bgm-pulse 2.4s ease-in-out infinite; }
            @keyframes vtx-bgm-pulse { 0%, 100% { box-shadow: 0 14px 34px color-mix(in srgb, var(--vtx-accent) 36%, transparent); } 50% { box-shadow: 0 14px 40px color-mix(in srgb, var(--vtx-accent-2) 50%, transparent); } }
            .vtx-bgm-card { position: absolute; right: 0; bottom: 62px; width: min(318px, calc(100vw - 32px)); padding: 14px; border: 1px solid var(--vtx-border); border-radius: 18px; background: color-mix(in srgb, var(--vtx-surface) 94%, transparent); box-shadow: var(--vtx-shadow); backdrop-filter: blur(18px); }
            .vtx-bgm-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
            .vtx-bgm-head b { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--vtx-muted); }
            .vtx-bgm-head .grow { flex: 1; }
            .vtx-bgm-min { border: 0; background: transparent; color: var(--vtx-muted); font-size: 20px; line-height: 1; cursor: pointer; padding: 0 4px; }
            .vtx-bgm-track { display: flex; gap: 10px; align-items: center; min-width: 0; }
            .vtx-bgm-art { width: 42px; height: 42px; flex: 0 0 42px; display: grid; place-items: center; border-radius: 12px; background: linear-gradient(135deg, color-mix(in srgb, var(--vtx-accent) 30%, transparent), color-mix(in srgb, var(--vtx-accent-2) 26%, transparent)); font-size: 20px; }
            .vtx-bgm-track b { display: block; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .vtx-bgm-track small { display: block; margin-top: 2px; color: var(--vtx-muted); font-size: 11px; }
            .vtx-bgm-controls { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 12px 0 8px; }
            .vtx-bgm-controls button { width: 34px; height: 34px; border: 1px solid var(--vtx-border); border-radius: 50%; background: var(--vtx-surface); color: var(--vtx-text); font-size: 14px; cursor: pointer; }
            .vtx-bgm-controls button:hover { border-color: var(--vtx-accent); color: var(--vtx-accent); }
            .vtx-bgm-controls button.main { width: 46px; height: 46px; border: 0; background: var(--vtx-accent); color: #fff; font-size: 18px; box-shadow: 0 8px 20px color-mix(in srgb, var(--vtx-accent) 32%, transparent); }
            .vtx-bgm-controls button.active { border-color: var(--vtx-accent); color: var(--vtx-accent); }
            .vtx-bgm-volume { display: flex; align-items: center; gap: 8px; padding: 4px 2px 8px; color: var(--vtx-muted); font-size: 13px; }
            .vtx-bgm-volume input { flex: 1; accent-color: var(--vtx-accent); }
            .vtx-bgm-earn { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 11px; background: color-mix(in srgb, var(--vtx-accent) 8%, transparent); font-size: 12px; }
            .vtx-bgm-earn b { margin-left: auto; color: var(--vtx-accent); font-size: 13px; }
            .vtx-bgm-earn small { display: block; color: var(--vtx-muted); font-size: 10.5px; }
            .vtx-bgm-earn button { border: 0; background: transparent; color: var(--vtx-accent); font-size: 11px; font-weight: 700; cursor: pointer; padding: 0; }
            body.vtx-bgm-expanded .vtx-theme-widget { opacity: 0; pointer-events: none; }
            .vtx-bgm-toast { position: fixed; left: 50%; bottom: 92px; z-index: 10000; transform: translate(-50%, 6px); opacity: 0; pointer-events: none; padding: 8px 13px; border-radius: 9px; background: rgba(23, 32, 51, .94); color: #fff; font-size: 12.5px; transition: opacity 160ms, transform 160ms; }
            .vtx-bgm-toast.show { opacity: 1; transform: translate(-50%, 0); }
            @media (max-width: 620px) {
                #vtx-bgm { right: 12px; }
                .vtx-bgm-card { bottom: 58px; }
                body.vtx-bgm-on .vtx-theme-widget { bottom: calc(72px + var(--vtx-widget-lift, 0px)) !important; }
            }
            @media (prefers-reduced-motion: reduce) { .vtx-bgm-toggle { animation: none !important; } }
        `;
        document.head.appendChild(style);
    }

    function build() {
        if (el("vtx-bgm")) return;
        const root = document.createElement("div");
        root.id = "vtx-bgm";
        root.innerHTML = `
            <button type="button" class="vtx-bgm-toggle" id="vtx-bgm-toggle" aria-label="打开 BGM 播放器" aria-expanded="false">♪</button>
            <div class="vtx-bgm-card" id="vtx-bgm-card" hidden>
                <div class="vtx-bgm-head"><b>BGM</b><span class="grow"></span><button type="button" class="vtx-bgm-min" id="vtx-bgm-min" aria-label="收起播放器">—</button></div>
                <div class="vtx-bgm-track">
                    <span class="vtx-bgm-art">♪</span>
                    <span style="min-width:0;"><b id="vtx-bgm-title"></b><small id="vtx-bgm-artist"></small></span>
                </div>
                <div class="vtx-bgm-controls">
                    <button type="button" id="vtx-bgm-prev" title="上一首">⏮</button>
                    <button type="button" class="main" id="vtx-bgm-play" title="播放 / 暂停">▶</button>
                    <button type="button" id="vtx-bgm-next" title="下一首">⏭</button>
                    <button type="button" id="vtx-bgm-mode" title="循环模式">🔂</button>
                </div>
                <div class="vtx-bgm-volume"><span>🔊</span><input type="range" id="vtx-bgm-volume" min="0" max="100" value="65" aria-label="音量"></div>
                <div class="vtx-bgm-earn">
                    <span>听歌赚钱<small>每 20 秒 +0.01 VTX</small></span>
                    <b id="vtx-bgm-earned">0.00 VTX</b>
                    <button type="button" id="vtx-bgm-login" hidden>登录</button>
                </div>
            </div>`;
        document.body.appendChild(root);
        document.body.classList.add("vtx-bgm-on");

        audio = new Audio();
        audio.preload = "metadata";
        audio.volume = Math.min(1, Math.max(0, Number(read(KEY_VOLUME, "0.65")) || 0.65));
        mode = MODES.some((item) => item.id === read(KEY_MODE, "single")) ? read(KEY_MODE, "single") : "single";

        el("vtx-bgm-toggle").addEventListener("click", () => setExpanded(!expanded));
        el("vtx-bgm-min").addEventListener("click", () => setExpanded(false));
        el("vtx-bgm-play").addEventListener("click", () => {
            if (audio.paused) play(); else pause();
        });
        el("vtx-bgm-prev").addEventListener("click", () => step(-1));
        el("vtx-bgm-next").addEventListener("click", () => step(1));
        el("vtx-bgm-mode").addEventListener("click", () => {
            const index = MODES.findIndex((item) => item.id === mode);
            mode = MODES[(index + 1) % MODES.length].id;
            write(KEY_MODE, mode);
            if (audio) audio.loop = mode === "single";
            syncMode();
            toast("循环模式：" + MODES.find((item) => item.id === mode).label);
        });
        const volume = el("vtx-bgm-volume");
        volume.value = String(Math.round(audio.volume * 100));
        volume.addEventListener("input", () => {
            audio.volume = Math.max(0, Math.min(1, Number(volume.value) / 100));
            write(KEY_VOLUME, audio.volume);
        });
        el("vtx-bgm-login").addEventListener("click", () => {
            location.href = "login.html?next=" + encodeURIComponent(location.pathname.split("/").pop() + location.search);
        });

        audio.addEventListener("play", () => {
            syncPlayButton();
            startEarning();
            write(KEY_PLAYING, "1");
        });
        audio.addEventListener("pause", () => {
            syncPlayButton();
            stopEarning();
            write(KEY_PLAYING, "0");
        });
        audio.addEventListener("ended", () => {
            step(1, true);
        });
        audio.addEventListener("timeupdate", () => {
            if (!audio.paused) {
                clearTimeout(saveTimer);
                saveTimer = setTimeout(() => write(KEY_TIME, audio.currentTime.toFixed(2)), 1500);
            }
        });
        audio.addEventListener("error", () => toast("BGM 加载失败，请稍后刷新"));

        load(0, false);
        syncMode();
        syncEarned();
        setExpanded(false);

        ensureApi().then((client) => {
            if (client && client.hasSession && client.hasSession()) {
                client.me().then((account) => {
                    if (account && account.bgm) syncEarned(Number(account.bgm.earnedCents) || 0);
                }).catch(() => {});
            } else {
                el("vtx-bgm-login").hidden = false;
                el("vtx-bgm-earned").textContent = "登录后赚";
            }
        });
    }

    function syncMode() {
        const item = MODES.find((entry) => entry.id === mode) || MODES[0];
        const button = el("vtx-bgm-mode");
        button.textContent = item.icon;
        button.title = item.label;
        button.classList.toggle("active", mode !== "single");
    }

    function syncPlayButton() {
        const button = el("vtx-bgm-play");
        if (!button) return;
        button.textContent = audio && !audio.paused ? "⏸" : "▶";
        const toggle = el("vtx-bgm-toggle");
        if (toggle) toggle.classList.toggle("playing", Boolean(audio && !audio.paused));
        toggle.textContent = audio && !audio.paused ? "♫" : "♪";
    }

    function syncEarned(cents) {
        const node = el("vtx-bgm-earned");
        if (!node) return;
        if (typeof cents === "number") {
            node.textContent = (cents / 100).toFixed(2) + " VTX";
        }
    }

    function load(index, autoplay) {
        playingIndex = (index + TRACKS.length) % TRACKS.length;
        const track = TRACKS[playingIndex];
        audio.src = track.src;
        el("vtx-bgm-title").textContent = track.title;
        el("vtx-bgm-artist").textContent = track.artist + " · " + (playingIndex + 1) + " / " + TRACKS.length;
        audio.loop = mode === "single";
        if (autoplay) play();
    }

    function step(direction, ended) {
        if (TRACKS.length < 2) {
            write(KEY_TIME, "0");
            audio.currentTime = 0;
            if (!ended) play();
            else if (mode !== "single") play();
            return;
        }
        let next = playingIndex + direction;
        if (mode === "shuffle") {
            do { next = Math.floor(Math.random() * TRACKS.length); } while (next === playingIndex && TRACKS.length > 1);
        }
        write(KEY_TIME, "0");
        load((next + TRACKS.length) % TRACKS.length, true);
    }

    function play() {
        if (!audio) return;
        const resumeAt = Number(read(KEY_TIME, "0"));
        if (!audio.src) load(playingIndex, false);
        if (audio.currentTime === 0 && resumeAt > 0 && resumeAt < (audio.duration || Infinity) - 2) {
            try { audio.currentTime = resumeAt; } catch (error) { /* ignore */ }
        }
        const attempt = audio.play();
        if (attempt && attempt.catch) {
            attempt.catch(() => {
                syncPlayButton();
                armResume();
            });
        } else {
            syncPlayButton();
        }
    }

    function pause() {
        if (!audio) return;
        audio.pause();
        write(KEY_TIME, audio.currentTime.toFixed(2));
    }

    function armResume() {
        const resume = () => {
            audio.play().catch(() => {});
        };
        document.addEventListener("pointerdown", resume, { once: true });
    }

    function setExpanded(value) {
        expanded = Boolean(value);
        const card = el("vtx-bgm-card");
        const toggle = el("vtx-bgm-toggle");
        if (!card || !toggle) return;
        card.hidden = !expanded;
        document.body.classList.toggle("vtx-bgm-expanded", expanded);
        toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    }

    function startEarning() {
        ensureApi().then((client) => {
            if (!client || !client.hasSession || !client.hasSession()) return;
            if (!sessionStarted) {
                sessionStarted = true;
                client.bgm.start().then((data) => {
                    if (data && data.earnedCents !== undefined) syncEarned(Number(data.earnedCents) || 0);
                }).catch(() => { sessionStarted = false; });
            }
            clearInterval(rewardTimer);
            rewardTimer = setInterval(async () => {
                if (!audio || audio.paused || document.hidden) return;
                try {
                    const data = await client.bgm.reward();
                    if (data && data.earned > 0) {
                        syncEarned(Number(data.totalEarned) || 0);
                        toast("听歌奖励 +0.01 VTX");
                    }
                } catch (error) {
                    if (error && error.status === 400) sessionStarted = false;
                }
            }, 20000);
        });
    }

    function stopEarning() {
        clearInterval(rewardTimer);
        rewardTimer = 0;
        sessionStarted = false;
    }

    function resumeSavedPlayback() {
        const saved = Number(read(KEY_TIME, "0")) || 0;
        load(playingIndex, false);
        const begin = () => {
            if (saved > 0 && audio.duration && saved < audio.duration - 2) {
                try { audio.currentTime = saved; } catch (error) { /* ignore */ }
            }
            play();
        };
        if (audio.readyState >= 1) begin();
        else audio.addEventListener("loadedmetadata", begin, { once: true });
    }

    function injectOpeningStyle() {
        if (el("vtx-opening-style")) return;
        const style = document.createElement("style");
        style.id = "vtx-opening-style";
        style.textContent = `
            body.vtx-opening-open { overflow: hidden; }
            #vtx-opening { position: fixed; inset: 0; z-index: 30000; display: grid; place-items: center; overflow: hidden; color: #fff; background: radial-gradient(circle at 50% 38%, #1d3fa8 0%, #101c3c 42%, #070c18 100%); opacity: 1; transition: opacity 420ms ease; }
            #vtx-opening.closing { opacity: 0; pointer-events: none; }
            .vtx-opening-bg { position: absolute; inset: -20%; background: radial-gradient(circle at 20% 20%, rgba(80,130,255,.24), transparent 36%), radial-gradient(circle at 80% 76%, rgba(25,184,166,.18), transparent 34%); animation: vtx-opening-bg 8s ease-in-out infinite alternate; }
            .vtx-opening-ring { position: absolute; border: 1px solid rgba(150,185,255,.18); border-radius: 50%; }
            .vtx-opening-ring.r1 { width: 420px; height: 420px; animation: vtx-opening-spin 16s linear infinite; }
            .vtx-opening-ring.r2 { width: 620px; height: 620px; border-style: dashed; opacity: .6; animation: vtx-opening-spin 26s linear reverse infinite; }
            .vtx-opening-card { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; padding: 20px; }
            .vtx-opening-mark { width: 96px; height: 96px; display: grid; place-items: center; border-radius: 26px; background: #3867e8; color: #fff; font-size: 50px; font-weight: 900; box-shadow: 0 20px 60px rgba(56,103,232,.5), inset 0 1px 0 rgba(255,255,255,.35); animation: vtx-opening-pop 900ms cubic-bezier(.16,1,.3,1) both; }
            .vtx-opening-word { font-size: clamp(26px, 4.4vw, 44px); font-weight: 850; letter-spacing: -.045em; animation: vtx-opening-up 700ms 260ms both; }
            .vtx-opening-sub { color: rgba(205,220,255,.62); font-size: 12px; letter-spacing: .22em; text-transform: uppercase; animation: vtx-opening-up 700ms 420ms both; }
            .vtx-opening-bar { width: min(260px, 62vw); height: 3px; margin-top: 10px; border-radius: 999px; background: rgba(255,255,255,.16); overflow: hidden; }
            .vtx-opening-bar i { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #6d8dff, #19d3c5); animation: vtx-opening-progress 10s linear forwards; }
            .vtx-opening-skip { position: absolute; right: max(20px, env(safe-area-inset-right, 0px)); bottom: max(22px, env(safe-area-inset-bottom, 0px)); z-index: 2; padding: 8px 15px; border: 1px solid rgba(190,210,255,.32); border-radius: 999px; background: rgba(16,28,60,.5); color: rgba(225,235,255,.82); font: inherit; font-size: 12px; cursor: pointer; backdrop-filter: blur(8px); }
            .vtx-opening-skip:hover { background: rgba(35,58,110,.7); color: #fff; }
            @keyframes vtx-opening-pop { from { opacity: 0; transform: scale(.72) rotate(-7deg); } to { opacity: 1; transform: none; } }
            @keyframes vtx-opening-up { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
            @keyframes vtx-opening-progress { from { width: 0; } to { width: 100%; } }
            @keyframes vtx-opening-spin { to { transform: rotate(360deg); } }
            @keyframes vtx-opening-bg { from { transform: scale(1) translate3d(-1%, -1%, 0); } to { transform: scale(1.08) translate3d(2%, 1%, 0); } }
            @media (prefers-reduced-motion: reduce) { .vtx-opening-bg, .vtx-opening-ring, .vtx-opening-mark, .vtx-opening-word, .vtx-opening-sub { animation: none !important; } }
        `;
        document.head.appendChild(style);
    }

    function cameFromSite() {
        try {
            const referrer = document.referrer || "";
            if (!referrer) return false;
            return new URL(referrer).hostname === "xsmmc.caldson.us.ci";
        } catch (error) {
            return false;
        }
    }

    function openingOverlay(short, audioEl) {
        injectOpeningStyle();
        const old = el("vtx-opening");
        if (old) old.remove();
        const overlay = document.createElement("div");
        overlay.id = "vtx-opening";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-label", "Vitual XRing 开场");
        overlay.innerHTML = `
            <div class="vtx-opening-bg"></div>
            <div class="vtx-opening-ring r1"></div>
            <div class="vtx-opening-ring r2"></div>
            <div class="vtx-opening-card">
                <div class="vtx-opening-mark">V</div>
                <div class="vtx-opening-word">Vitual XRing</div>
                <div class="vtx-opening-sub">XRing Studios</div>
                <div class="vtx-opening-bar"><i></i></div>
            </div>
            <button type="button" class="vtx-opening-skip" id="vtx-opening-skip">跳过开场</button>`;
        document.body.appendChild(overlay);
        document.body.classList.add("vtx-opening-open");
        const bar = overlay.querySelector(".vtx-opening-bar i");
        if (bar && !short) bar.style.animationDuration = "20s";
        let closed = false;
        const finish = (resume) => {
            if (closed) return;
            closed = true;
            try { if (audioEl) audioEl.pause(); } catch (error) { /* ignore */ }
            overlay.classList.add("closing");
            setTimeout(() => {
                overlay.remove();
                document.body.classList.remove("vtx-opening-open");
            }, 450);
            document.removeEventListener("keydown", onKey);
            if (resume && read(KEY_PLAYING, "0") === "1") resumeSavedPlayback();
        };
        const onKey = (event) => { if (event.key === "Escape") finish(true); };
        document.addEventListener("keydown", onKey);
        overlay.querySelector("#vtx-opening-skip").addEventListener("click", () => finish(true));
        if (short) setTimeout(() => finish(true), 10000);
        else if (audioEl) {
            audioEl.addEventListener("ended", () => finish(true), { once: true });
            setTimeout(() => finish(true), 75000);
        }
        return finish;
    }

    function maybePlayOpening() {
        if (!/manager\.html$/i.test(location.pathname)) return false;
        if (read("vtx:opening:enabled", "1") === "0") return false;
        if (!cameFromSite()) return false;
        const last = Number(read("vtx:opening:last", "0")) || 0;
        if (last && Date.now() - last < 2 * 60 * 60 * 1000) return false;
        write("vtx:opening:last", Date.now());
        const short = read("vtx:opening:short", "1") !== "0";
        const wasPlaying = read(KEY_PLAYING, "0") === "1";
        const opening = new Audio(OPENING_SRC);
        openingAudio = opening;
        opening.volume = Math.min(0.8, Math.max(0.2, audio ? audio.volume : 0.65));
        const finish = openingOverlay(short, opening);
        const attempt = opening.play();
        window.__vtxBgmOpeningAttempt = "called";
        if (attempt && attempt.catch) {
            attempt.then(() => { window.__vtxBgmOpeningAttempt = "playing"; }).catch((error) => {
                window.__vtxBgmOpeningAttempt = "blocked:" + (error && error.name);
                document.addEventListener("pointerdown", () => {
                    opening.play().then(() => { window.__vtxBgmOpeningAttempt = "playing-after-gesture"; }).catch(() => {});
                }, { once: true });
            });
        }
        window.__vtxOpeningFinish = finish;
        return { wasPlaying };
    }

    function boot() {
        if (!document.body) return;
        injectStyle();
        build();
        const opening = maybePlayOpening();
        window.__vtxBgm = { get audio() { return audio; }, get opening() { return openingAudio; } };

        /* 之前正在播放的话，换页后尝试续播；浏览器拦自动播放时等用户第一次点击。 */
        const wantedPlaying = read(KEY_PLAYING, "0") === "1";
        const onManager = /manager\.html$/i.test(location.pathname);
        if (wantedPlaying && (!onManager || !opening)) {
            resumeSavedPlayback();
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
        boot();
    }
})();
