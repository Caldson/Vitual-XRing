/* Vitual XRing 8.0.0 — theme + language shell */
(function () {
    "use strict";
    const VERSION = "8.0.0";
    const THEME_KEY = "xring:theme";
    const LANGUAGE_KEY = "xring:language";
    const THEME_MODES = ["auto", "light", "dark"];
    const LANGUAGE_MODES = ["auto", "region", "zh-CN", "zh-TW", "en", "ja"];

    const I18N = {
        "zh-CN": {
            "document.index": "Vitual XRing · 虚拟云电脑与作品社区",
            "document.settings": "设置 · Vitual XRing",
            "brand": "Vitual XRing",
            "nav.home": "首页", "nav.xos": "XOS 云电脑", "nav.shop": "商店", "nav.chat": "聊天室",
            "nav.viratch": "Viratch", "nav.vitualgit": "VitualGit", "nav.vuolingo": "Vuolingo", "nav.settings": "设置",
            "action.login": "登录", "action.account": "账户", "action.openAccount": "进入账户",
            "action.openXos": "打开 XOS 云电脑", "action.viewXos": "查看 XOS 版本",
            "hero.kicker": "XRing Studios · 虚拟桌面与创作平台",
            "hero.title1": "把所有创作，", "hero.title2": "装进一个浏览器。",
            "hero.copy": "XOS 虚拟云电脑、VitualGit 仓库、Vuolingo 语言课和创作社区，共用一套账户与界面。现在也支持深色模式和六种界面语言。",
            "hero.stat1": "XOS 应用", "hero.stat2": "语言课程", "hero.stat3": "离线可用",
            "xos.badge": "旗舰平台", "xos.price": "1000 VTX 起", "xos.title": "XOS PC 26H3 V2.1",
            "xos.meta": "1440×900 · 15–60fps · 最多 22 个应用", "xos.enter": "进入虚拟桌面",
            "section.platforms": "探索平台", "section.platformsDesc": "一个账户，连接云电脑、仓库、课程和创作工具。",
            "card.xos.title": "XOS 云电脑", "card.xos.desc": "虚拟桌面 · 文件 · 浏览器 · 创作工具",
            "card.shop.title": "商店", "card.shop.desc": "XOS 授权、同捆包与商家商品",
            "card.viratch.title": "Viratch", "card.viratch.desc": "TurboWarp 积木作品社区",
            "card.vitxvideo.title": "Vitx® 视频", "card.vitxvideo.desc": "投稿、观看、评论与分享",
            "card.vitxdynamic.title": "Vitx 动态", "card.vitxdynamic.desc": "图文动态与分享卡片",
            "card.chat.title": "聊天室", "card.chat.desc": "单聊、群聊、红包与实时消息",
            "card.audiv.title": "AUDIV", "card.audiv.desc": "浏览器语音会议",
            "card.share.title": "分享", "card.share.desc": "自定义分享卡片与站内识别",
            "card.vitualgit.title": "VitualGit", "card.vitualgit.desc": "GitHub 风格仓库浏览 · Proxy 镜像",
            "card.vuolingo.title": "Vuolingo", "card.vuolingo.desc": "英语 / 日语课程与 7 种题型",
            "footer": "Vitual XRing 8.0.0 · XOS 是浏览器端虚拟桌面，不是真实远程虚拟机。",
            "widget.theme": "切换主题", "widget.settings": "打开设置",
            "widget.themeAuto": "主题：自动（{theme}）", "widget.themeLight": "主题：浅色", "widget.themeDark": "主题：深色",
            "settings.kicker": "界面偏好", "settings.title": "设置", "settings.subtitle": "主题、语言和显示偏好会保存在本机，并立即生效。",
            "settings.back": "返回首页", "settings.appearance": "外观", "settings.appearanceDesc": "自动模式跟随设备的浅色 / 深色设置。",
            "settings.themeAuto": "自动", "settings.themeAutoHint": "跟随设备", "settings.themeLight": "浅色", "settings.themeLightHint": "始终明亮", "settings.themeDark": "深色", "settings.themeDarkHint": "始终暗色",
            "settings.language": "语言", "settings.languageDesc": "选择界面语言；跟随地区会依据设备时区判断。",
            "settings.langAuto": "跟随设备（默认）", "settings.langAutoHint": "使用浏览器语言", "settings.langRegion": "跟随地区", "settings.langRegionHint": "依据设备时区", "settings.langZhCN": "简体中文", "settings.langZhCNHint": "中国大陆", "settings.langZhTW": "繁體中文", "settings.langZhTWHint": "台灣 / 香港 / 澳門", "settings.langEn": "English", "settings.langEnHint": "English interface", "settings.langJa": "日本語", "settings.langJaHint": "日本語インターフェース",
            "settings.current": "当前生效", "settings.currentTheme": "主题", "settings.currentLanguage": "语言", "settings.currentMode": "设置模式",
            "settings.reset": "恢复默认", "settings.resetHint": "恢复为跟随设备和自动主题。", "settings.saved": "设置已保存。",
            "settings.preview": "预览", "settings.previewText": "这是一段界面预览。切换主题或语言后，所有支持的区域会立即更新。",
            "settings.languageNote": "语言设置会影响全站导航、首页和设置页；各平台内部内容仍以原语言为准。",
            "settings.modeAuto": "自动", "settings.modeRegion": "地区", "settings.modeDevice": "设备",
            "theme.light": "浅色", "theme.dark": "深色", "theme.auto": "自动"
        },
        "zh-TW": {
            "document.index": "Vitual XRing · 虛擬雲電腦與作品社群",
            "document.settings": "設定 · Vitual XRing",
            "brand": "Vitual XRing",
            "nav.home": "首頁", "nav.xos": "XOS 雲端電腦", "nav.shop": "商店", "nav.chat": "聊天室",
            "nav.viratch": "Viratch", "nav.vitualgit": "VitualGit", "nav.vuolingo": "Vuolingo", "nav.settings": "設定",
            "action.login": "登入", "action.account": "帳戶", "action.openAccount": "進入帳戶",
            "action.openXos": "開啟 XOS 雲端電腦", "action.viewXos": "查看 XOS 版本",
            "hero.kicker": "XRing Studios · 虛擬桌面與創作平台",
            "hero.title1": "把所有創作，", "hero.title2": "裝進一個瀏覽器。",
            "hero.copy": "XOS 虛擬雲電腦、VitualGit 倉庫、Vuolingo 語言課和創作社群，共用一套帳戶與介面。現在也支援深色模式和六種介面語言。",
            "hero.stat1": "XOS 應用", "hero.stat2": "語言課程", "hero.stat3": "離線可用",
            "xos.badge": "旗艦平台", "xos.price": "1000 VTX 起", "xos.title": "XOS PC 26H3 V2.1",
            "xos.meta": "1440×900 · 15–60fps · 最多 22 個應用", "xos.enter": "進入虛擬桌面",
            "section.platforms": "探索平台", "section.platformsDesc": "一個帳戶，連接雲電腦、倉庫、課程和創作工具。",
            "card.xos.title": "XOS 雲端電腦", "card.xos.desc": "虛擬桌面 · 檔案 · 瀏覽器 · 創作工具",
            "card.shop.title": "商店", "card.shop.desc": "XOS 授權、同捆包與商家商品",
            "card.viratch.title": "Viratch", "card.viratch.desc": "TurboWarp 積木作品社群",
            "card.vitxvideo.title": "Vitx® 影片", "card.vitxvideo.desc": "投稿、觀看、留言與分享",
            "card.vitxdynamic.title": "Vitx 動態", "card.vitxdynamic.desc": "圖文動態與分享卡片",
            "card.chat.title": "聊天室", "card.chat.desc": "單聊、群聊、紅包與即時訊息",
            "card.audiv.title": "AUDIV", "card.audiv.desc": "瀏覽器語音會議",
            "card.share.title": "分享", "card.share.desc": "自訂分享卡片與站內辨識",
            "card.vitualgit.title": "VitualGit", "card.vitualgit.desc": "GitHub 風格倉庫瀏覽 · Proxy 鏡像",
            "card.vuolingo.title": "Vuolingo", "card.vuolingo.desc": "英語 / 日語課程與 7 種題型",
            "footer": "Vitual XRing 8.0.0 · XOS 是瀏覽器端虛擬桌面，不是真實遠端虛擬機。",
            "widget.theme": "切換主題", "widget.settings": "開啟設定",
            "widget.themeAuto": "主題：自動（{theme}）", "widget.themeLight": "主題：淺色", "widget.themeDark": "主題：深色",
            "settings.kicker": "介面偏好", "settings.title": "設定", "settings.subtitle": "主題、語言和顯示偏好會保存在本機，並立即生效。",
            "settings.back": "返回首頁", "settings.appearance": "外觀", "settings.appearanceDesc": "自動模式跟隨裝置的淺色 / 深色設定。",
            "settings.themeAuto": "自動", "settings.themeAutoHint": "跟隨裝置", "settings.themeLight": "淺色", "settings.themeLightHint": "始終明亮", "settings.themeDark": "深色", "settings.themeDarkHint": "始終暗色",
            "settings.language": "語言", "settings.languageDesc": "選擇介面語言；跟隨地區會依據裝置時區判斷。",
            "settings.langAuto": "跟隨裝置（預設）", "settings.langAutoHint": "使用瀏覽器語言", "settings.langRegion": "跟隨地區", "settings.langRegionHint": "依據裝置時區", "settings.langZhCN": "简体中文", "settings.langZhCNHint": "中國大陸", "settings.langZhTW": "繁體中文", "settings.langZhTWHint": "台灣 / 香港 / 澳門", "settings.langEn": "English", "settings.langEnHint": "English interface", "settings.langJa": "日本語", "settings.langJaHint": "日本語インターフェース",
            "settings.current": "目前生效", "settings.currentTheme": "主題", "settings.currentLanguage": "語言", "settings.currentMode": "設定模式",
            "settings.reset": "恢復預設", "settings.resetHint": "恢復為跟隨裝置和自動主題。", "settings.saved": "設定已儲存。",
            "settings.preview": "預覽", "settings.previewText": "這是一段介面預覽。切換主題或語言後，所有支援的區域會立即更新。",
            "settings.languageNote": "語言設定會影響全站導覽、首頁和設定頁；各平台內部內容仍以原語言為準。",
            "settings.modeAuto": "自動", "settings.modeRegion": "地區", "settings.modeDevice": "裝置",
            "theme.light": "淺色", "theme.dark": "深色", "theme.auto": "自動"
        },
        "en": {
            "document.index": "Vitual XRing · Virtual desktop & creative community",
            "document.settings": "Settings · Vitual XRing",
            "brand": "Vitual XRing",
            "nav.home": "Home", "nav.xos": "XOS", "nav.shop": "Shop", "nav.chat": "Chat",
            "nav.viratch": "Viratch", "nav.vitualgit": "VitualGit", "nav.vuolingo": "Vuolingo", "nav.settings": "Settings",
            "action.login": "Sign in", "action.account": "Account", "action.openAccount": "Open account",
            "action.openXos": "Open XOS desktop", "action.viewXos": "View XOS versions",
            "hero.kicker": "XRing Studios · desktop & creative platform",
            "hero.title1": "All your creations,", "hero.title2": "inside one browser.",
            "hero.copy": "XOS, VitualGit, Vuolingo and the creative community share one account and one interface. Dark mode and six interface languages are now available.",
            "hero.stat1": "XOS apps", "hero.stat2": "Language lessons", "hero.stat3": "Offline ready",
            "xos.badge": "Flagship", "xos.price": "From 1000 VTX", "xos.title": "XOS PC 26H3 V2.1",
            "xos.meta": "1440×900 · 15–60fps · up to 22 apps", "xos.enter": "Enter virtual desktop",
            "section.platforms": "Explore the platform", "section.platformsDesc": "One account for cloud desktops, repositories, courses and creative tools.",
            "card.xos.title": "XOS desktop", "card.xos.desc": "Virtual desktop · files · browser · creative apps",
            "card.shop.title": "Shop", "card.shop.desc": "XOS licenses, bundles and merchant products",
            "card.viratch.title": "Viratch", "card.viratch.desc": "TurboWarp block project community",
            "card.vitxvideo.title": "Vitx® Video", "card.vitxvideo.desc": "Publish, watch, comment and share",
            "card.vitxdynamic.title": "Vitx Feed", "card.vitxdynamic.desc": "Posts and share cards",
            "card.chat.title": "Chat", "card.chat.desc": "Direct chat, groups, red packets and live messages",
            "card.audiv.title": "AUDIV", "card.audiv.desc": "Browser voice meetings",
            "card.share.title": "Share", "card.share.desc": "Custom share cards and in-site previews",
            "card.vitualgit.title": "VitualGit", "card.vitualgit.desc": "GitHub-style repository browser · proxy mirror",
            "card.vuolingo.title": "Vuolingo", "card.vuolingo.desc": "English / Japanese lessons and 7 exercise types",
            "footer": "Vitual XRing 8.0.0 · XOS is a browser virtual desktop, not a real remote VM.",
            "widget.theme": "Change theme", "widget.settings": "Open settings",
            "widget.themeAuto": "Theme: auto ({theme})", "widget.themeLight": "Theme: light", "widget.themeDark": "Theme: dark",
            "settings.kicker": "Interface preferences", "settings.title": "Settings", "settings.subtitle": "Theme, language and display preferences are saved on this device and applied immediately.",
            "settings.back": "Back home", "settings.appearance": "Appearance", "settings.appearanceDesc": "Auto follows your device's light or dark setting.",
            "settings.themeAuto": "Auto", "settings.themeAutoHint": "Follow device", "settings.themeLight": "Light", "settings.themeLightHint": "Always bright", "settings.themeDark": "Dark", "settings.themeDarkHint": "Always dark",
            "settings.language": "Language", "settings.languageDesc": "Choose the interface language. Follow region uses your device time zone.",
            "settings.langAuto": "Follow device (default)", "settings.langAutoHint": "Use browser language", "settings.langRegion": "Follow region", "settings.langRegionHint": "Use device time zone", "settings.langZhCN": "简体中文", "settings.langZhCNHint": "Mainland China", "settings.langZhTW": "繁體中文", "settings.langZhTWHint": "Taiwan / Hong Kong / Macau", "settings.langEn": "English", "settings.langEnHint": "English interface", "settings.langJa": "日本語", "settings.langJaHint": "Japanese interface",
            "settings.current": "Currently active", "settings.currentTheme": "Theme", "settings.currentLanguage": "Language", "settings.currentMode": "Mode",
            "settings.reset": "Reset to defaults", "settings.resetHint": "Restore follow-device language and auto theme.", "settings.saved": "Settings saved.",
            "settings.preview": "Preview", "settings.previewText": "This is an interface preview. Switching theme or language updates every supported area immediately.",
            "settings.languageNote": "Language affects global navigation, the home page and this settings page; platform content keeps its original language.",
            "settings.modeAuto": "Auto", "settings.modeRegion": "Region", "settings.modeDevice": "Device",
            "theme.light": "Light", "theme.dark": "Dark", "theme.auto": "Auto"
        },
        "ja": {
            "document.index": "Vitual XRing · 仮想デスクトップと創作コミュニティ",
            "document.settings": "設定 · Vitual XRing",
            "brand": "Vitual XRing",
            "nav.home": "ホーム", "nav.xos": "XOS", "nav.shop": "ショップ", "nav.chat": "チャット",
            "nav.viratch": "Viratch", "nav.vitualgit": "VitualGit", "nav.vuolingo": "Vuolingo", "nav.settings": "設定",
            "action.login": "ログイン", "action.account": "アカウント", "action.openAccount": "アカウントを開く",
            "action.openXos": "XOS デスクトップを開く", "action.viewXos": "XOS のバージョンを見る",
            "hero.kicker": "XRing Studios · 仮想デスクトップと創作プラットフォーム",
            "hero.title1": "すべての創作を、", "hero.title2": "ひとつのブラウザに。",
            "hero.copy": "XOS、VitualGit、Vuolingo、創作コミュニティがひとつのアカウントとUIを共有します。ダークモードと6つの表示言語に対応しました。",
            "hero.stat1": "XOS アプリ", "hero.stat2": "言語レッスン", "hero.stat3": "オフライン対応",
            "xos.badge": "フラッグシップ", "xos.price": "1000 VTX から", "xos.title": "XOS PC 26H3 V2.1",
            "xos.meta": "1440×900 · 15–60fps · 最大 22 アプリ", "xos.enter": "仮想デスクトップへ",
            "section.platforms": "プラットフォーム", "section.platformsDesc": "ひとつのアカウントで、デスクトップ、リポジトリ、レッスン、創作ツールへ。",
            "card.xos.title": "XOS デスクトップ", "card.xos.desc": "仮想デスクトップ · ファイル · ブラウザ · 創作アプリ",
            "card.shop.title": "ショップ", "card.shop.desc": "XOS ライセンス、バンドル、加盟店商品",
            "card.viratch.title": "Viratch", "card.viratch.desc": "TurboWarp ブロック作品コミュニティ",
            "card.vitxvideo.title": "Vitx® 動画", "card.vitxvideo.desc": "投稿、視聴、コメント、共有",
            "card.vitxdynamic.title": "Vitx フィード", "card.vitxdynamic.desc": "投稿と共有カード",
            "card.chat.title": "チャット", "card.chat.desc": "個人・グループ・红包・リアルタイム",
            "card.audiv.title": "AUDIV", "card.audiv.desc": "ブラウザ音声会議",
            "card.share.title": "共有", "card.share.desc": "カスタム共有カードとサイト内プレビュー",
            "card.vitualgit.title": "VitualGit", "card.vitualgit.desc": "GitHub 風リポジトリ閲覧 · Proxy ミラー",
            "card.vuolingo.title": "Vuolingo", "card.vuolingo.desc": "英語 / 日本語レッスンと7種類の練習",
            "footer": "Vitual XRing 8.0.0 · XOS はブラウザ内の仮想デスクトップであり、実際のリモート VM ではありません。",
            "widget.theme": "テーマを切り替え", "widget.settings": "設定を開く",
            "widget.themeAuto": "テーマ：自動（{theme}）", "widget.themeLight": "テーマ：ライト", "widget.themeDark": "テーマ：ダーク",
            "settings.kicker": "表示設定", "settings.title": "設定", "settings.subtitle": "テーマ、言語、表示設定はこの端末に保存され、すぐに反映されます。",
            "settings.back": "ホームへ戻る", "settings.appearance": "外観", "settings.appearanceDesc": "自動は端末のライト / ダーク設定に従います。",
            "settings.themeAuto": "自動", "settings.themeAutoHint": "端末に従う", "settings.themeLight": "ライト", "settings.themeLightHint": "常に明るく", "settings.themeDark": "ダーク", "settings.themeDarkHint": "常に暗く",
            "settings.language": "言語", "settings.languageDesc": "表示言語を選択します。地域に従う場合は端末のタイムゾーンを使います。",
            "settings.langAuto": "端末に従う（既定）", "settings.langAutoHint": "ブラウザ言語を使用", "settings.langRegion": "地域に従う", "settings.langRegionHint": "端末のタイムゾーンを使用", "settings.langZhCN": "简体中文", "settings.langZhCNHint": "中国大陸", "settings.langZhTW": "繁體中文", "settings.langZhTWHint": "台湾 / 香港 / マカオ", "settings.langEn": "English", "settings.langEnHint": "English interface", "settings.langJa": "日本語", "settings.langJaHint": "日本語インターフェース",
            "settings.current": "現在の設定", "settings.currentTheme": "テーマ", "settings.currentLanguage": "言語", "settings.currentMode": "モード",
            "settings.reset": "初期設定に戻す", "settings.resetHint": "端末に従う言語と自動テーマに戻します。", "settings.saved": "設定を保存しました。",
            "settings.preview": "プレビュー", "settings.previewText": "これはUIのプレビューです。テーマや言語を切り替えると、対応箇所がすぐに更新されます。",
            "settings.languageNote": "言語設定は全サイトのナビゲーション、ホーム、設定ページに反映されます。各プラットフォーム内の内容は元の言語のままです。",
            "settings.modeAuto": "自動", "settings.modeRegion": "地域", "settings.modeDevice": "端末",
            "theme.light": "ライト", "theme.dark": "ダーク", "theme.auto": "自動"
        }
    };

    const COMMON = {
        "首页": "nav.home", "主页": "nav.home", "商店": "nav.shop", "聊天室": "nav.chat",
        "设置": "nav.settings", "登录": "action.login", "账户": "action.account",
        "返回主页": "settings.back", "返回首页": "settings.back"
    };

    function read(key, fallback) {
        try {
            const value = localStorage.getItem(key);
            return value === null ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function write(key, value) {
        try { localStorage.setItem(key, value); } catch (error) { /* ignore */ }
    }

    let themeMode = read(THEME_KEY, "auto");
    if (!THEME_MODES.includes(themeMode)) themeMode = "auto";
    let languageMode = read(LANGUAGE_KEY, "auto");
    if (!LANGUAGE_MODES.includes(languageMode)) languageMode = "auto";

    function deviceLanguage() {
        const candidates = Array.isArray(navigator.languages) && navigator.languages.length
            ? navigator.languages
            : [navigator.language || "zh-CN"];
        for (const candidate of candidates) {
            const mapped = mapLocale(candidate);
            if (mapped) return mapped;
        }
        return "zh-CN";
    }

    function mapLocale(value) {
        const code = String(value || "").toLowerCase();
        if (code.startsWith("zh")) {
            return /hant|tw|hk|mo/.test(code) ? "zh-TW" : "zh-CN";
        }
        if (code.startsWith("ja")) return "ja";
        if (code.startsWith("en")) return "en";
        return "";
    }

    function regionLanguage() {
        let zone = "";
        try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (error) { zone = ""; }
        if (/Shanghai|Chongqing|Urumqi|Harbin|Beijing/i.test(zone)) return "zh-CN";
        if (/Taipei|Hong_Kong|Macau/i.test(zone)) return "zh-TW";
        if (/Tokyo/i.test(zone)) return "ja";
        return deviceLanguage();
    }

    function effectiveLanguage() {
        if (languageMode === "auto") return deviceLanguage();
        if (languageMode === "region") return regionLanguage();
        return languageMode;
    }

    function effectiveTheme() {
        if (themeMode !== "auto") return themeMode;
        try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch (error) { return "light"; }
    }

    function t(key, language, variables) {
        const pack = I18N[language] || I18N["zh-CN"];
        let text = pack[key] || I18N["zh-CN"][key] || key;
        if (variables) {
            for (const [name, value] of Object.entries(variables)) text = text.replace(new RegExp("\\{" + name + "\\}", "g"), value);
        }
        return text;
    }

    function applyTheme() {
        const resolved = effectiveTheme();
        document.documentElement.dataset.theme = resolved;
        document.documentElement.dataset.themeMode = themeMode;
        document.documentElement.style.colorScheme = resolved;
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", resolved === "dark" ? "#0b101b" : "#f3f6fb");
        window.dispatchEvent(new CustomEvent("vtx:themechange", { detail: { mode: themeMode, theme: resolved } }));
    }

    function interpolateNode(node) {
        const key = node.dataset.i18n;
        const language = effectiveLanguage();
        const variables = {};
        for (const attr of ["i18nVar", "i18nVar2"]) {
            if (node.dataset[attr]) {
                const parts = node.dataset[attr].split(":");
                if (parts.length === 2) variables[parts[0]] = t(parts[1], language);
            }
        }
        node.textContent = t(key, language, variables);
    }

    function applyLanguage() {
        const language = effectiveLanguage();
        document.documentElement.lang = language;
        document.documentElement.dataset.language = language;
        document.querySelectorAll("[data-i18n]").forEach(interpolateNode);
        document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
            node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder, language));
        });
        document.querySelectorAll("[data-i18n-title]").forEach((node) => {
            node.setAttribute("title", t(node.dataset.i18nTitle, language));
        });
        document.querySelectorAll("[data-i18n-aria]").forEach((node) => {
            node.setAttribute("aria-label", t(node.dataset.i18nAria, language));
        });
        if (document.body && document.body.dataset.i18nDocumentTitle) {
            document.title = t(document.body.dataset.i18nDocumentTitle, language);
        }
        document.querySelectorAll("a, button, summary").forEach((node) => {
            if (node.hasAttribute("data-i18n") || node.childElementCount > 0) return;
            const original = node.dataset.vtxCommonKey || node.textContent.trim();
            const key = COMMON[original];
            if (key) {
                node.dataset.vtxCommonKey = original;
                node.textContent = t(key, language);
            }
        });
        updateWidget();
        window.dispatchEvent(new CustomEvent("vtx:languagechange", { detail: { mode: languageMode, language } }));
    }

    function setTheme(mode) {
        if (!THEME_MODES.includes(mode)) return;
        themeMode = mode;
        write(THEME_KEY, mode);
        applyTheme();
        updateWidget();
    }

    function setLanguage(mode) {
        if (!LANGUAGE_MODES.includes(mode)) return;
        languageMode = mode;
        write(LANGUAGE_KEY, mode);
        applyLanguage();
    }

    let widget = null;

    function updateWidget() {
        if (!widget) return;
        const language = effectiveLanguage();
        const resolved = effectiveTheme();
        const icon = themeMode === "auto" ? "◐" : resolved === "dark" ? "☾" : "☀";
        const themeLabel = themeMode === "auto"
            ? t("widget.themeAuto", language, { theme: t(resolved === "dark" ? "theme.dark" : "theme.light", language) })
            : t(resolved === "dark" ? "widget.themeDark" : "widget.themeLight", language);
        widget.querySelector("[data-vtx-theme-toggle]").textContent = icon;
        widget.querySelector("[data-vtx-theme-toggle]").setAttribute("title", themeLabel);
        widget.querySelector("[data-vtx-theme-toggle]").setAttribute("aria-label", themeLabel);
        widget.querySelector("[data-vtx-settings]").setAttribute("title", t("widget.settings", language));
        widget.querySelector("[data-vtx-settings]").setAttribute("aria-label", t("widget.settings", language));
    }

    function createWidget() {
        if (document.body.dataset.vtxWidget === "off") return;
        if (document.getElementById("vtx-theme-widget")) return;
        widget = document.createElement("div");
        widget.id = "vtx-theme-widget";
        widget.className = "vtx-theme-widget";
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.dataset.vtxThemeToggle = "";
        toggle.addEventListener("click", () => {
            const next = themeMode === "auto" ? "light" : themeMode === "light" ? "dark" : "auto";
            setTheme(next);
        });
        const settings = document.createElement("a");
        settings.dataset.vtxSettings = "";
        settings.href = "settings.html";
        settings.textContent = "⚙";
        widget.append(toggle, settings);
        document.body.appendChild(widget);
        updateWidget();
    }

    // Apply theme as early as possible to avoid a flash of the wrong colour.
    applyTheme();
    document.documentElement.lang = effectiveLanguage();
    document.documentElement.dataset.language = effectiveLanguage();

    document.addEventListener("DOMContentLoaded", () => {
        applyTheme();
        applyLanguage();
        createWidget();
        if (document.body) document.body.classList.add("vtx-theme-ready");
    });

    try {
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        if (media.addEventListener) media.addEventListener("change", () => { if (themeMode === "auto") { applyTheme(); updateWidget(); } });
        else if (media.addListener) media.addListener(() => { if (themeMode === "auto") { applyTheme(); updateWidget(); } });
    } catch (error) { /* ignore */ }

    window.addEventListener("storage", (event) => {
        if (event.key === THEME_KEY) {
            themeMode = THEME_MODES.includes(event.newValue) ? event.newValue : "auto";
            applyTheme(); updateWidget();
        }
        if (event.key === LANGUAGE_KEY) {
            languageMode = LANGUAGE_MODES.includes(event.newValue) ? event.newValue : "auto";
            applyLanguage();
        }
    });

    window.VTXTheme = {
        version: VERSION,
        themeModes: THEME_MODES.slice(),
        languageModes: LANGUAGE_MODES.slice(),
        getTheme: () => themeMode,
        getThemeMode: () => themeMode,
        getEffectiveTheme: effectiveTheme,
        setTheme,
        getLanguage: () => languageMode,
        getLanguageMode: () => languageMode,
        getEffectiveLanguage: effectiveLanguage,
        setLanguage,
        t: (key) => t(key, effectiveLanguage())
    };
})();
