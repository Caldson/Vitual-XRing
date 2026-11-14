/* Vitual XRing 12.0.1 — theme + language shell */
(function () {
    "use strict";
    const VERSION = "12.0.1";
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
            "hero.copy": "XOS 虚拟云电脑、XOS 云手机、VitualGit 仓库、Vuolingo 语言课和创作社区，共用一套账户与界面。现在也支持深色模式和六种界面语言。",
            "hero.stat1": "XOS 应用", "hero.stat2": "语言课程", "hero.stat3": "离线可用",
            "xos.badge": "旗舰平台", "xos.price": "1000 VTX 起", "xos.title": "XOS PC 26H3 V2.1",
            "xos.meta": "1440×900 · 15–60fps · 最多 22 个应用", "xos.enter": "进入虚拟桌面",
            "section.platforms": "探索平台", "section.platformsDesc": "一个账户，连接云电脑、仓库、课程和创作工具。",
            "card.xos.title": "XOS 云电脑", "card.xos.desc": "虚拟桌面 · 文件 · 浏览器 · 创作工具",
            "card.xphone.title": "XOS 云手机", "card.xphone.desc": "手机形态 · 与 Home 26H3 V2.1 功能一致",
            "card.shop.title": "商店", "card.shop.desc": "XOS 授权、同捆包与商家商品",
            "card.viratch.title": "Viratch", "card.viratch.desc": "TurboWarp 积木作品社区",
            "card.vitxvideo.title": "Vitx® 视频", "card.vitxvideo.desc": "投稿、观看、评论与分享",
            "card.vitxdynamic.title": "Vitx 动态", "card.vitxdynamic.desc": "图文动态与分享卡片",
            "card.chat.title": "聊天室", "card.chat.desc": "单聊、群聊、红包与实时消息", "card.vord.title": "Vord", "card.vord.desc": "txt / md 文档、分享与编辑记录",
            "card.audiv.title": "AUDIV", "card.audiv.desc": "浏览器语音会议",
            "card.share.title": "分享", "card.share.desc": "自定义分享卡片与站内识别",
            "card.vitualgit.title": "VitualGit", "card.vitualgit.desc": "GitHub 风格仓库浏览 · Proxy 镜像",
            "card.vuolingo.title": "Vuolingo", "card.vuolingo.desc": "英语 / 日语课程与 7 种题型",
            "footer": "Vitual XRing 12.0.1 · XOS 是浏览器端虚拟桌面与云手机，不是真实远程虚拟机。",
            "widget.theme": "切换主题", "widget.settings": "打开设置",
            "widget.themeAuto": "主题：自动（{theme}）", "widget.themeLight": "主题：浅色", "widget.themeDark": "主题：深色",
            "settings.kicker": "界面偏好", "settings.title": "设置", "settings.subtitle": "主题、语言和显示偏好会保存在本机，并立即生效。",
            "settings.back": "返回首页", "settings.appearance": "外观", "settings.appearanceDesc": "自动模式跟随设备的浅色 / 深色设置。",
            "settings.glass": "液态玻璃", "settings.glassDesc": "调整玻璃表面的透明度和模糊强度；关闭后使用纯色表面。",
            "settings.glassEnabled": "启用液态玻璃", "settings.glassEnableHint": "让顶栏、卡片和悬浮组件呈现半透明玻璃质感",
            "settings.glassOpacity": "玻璃透明度", "settings.glassOpacityHint": "数值越低越透明",
            "settings.glassBlur": "模糊强度", "settings.glassBlurHint": "数值越高背景越模糊",
            "settings.glassPreview": "玻璃预览", "settings.glassPreviewText": "拖动滑块，实时查看液态玻璃效果。",
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
            "hero.copy": "XOS 虛擬雲電腦、XOS 雲端手機、VitualGit 倉庫、Vuolingo 語言課和創作社群，共用一套帳戶與介面。現在也支援深色模式和六種介面語言。",
            "hero.stat1": "XOS 應用", "hero.stat2": "語言課程", "hero.stat3": "離線可用",
            "xos.badge": "旗艦平台", "xos.price": "1000 VTX 起", "xos.title": "XOS PC 26H3 V2.1",
            "xos.meta": "1440×900 · 15–60fps · 最多 22 個應用", "xos.enter": "進入虛擬桌面",
            "section.platforms": "探索平台", "section.platformsDesc": "一個帳戶，連接雲電腦、倉庫、課程和創作工具。",
            "card.xos.title": "XOS 雲端電腦", "card.xos.desc": "虛擬桌面 · 檔案 · 瀏覽器 · 創作工具",
            "card.xphone.title": "XOS 雲端手機", "card.xphone.desc": "手機形態 · 與 Home 26H3 V2.1 功能一致",
            "card.shop.title": "商店", "card.shop.desc": "XOS 授權、同捆包與商家商品",
            "card.viratch.title": "Viratch", "card.viratch.desc": "TurboWarp 積木作品社群",
            "card.vitxvideo.title": "Vitx® 影片", "card.vitxvideo.desc": "投稿、觀看、留言與分享",
            "card.vitxdynamic.title": "Vitx 動態", "card.vitxdynamic.desc": "圖文動態與分享卡片",
            "card.chat.title": "聊天室", "card.chat.desc": "單聊、群聊、紅包與即時訊息", "card.vord.title": "Vord", "card.vord.desc": "txt / md 文件、分享與編輯紀錄",
            "card.audiv.title": "AUDIV", "card.audiv.desc": "瀏覽器語音會議",
            "card.share.title": "分享", "card.share.desc": "自訂分享卡片與站內辨識",
            "card.vitualgit.title": "VitualGit", "card.vitualgit.desc": "GitHub 風格倉庫瀏覽 · Proxy 鏡像",
            "card.vuolingo.title": "Vuolingo", "card.vuolingo.desc": "英語 / 日語課程與 7 種題型",
            "footer": "Vitual XRing 12.0.1 · XOS 是瀏覽器端虛擬桌面與雲端手機，不是真實遠端虛擬機。",
            "widget.theme": "切換主題", "widget.settings": "開啟設定",
            "widget.themeAuto": "主題：自動（{theme}）", "widget.themeLight": "主題：淺色", "widget.themeDark": "主題：深色",
            "settings.kicker": "介面偏好", "settings.title": "設定", "settings.subtitle": "主題、語言和顯示偏好會保存在本機，並立即生效。",
            "settings.back": "返回首頁", "settings.appearance": "外觀", "settings.appearanceDesc": "自動模式跟隨裝置的淺色 / 深色設定。",
            "settings.glass": "液態玻璃", "settings.glassDesc": "調整玻璃表面的透明度和模糊強度；關閉後使用純色表面。",
            "settings.glassEnabled": "啟用液態玻璃", "settings.glassEnableHint": "讓頂欄、卡片和懸浮元件呈現半透明玻璃質感",
            "settings.glassOpacity": "玻璃透明度", "settings.glassOpacityHint": "數值越低越透明",
            "settings.glassBlur": "模糊強度", "settings.glassBlurHint": "數值越高背景越模糊",
            "settings.glassPreview": "玻璃預覽", "settings.glassPreviewText": "拖動滑桿，即時查看液態玻璃效果。",
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
            "hero.copy": "XOS cloud PC, XOS cloud phone, VitualGit, Vuolingo and the creative community share one account and one interface. Dark mode and six interface languages are now available.",
            "hero.stat1": "XOS apps", "hero.stat2": "Language lessons", "hero.stat3": "Offline ready",
            "xos.badge": "Flagship", "xos.price": "From 1000 VTX", "xos.title": "XOS PC 26H3 V2.1",
            "xos.meta": "1440×900 · 15–60fps · up to 22 apps", "xos.enter": "Enter virtual desktop",
            "section.platforms": "Explore the platform", "section.platformsDesc": "One account for cloud desktops, repositories, courses and creative tools.",
            "card.xos.title": "XOS desktop", "card.xos.desc": "Virtual desktop · files · browser · creative apps",
            "card.xphone.title": "XOS cloud phone", "card.xphone.desc": "Phone form factor · same features as Home 26H3 V2.1",
            "card.shop.title": "Shop", "card.shop.desc": "XOS licenses, bundles and merchant products",
            "card.viratch.title": "Viratch", "card.viratch.desc": "TurboWarp block project community",
            "card.vitxvideo.title": "Vitx® Video", "card.vitxvideo.desc": "Publish, watch, comment and share",
            "card.vitxdynamic.title": "Vitx Feed", "card.vitxdynamic.desc": "Posts and share cards",
            "card.chat.title": "Chat", "card.chat.desc": "Direct chat, groups, red packets and live messages", "card.vord.title": "Vord", "card.vord.desc": "TXT / MD documents, sharing and edit history",
            "card.audiv.title": "AUDIV", "card.audiv.desc": "Browser voice meetings",
            "card.share.title": "Share", "card.share.desc": "Custom share cards and in-site previews",
            "card.vitualgit.title": "VitualGit", "card.vitualgit.desc": "GitHub-style repository browser · proxy mirror",
            "card.vuolingo.title": "Vuolingo", "card.vuolingo.desc": "English / Japanese lessons and 7 exercise types",
            "footer": "Vitual XRing 12.0.1 · XOS is a browser virtual desktop and cloud phone, not a real remote VM.",
            "widget.theme": "Change theme", "widget.settings": "Open settings",
            "widget.themeAuto": "Theme: auto ({theme})", "widget.themeLight": "Theme: light", "widget.themeDark": "Theme: dark",
            "settings.kicker": "Interface preferences", "settings.title": "Settings", "settings.subtitle": "Theme, language and display preferences are saved on this device and applied immediately.",
            "settings.back": "Back home", "settings.appearance": "Appearance", "settings.appearanceDesc": "Auto follows your device's light or dark setting.",
            "settings.glass": "Liquid glass", "settings.glassDesc": "Tune the transparency and blur of glass surfaces. Turn it off for solid surfaces.",
            "settings.glassEnabled": "Enable liquid glass", "settings.glassEnableHint": "Give the header, cards and floating controls a translucent glass finish",
            "settings.glassOpacity": "Glass opacity", "settings.glassOpacityHint": "Lower values are more transparent",
            "settings.glassBlur": "Blur strength", "settings.glassBlurHint": "Higher values blur the background more",
            "settings.glassPreview": "Glass preview", "settings.glassPreviewText": "Drag the sliders to preview the liquid-glass effect live.",
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
            "hero.copy": "XOS クラウドPC、XOS クラウドスマホ、VitualGit、Vuolingo、創作コミュニティがひとつのアカウントとUIを共有します。ダークモードと6つの表示言語に対応しました。",
            "hero.stat1": "XOS アプリ", "hero.stat2": "言語レッスン", "hero.stat3": "オフライン対応",
            "xos.badge": "フラッグシップ", "xos.price": "1000 VTX から", "xos.title": "XOS PC 26H3 V2.1",
            "xos.meta": "1440×900 · 15–60fps · 最大 22 アプリ", "xos.enter": "仮想デスクトップへ",
            "section.platforms": "プラットフォーム", "section.platformsDesc": "ひとつのアカウントで、デスクトップ、リポジトリ、レッスン、創作ツールへ。",
            "card.xos.title": "XOS デスクトップ", "card.xos.desc": "仮想デスクトップ · ファイル · ブラウザ · 創作アプリ",
            "card.xphone.title": "XOS クラウドスマホ", "card.xphone.desc": "スマホ形態 · Home 26H3 V2.1 と同等の機能",
            "card.shop.title": "ショップ", "card.shop.desc": "XOS ライセンス、バンドル、加盟店商品",
            "card.viratch.title": "Viratch", "card.viratch.desc": "TurboWarp ブロック作品コミュニティ",
            "card.vitxvideo.title": "Vitx® 動画", "card.vitxvideo.desc": "投稿、視聴、コメント、共有",
            "card.vitxdynamic.title": "Vitx フィード", "card.vitxdynamic.desc": "投稿と共有カード",
            "card.chat.title": "チャット", "card.chat.desc": "個人・グループ・红包・リアルタイム", "card.vord.title": "Vord", "card.vord.desc": "txt / md 文書・共有・編集履歴",
            "card.audiv.title": "AUDIV", "card.audiv.desc": "ブラウザ音声会議",
            "card.share.title": "共有", "card.share.desc": "カスタム共有カードとサイト内プレビュー",
            "card.vitualgit.title": "VitualGit", "card.vitualgit.desc": "GitHub 風リポジトリ閲覧 · Proxy ミラー",
            "card.vuolingo.title": "Vuolingo", "card.vuolingo.desc": "英語 / 日本語レッスンと7種類の練習",
            "footer": "Vitual XRing 12.0.1 · XOS はブラウザ内の仮想デスクトップとクラウドスマホであり、実際のリモート VM ではありません。",
            "widget.theme": "テーマを切り替え", "widget.settings": "設定を開く",
            "widget.themeAuto": "テーマ：自動（{theme}）", "widget.themeLight": "テーマ：ライト", "widget.themeDark": "テーマ：ダーク",
            "settings.kicker": "表示設定", "settings.title": "設定", "settings.subtitle": "テーマ、言語、表示設定はこの端末に保存され、すぐに反映されます。",
            "settings.back": "ホームへ戻る", "settings.appearance": "外観", "settings.appearanceDesc": "自動は端末のライト / ダーク設定に従います。",
            "settings.glass": "リキッドグラス", "settings.glassDesc": "ガラス表面の透明度とぼかしを調整します。オフにすると不透明になります。",
            "settings.glassEnabled": "リキッドグラスを有効化", "settings.glassEnableHint": "ヘッダー、カード、フローティング操作に半透明のガラス質感を加えます",
            "settings.glassOpacity": "ガラスの透明度", "settings.glassOpacityHint": "低いほど透明になります",
            "settings.glassBlur": "ぼかしの強さ", "settings.glassBlurHint": "高いほど背景が強くぼけます",
            "settings.glassPreview": "ガラスプレビュー", "settings.glassPreviewText": "スライダーを動かしてリキッドグラスの効果を確認できます。",
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

    // Plain-text phrases used by legacy pages. These pages predate data-i18n,
    // so the shell translates their visible copy in place and keeps an original
    // string for switching back to Chinese.
    const TEXT_TRANSLATIONS = {
        "欢迎回来": { "zh-TW": "歡迎回來", en: "Welcome back", ja: "おかえりなさい" },
        "登录 Vitual XRing，查看你的账户与 VTX 余额。": { "zh-TW": "登入 Vitual XRing，查看你的帳戶與 VTX 餘額。", en: "Sign in to Vitual XRing to view your account and VTX balance.", ja: "Vitual XRing にログインして、アカウントと VTX 残高を確認します。" },
        "登录账户名": { "zh-TW": "登入帳戶名", en: "Login name", ja: "ログイン名" },
        "密码": { "zh-TW": "密碼", en: "Password", ja: "パスワード" },
        "登录账户": { "zh-TW": "登入帳戶", en: "Sign in", ja: "ログイン" },
        "创建账户": { "zh-TW": "建立帳戶", en: "Create account", ja: "アカウント作成" },
        "登录": { "zh-TW": "登入", en: "Sign in", ja: "ログイン" },
        "返回首页": { "zh-TW": "返回首頁", en: "Back home", ja: "ホームへ戻る" },
        "← 返回首页": { "zh-TW": "← 返回首頁", en: "← Back home", ja: "← ホームへ戻る" },
        "← 返回账户": { "zh-TW": "← 返回帳戶", en: "← Back to account", ja: "← アカウントへ戻る" },
        "收款 / 付款": { "zh-TW": "收款 / 付款", en: "Receive / Pay", ja: "受け取り / 支払い" },
        "付款需要输入账户密码确认；收款直接到账，无需密码。": { "zh-TW": "付款需要輸入帳戶密碼確認；收款直接到帳，無需密碼。", en: "Payments require your account password. Receiving is instant and needs no password.", ja: "支払いにはアカウントのパスワードが必要です。受け取りは即時で、パスワードは不要です。" },
        "API：https://xsmmc.caldson.us.ci（本地预览，默认连线上 Worker；可用 ?api=覆盖）": { "zh-TW": "API：https://xsmmc.caldson.us.ci（本機預覽，預設連線上的 Worker；可用 ?api=覆寫）", en: "API: https://xsmmc.caldson.us.ci (local preview connects to the live Worker; override with ?api=)", ja: "API：https://xsmmc.caldson.us.ci（ローカルプレビューは既定でオンライン Worker に接続。?api= で上書き可能）" },
        "需要登录": { "zh-TW": "需要登入", en: "Sign in required", ja: "ログインが必要です" },
        "聊天室使用 Vitual XRing 账户登录。登录后回到这里即可开始聊天。": { "zh-TW": "聊天室使用 Vitual XRing 帳戶登入。登入後回到這裡即可開始聊天。", en: "Chat uses your Vitual XRing account. Sign in and come back to start chatting.", ja: "チャットは Vitual XRing アカウントで利用します。ログインしてここに戻ると開始できます。" },
        "前往登录": { "zh-TW": "前往登入", en: "Go to sign in", ja: "ログインへ" },
        "重新检测": { "zh-TW": "重新偵測", en: "Check again", ja: "再確認" },
        "XOS 虚拟云电脑": { "zh-TW": "XOS 虛擬雲端電腦", en: "XOS virtual desktop", ja: "XOS 仮想デスクトップ" },
        "选择一台 XOS PC，在浏览器里打开你的桌面。": { "zh-TW": "選擇一台 XOS PC，在瀏覽器裡開啟你的桌面。", en: "Choose an XOS PC and open your desktop in the browser.", ja: "XOS PC を選んで、ブラウザでデスクトップを開きます。" },
        "购买后授权会写入当前账户；XOS 是网页虚拟桌面，不是真实远程虚拟机。所有应用都在本机浏览器中运行。": { "zh-TW": "購買後授權會寫入目前帳戶；XOS 是網頁虛擬桌面，不是真實遠端虛擬機。所有應用都在本機瀏覽器中執行。", en: "Purchases are written to your account. XOS is a web virtual desktop, not a real remote VM; apps run in this browser.", ja: "購入したライセンスはアカウントに保存されます。XOS は Web 上の仮想デスクトップであり、実際のリモート VM ではありません。アプリはこのブラウザで動作します。" },
        "查看商品": { "zh-TW": "查看商品", en: "View product", ja: "商品を見る" },
        "XOS 云电脑": { "zh-TW": "XOS 雲端電腦", en: "XOS desktop", ja: "XOS デスクトップ" },
        "商店": { "zh-TW": "商店", en: "Shop", ja: "ショップ" },
        "聊天室": { "zh-TW": "聊天室", en: "Chat", ja: "チャット" },
        "账户": { "zh-TW": "帳戶", en: "Account", ja: "アカウント" },
        "我的账户": { "zh-TW": "我的帳戶", en: "My account", ja: "マイアカウント" },
        "账户总览": { "zh-TW": "帳戶總覽", en: "Account overview", ja: "アカウント概要" },
        "当前余额": { "zh-TW": "目前餘額", en: "Current balance", ja: "現在の残高" },
        "交易记录": { "zh-TW": "交易記錄", en: "Transactions", ja: "取引履歴" },
        "提款": { "zh-TW": "提款", en: "Withdraw", ja: "出金" },
        "转账": { "zh-TW": "轉帳", en: "Transfer", ja: "送金" },
        "收款码": { "zh-TW": "收款碼", en: "Receive code", ja: "受け取りコード" },
        "商品": { "zh-TW": "商品", en: "Product", ja: "商品" },
        "库存": { "zh-TW": "庫存", en: "Stock", ja: "在庫" },
        "价格": { "zh-TW": "價格", en: "Price", ja: "価格" },
        "购买": { "zh-TW": "購買", en: "Buy", ja: "購入" },
        "立即购买": { "zh-TW": "立即購買", en: "Buy now", ja: "今すぐ購入" },
        "搜索": { "zh-TW": "搜尋", en: "Search", ja: "検索" },
        "搜索商品": { "zh-TW": "搜尋商品", en: "Search products", ja: "商品を検索" },
        "全部商品": { "zh-TW": "全部商品", en: "All products", ja: "すべての商品" },
        "暂无商品": { "zh-TW": "暫無商品", en: "No products yet", ja: "商品はまだありません" },
        "加载中…": { "zh-TW": "載入中…", en: "Loading…", ja: "読み込み中…" },
        "发送": { "zh-TW": "傳送", en: "Send", ja: "送信" },
        "输入消息": { "zh-TW": "輸入訊息", en: "Type a message", ja: "メッセージを入力" },
        "好友": { "zh-TW": "好友", en: "Friends", ja: "友だち" },
        "群聊": { "zh-TW": "群聊", en: "Group chat", ja: "グループチャット" },
        "单聊": { "zh-TW": "單聊", en: "Direct chat", ja: "個人チャット" },
        "群公告": { "zh-TW": "群公告", en: "Group announcement", ja: "グループのお知らせ" },
        "成员": { "zh-TW": "成員", en: "Members", ja: "メンバー" },
        "在线": { "zh-TW": "線上", en: "Online", ja: "オンライン" },
        "离线": { "zh-TW": "離線", en: "Offline", ja: "オフライン" },
        "保存": { "zh-TW": "儲存", en: "Save", ja: "保存" },
        "取消": { "zh-TW": "取消", en: "Cancel", ja: "キャンセル" },
        "确认": { "zh-TW": "確認", en: "Confirm", ja: "確認" },
        "删除": { "zh-TW": "刪除", en: "Delete", ja: "削除" },
        "编辑": { "zh-TW": "編輯", en: "Edit", ja: "編集" },
        "关闭": { "zh-TW": "關閉", en: "Close", ja: "閉じる" },
        "任务管理器": { "zh-TW": "工作管理員", en: "Task Manager", ja: "タスクマネージャー" },
        "文件资源管理器": { "zh-TW": "檔案總管", en: "File Explorer", ja: "ファイルエクスプローラー" },
        "浏览器": { "zh-TW": "瀏覽器", en: "Browser", ja: "ブラウザ" },
        "应用": { "zh-TW": "應用", en: "Apps", ja: "アプリ" },
        "设置": { "zh-TW": "設定", en: "Settings", ja: "設定" },
        "退出登录": { "zh-TW": "登出", en: "Sign out", ja: "ログアウト" },
        "管理": { "zh-TW": "管理", en: "Manage", ja: "管理" },

        "用户名": { "zh-TW": "使用者名稱", en: "Username", ja: "ユーザー名" },
        "登录名": { "zh-TW": "登入名稱", en: "Login name", ja: "ログイン名" },
        "账户信息": { "zh-TW": "帳戶資訊", en: "Account information", ja: "アカウント情報" },
        "账户状态": { "zh-TW": "帳戶狀態", en: "Account status", ja: "アカウント状態" },
        "正常": { "zh-TW": "正常", en: "Active", ja: "正常" },
        "货币单位": { "zh-TW": "貨幣單位", en: "Currency", ja: "通貨単位" },
        "账户设置": { "zh-TW": "帳戶設定", en: "Account settings", ja: "アカウント設定" },
        "修改会写入 Workers 中的账户数据，立即生效。": { "zh-TW": "修改會寫入 Workers 中的帳戶資料，立即生效。", en: "Changes are written to account data in Workers and apply immediately.", ja: "変更は Workers のアカウントデータに保存され、すぐに反映されます。" },
        "更改用户名": { "zh-TW": "變更使用者名稱", en: "Change username", ja: "ユーザー名を変更" },
        "新用户名": { "zh-TW": "新使用者名稱", en: "New username", ja: "新しいユーザー名" },
        "2-20 个字符，仅影响显示": { "zh-TW": "2-20 個字元，僅影響顯示", en: "2–20 characters; display name only", ja: "2〜20文字。表示名のみ変更されます" },
        "更改密码": { "zh-TW": "變更密碼", en: "Change password", ja: "パスワードを変更" },
        "当前密码": { "zh-TW": "目前密碼", en: "Current password", ja: "現在のパスワード" },
        "新密码": { "zh-TW": "新密碼", en: "New password", ja: "新しいパスワード" },
        "确认新密码": { "zh-TW": "確認新密碼", en: "Confirm new password", ja: "新しいパスワード（確認）" },
        "转账会写入 Workers 中的账户数据，服务端校验密码后同时更新双方余额。": { "zh-TW": "轉帳會寫入 Workers 中的帳戶資料，伺服器驗證密碼後同時更新雙方餘額。", en: "Transfers are written to Workers account data; the server verifies your password and updates both balances.", ja: "送金は Workers のアカウントデータに保存され、サーバーがパスワードを確認して双方の残高を更新します。" },
        "收款人": { "zh-TW": "收款人", en: "Recipient", ja: "受取人" },
        "金额（VTX）": { "zh-TW": "金額（VTX）", en: "Amount (VTX)", ja: "金額（VTX）" },
        "金额 (VTX)": { "zh-TW": "金額 (VTX)", en: "Amount (VTX)", ja: "金額 (VTX)" },
        "分享生态": { "zh-TW": "分享生態", en: "Sharing ecosystem", ja: "共有エコシステム" },
        "MIDI 分享与作曲": { "zh-TW": "MIDI 分享與作曲", en: "MIDI sharing & composing", ja: "MIDI 共有・作曲" },
        "在线音乐平台": { "zh-TW": "線上音樂平台", en: "Online music platform", ja: "オンライン音楽プラットフォーム" },
        "Scratch 作品": { "zh-TW": "Scratch 作品", en: "Scratch projects", ja: "Scratch 作品" },
        "语音会议": { "zh-TW": "語音會議", en: "Voice meetings", ja: "音声会議" },
        "CSS 样式包": { "zh-TW": "CSS 樣式包", en: "CSS style packs", ja: "CSS スタイルパック" },
        "C++ 项目": { "zh-TW": "C++ 專案", en: "C++ projects", ja: "C++ プロジェクト" },
        "图文动态": { "zh-TW": "圖文動態", en: "Posts", ja: "画像・テキスト投稿" },
        "Vitx 动态": { "zh-TW": "Vitx 動態", en: "Vitx Feed", ja: "Vitx フィード" },
        "自定义分享卡片": { "zh-TW": "自訂分享卡片", en: "Custom share cards", ja: "カスタム共有カード" },
        "虚拟桌面 26H3": { "zh-TW": "虛擬桌面 26H3", en: "Virtual desktop 26H3", ja: "仮想デスクトップ 26H3" },
        "GitHub 风格仓库浏览": { "zh-TW": "GitHub 風格倉庫瀏覽", en: "GitHub-style repository browser", ja: "GitHub 風リポジトリ閲覧" },
        "英语 / 日语预览课程": { "zh-TW": "英語 / 日語預覽課程", en: "English / Japanese preview lessons", ja: "英語 / 日本語プレビューコース" },
        "账号修改": { "zh-TW": "帳號修改", en: "Account editor", ja: "アカウント編集" },
        "AI 聊天": { "zh-TW": "AI 聊天", en: "AI chat", ja: "AI チャット" },
        "AI 生图": { "zh-TW": "AI 生圖", en: "AI image", ja: "AI 画像生成" },
        "视频": { "zh-TW": "影片", en: "Video", ja: "動画" },
        "返回账户": { "zh-TW": "返回帳戶", en: "Back to account", ja: "アカウントへ戻る" },
        "登录位置": { "zh-TW": "登入位置", en: "Login locations", ja: "ログイン位置" },
        "商品分类": { "zh-TW": "商品分類", en: "Product categories", ja: "商品カテゴリ" },
        "同捆包 [Beta]": { "zh-TW": "同捆包 [Beta]", en: "Bundles [Beta]", ja: "バンドル [Beta]" },
        "XOS虚拟云电脑": { "zh-TW": "XOS 虛擬雲端電腦", en: "XOS virtual desktop", ja: "XOS 仮想デスクトップ" },
        "制造商": { "zh-TW": "製造商", en: "Manufacturer", ja: "メーカー" },
        "商家": { "zh-TW": "商家", en: "Merchant", ja: "販売者" },
        "登录以购买": { "zh-TW": "登入以購買", en: "Sign in to buy", ja: "購入するにはログイン" },
        "没有找到匹配的商品": { "zh-TW": "沒有找到符合的商品", en: "No matching products", ja: "一致する商品がありません" },

        "你好，": { "zh-TW": "你好，", en: "Hello, ", ja: "こんにちは、" },
        "这里是你的 Vitual XRing 账户信息。": { "zh-TW": "這裡是你的 Vitual XRing 帳戶資訊。", en: "This is your Vitual XRing account information.", ja: "ここはあなたの Vitual XRing アカウント情報です。" },
        "今日已签到": { "zh-TW": "今日已簽到", en: "Checked in today", ja: "今日はチェックイン済み" },
        "明天再来可以再领 5 VTX。": { "zh-TW": "明天再來可以再領 5 VTX。", en: "Come back tomorrow to claim 5 VTX.", ja: "明日また来ると 5 VTX を受け取れます。" },
        "每天可领取一次 5 VTX。": { "zh-TW": "每天可領取一次 5 VTX。", en: "Claim 5 VTX once per day.", ja: "1日1回 5 VTX を受け取れます。" },
        "签到中…": { "zh-TW": "簽到中…", en: "Checking in…", ja: "チェックイン中…" },
        "每日签到 +5 VTX": { "zh-TW": "每日簽到 +5 VTX", en: "Daily check-in +5 VTX", ja: "デイリーチェックイン +5 VTX" },
        "分享": { "zh-TW": "分享", en: "Share", ja: "共有" },
        "Vitual XRing 分享生态": { "zh-TW": "Vitual XRing 分享生態", en: "Vitual XRing sharing ecosystem", ja: "Vitual XRing 共有エコシステム" },
        "MIDI 分享与识曲": { "zh-TW": "MIDI 分享與識曲", en: "MIDI sharing & recognition", ja: "MIDI 共有・楽曲認識" },
        "英语 / 日语预览课": { "zh-TW": "英語 / 日語預覽課", en: "English / Japanese preview lessons", ja: "英語 / 日本語プレビューコース" },

        "开始": { "zh-TW": "開始", en: "Start", ja: "スタート" },
        "设备": { "zh-TW": "裝置", en: "Device", ja: "デバイス" },
        "切换设备": { "zh-TW": "切換裝置", en: "Switch device", ja: "デバイスを切り替え" },
        "关机": { "zh-TW": "關機", en: "Shut down", ja: "シャットダウン" },
        "重启": { "zh-TW": "重新啟動", en: "Restart", ja: "再起動" },
        "注销": { "zh-TW": "登出", en: "Sign out", ja: "サインアウト" },
        "共享文件": { "zh-TW": "共用檔案", en: "Shared files", ja: "共有ファイル" },
        "画图": { "zh-TW": "小畫家", en: "Paint", ja: "ペイント" },
        "TXTPro 移植版": { "zh-TW": "TXTPro 移植版", en: "TXTPro port", ja: "TXTPro 移植版" },
        "计算器": { "zh-TW": "計算機", en: "Calculator", ja: "電卓" },
        "天气": { "zh-TW": "天氣", en: "Weather", ja: "天気" },
        "Microsoft Todo 移植版": { "zh-TW": "Microsoft Todo 移植版", en: "Microsoft Todo port", ja: "Microsoft Todo 移植版" },
        "Outlook 移植版": { "zh-TW": "Outlook 移植版", en: "Outlook port", ja: "Outlook 移植版" },
        "屏幕截图": { "zh-TW": "螢幕截圖", en: "Screenshot", ja: "スクリーンショット" },
        "VSCode 移植版": { "zh-TW": "VSCode 移植版", en: "VSCode port", ja: "VSCode 移植版" },
        "3D 画图": { "zh-TW": "3D 繪圖", en: "3D Paint", ja: "3D ペイント" },
        "Musescore 4": { "zh-TW": "Musescore 4", en: "Musescore 4", ja: "Musescore 4" },
        "MIDI 播放器": { "zh-TW": "MIDI 播放器", en: "MIDI Player", ja: "MIDI プレイヤー" },
        "计时器": { "zh-TW": "計時器", en: "Timer", ja: "タイマー" },
        "Development Kit": { "zh-TW": "Development Kit", en: "Development Kit", ja: "Development Kit" },
        "Development Kit CE": { "zh-TW": "Development Kit CE", en: "Development Kit CE", ja: "Development Kit CE" },
        "库乐队": { "zh-TW": "庫樂隊", en: "GarageBand", ja: "GarageBand" },
        "番茄钟": { "zh-TW": "番茄鐘", en: "Pomodoro", ja: "ポモドーロ" },
        "欢迎使用 XOS": { "zh-TW": "歡迎使用 XOS", en: "Welcome to XOS", ja: "XOS へようこそ" },
        "登录 XOS": { "zh-TW": "登入 XOS", en: "Sign in to XOS", ja: "XOS にログイン" },
        "选择设备": { "zh-TW": "選擇裝置", en: "Select device", ja: "デバイスを選択" },
        "刷新率": { "zh-TW": "重新整理率", en: "Refresh rate", ja: "リフレッシュレート" },
        "云同步": { "zh-TW": "雲端同步", en: "Cloud sync", ja: "クラウド同期" },
        "返回主页": { "zh-TW": "返回首頁", en: "Back home", ja: "ホームへ戻る" },
        "锁定": { "zh-TW": "鎖定", en: "Lock", ja: "ロック" },
        "账户菜单": { "zh-TW": "帳戶選單", en: "Account menu", ja: "アカウントメニュー" },
        "切换云电脑": { "zh-TW": "切換雲端電腦", en: "Switch device", ja: "デバイスを切り替え" },
        "当前只有一台云电脑": { "zh-TW": "目前只有一台雲端電腦", en: "Only one device", ja: "デバイスは1台のみです" },
        "最小化": { "zh-TW": "最小化", en: "Minimize", ja: "最小化" },
        "最大化": { "zh-TW": "最大化", en: "Maximize", ja: "最大化" },
        "当前 XOS 版本不支持这个应用": { "zh-TW": "目前 XOS 版本不支援這個應用", en: "This XOS version does not support this app.", ja: "この XOS バージョンではこのアプリを利用できません。" },
        "内存": { "zh-TW": "記憶體", en: "Memory", ja: "メモリ" },
        "已登录账户": { "zh-TW": "已登入帳戶", en: "Signed in account", ja: "ログイン中のアカウント" },
        "XOS 商店": { "zh-TW": "XOS 商店", en: "XOS Shop", ja: "XOS ショップ" },
        "账户中心": { "zh-TW": "帳戶中心", en: "Account center", ja: "アカウントセンター" }
    };

    const TEXT_ATTRIBUTES = ["placeholder", "title", "aria-label"];

    function translatePhrase(value, language) {
        if (!value) return "";
        const raw = String(value).trim();
        if (!raw || language === "zh-CN") return raw;
        const entry = TEXT_TRANSLATIONS[raw];
        if (entry && entry[language]) return entry[language];
        const prefixed = raw.match(/^([^\p{L}\p{N}]+)(.+)$/u);
        if (prefixed) {
            const inner = translatePhrase(prefixed[2], language);
            if (inner !== prefixed[2].trim()) return prefixed[1] + inner;
        }
        if (language === "en") {
            let match = raw.match(/^(\d+)\s*个应用$/);
            if (match) return `${match[1]} apps`;
            match = raw.match(/^(\d+)\s*个词条$/);
            if (match) return `${match[1]} entries`;
        }
        if (language === "ja") {
            let match = raw.match(/^(\d+)\s*个应用$/);
            if (match) return `${match[1]} 個のアプリ`;
            match = raw.match(/^(\d+)\s*个词条$/);
            if (match) return `${match[1]} 項目`;
        }
        if (language === "zh-TW") {
            let match = raw.match(/^(\d+)\s*个应用$/);
            if (match) return `${match[1]} 個應用`;
            match = raw.match(/^(\d+)\s*个词条$/);
            if (match) return `${match[1]} 個詞條`;
        }
        return raw;
    }

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

    const GLASS_KEY = "xring:glass";
    const GLASS_DEFAULTS = { enabled: true, opacity: 0.56, blur: 18 };
    let glass = { ...GLASS_DEFAULTS };
    try {
        const savedGlass = JSON.parse(read(GLASS_KEY, "{}") || "{}");
        if (savedGlass && typeof savedGlass === "object") {
            glass.enabled = savedGlass.enabled !== false;
            glass.opacity = Number.isFinite(Number(savedGlass.opacity)) ? Math.min(.95, Math.max(.2, Number(savedGlass.opacity))) : GLASS_DEFAULTS.opacity;
            glass.blur = Number.isFinite(Number(savedGlass.blur)) ? Math.min(40, Math.max(0, Number(savedGlass.blur))) : GLASS_DEFAULTS.blur;
        }
    } catch (error) {
        glass = { ...GLASS_DEFAULTS };
    }

    function applyGlass() {
        document.documentElement.dataset.glass = glass.enabled ? "on" : "off";
        document.documentElement.style.setProperty("--vtx-glass-alpha", String(glass.opacity));
        document.documentElement.style.setProperty("--vtx-glass-blur", `${glass.blur}px`);
        window.dispatchEvent(new CustomEvent("vtx:glasschange", { detail: { ...glass } }));
    }

    function setGlass(patch) {
        const next = { ...glass, ...(patch || {}) };
        glass = {
            enabled: Boolean(next.enabled),
            opacity: Math.min(.95, Math.max(.2, Number(next.opacity) || GLASS_DEFAULTS.opacity)),
            blur: Math.min(40, Math.max(0, Number(next.blur) || 0))
        };
        write(GLASS_KEY, JSON.stringify(glass));
        applyGlass();
    }

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
        const skipText = Boolean(document.body && document.body.dataset.vtxSkipText === "true");
        if (!skipText) {
            document.querySelectorAll("a, button, summary").forEach((node) => {
                if (node.hasAttribute("data-i18n") || node.childElementCount > 0) return;
                const original = node.dataset.vtxCommonKey || node.textContent.trim();
                const key = COMMON[original];
                if (key) {
                    node.dataset.vtxCommonKey = original;
                    node.textContent = t(key, language);
                }
            });
            translatePage(language);
        }
        updateWidget();
        window.dispatchEvent(new CustomEvent("vtx:languagechange", { detail: { mode: languageMode, language } }));
    }

    const textOriginals = new WeakMap();
    const attributeOriginals = new WeakMap();
    const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE"]);
    let textObserver = null;

    function canTranslateNode(node) {
        const parent = node.parentElement;
        if (!parent) return false;
        if (SKIP_TAGS.has(parent.tagName)) return false;
        if (parent.closest("[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria]")) return false;
        return true;
    }

    function translateTextNode(node, language) {
        if (!node.nodeValue || !node.nodeValue.trim() || !canTranslateNode(node)) return;
        const current = node.nodeValue;
        if (language === "zh-CN") {
            const original = textOriginals.get(node);
            if (original !== undefined && current !== original) node.nodeValue = original;
            textOriginals.delete(node);
            return;
        }
        const original = textOriginals.get(node) || current;
        const leading = original.match(/^\s*/)[0];
        const trailing = original.match(/\s*$/)[0];
        const translated = translatePhrase(original, language);
        if (translated !== original.trim()) {
            textOriginals.set(node, original);
            const next = leading + translated + trailing;
            if (current !== next) node.nodeValue = next;
        }
    }

    function translateAttributes(element, language) {
        if (!element || element.nodeType !== 1) return;
        const saved = attributeOriginals.get(element) || {};
        for (const attribute of TEXT_ATTRIBUTES) {
            if (!element.hasAttribute(attribute)) continue;
            if (attribute === "placeholder" && element.hasAttribute("data-i18n-placeholder")) continue;
            if (attribute === "title" && element.hasAttribute("data-i18n-title")) continue;
            if (attribute === "aria-label" && element.hasAttribute("data-i18n-aria")) continue;
            if (saved[attribute] === undefined) saved[attribute] = element.getAttribute(attribute);
            const original = saved[attribute];
            if (language === "zh-CN") {
                element.setAttribute(attribute, original);
                continue;
            }
            const translated = translatePhrase(original, language);
            if (translated !== original.trim()) element.setAttribute(attribute, translated);
        }
        attributeOriginals.set(element, saved);
    }

    function translateSubtree(root, language) {
        if (!root) return;
        if (root.nodeType === 3) {
            translateTextNode(root, language);
            return;
        }
        if (root.nodeType !== 1 && root.nodeType !== 9) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
            translateTextNode(node, language);
            node = walker.nextNode();
        }
        if (root.nodeType === 1) {
            translateAttributes(root, language);
            root.querySelectorAll("[placeholder], [title], [aria-label]").forEach((element) => translateAttributes(element, language));
        }
    }

    function translatePage(language, force) {
        if (!document.body) return;
        if (!force && document.body.dataset.vtxSkipText === "true") return;
        translateSubtree(document.body, language);
    }

    function startTextObserver() {
        if (textObserver || !document.body || typeof MutationObserver === "undefined") return;
        textObserver = new MutationObserver((mutations) => {
            const language = effectiveLanguage();
            if (language === "zh-CN") return;
            if (document.body && document.body.dataset.vtxSkipText === "true") return;
            for (const mutation of mutations) {
                if (mutation.type === "characterData") {
                    translateTextNode(mutation.target, language);
                } else {
                    mutation.addedNodes.forEach((node) => translateSubtree(node, language));
                }
            }
        });
        textObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
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

    /* 12.0.1：聊天页的输入框和发送按钮也在右下角，悬浮球原来会直接压在上面。
       页面给底部输入区加 data-vtx-widget-avoid，这里按它的实际高度把悬浮球
       抬到输入区上方；没有这个标记的页面仍然贴在右下角。 */
    function syncWidgetOffset() {
        if (!widget) return;
        const target = document.querySelector("[data-vtx-widget-avoid]");
        let lift = 0;
        if (target) {
            const rect = target.getBoundingClientRect();
            if (rect.height > 0 && rect.top < window.innerHeight) {
                const overlap = window.innerHeight - rect.top;
                lift = Math.min(Math.round(overlap) + 10, Math.round(window.innerHeight * 0.6));
            }
        }
        document.documentElement.style.setProperty("--vtx-widget-lift", `${Math.max(0, lift)}px`);
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
    applyGlass();
    document.documentElement.lang = effectiveLanguage();
    document.documentElement.dataset.language = effectiveLanguage();

    document.addEventListener("DOMContentLoaded", () => {
        applyTheme();
        applyGlass();
        applyLanguage();
        createWidget();
        syncWidgetOffset();
        window.addEventListener("resize", syncWidgetOffset);
        window.addEventListener("orientationchange", () => setTimeout(syncWidgetOffset, 160));
        startTextObserver();
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
        if (event.key === GLASS_KEY) {
            try {
                const savedGlass = JSON.parse(event.newValue || "{}");
                if (savedGlass && typeof savedGlass === "object") {
                    glass.enabled = savedGlass.enabled !== false;
                    glass.opacity = Math.min(.95, Math.max(.2, Number(savedGlass.opacity) || GLASS_DEFAULTS.opacity));
                    glass.blur = Math.min(40, Math.max(0, Number(savedGlass.blur) || GLASS_DEFAULTS.blur));
                    applyGlass();
                }
            } catch (error) { /* ignore */ }
        }
    });

    /* 12.0.1：全站 BGM 播放器由主题壳统一加载，页面不必逐个加 script。 */
    try {
        const bgmPath = String(location.pathname || "");
        const skipBgm = /(^|\/)(WebsiteClose|offline)\.html$/i.test(bgmPath);
        if (!skipBgm && !document.getElementById("vtx-bgm-loader") && document.head) {
            const bgmScript = document.createElement("script");
            bgmScript.id = "vtx-bgm-loader";
            bgmScript.src = `vtx-bgm.js?v=${VERSION}`;
            bgmScript.async = false;
            bgmScript.defer = true;
            document.head.appendChild(bgmScript);
        }
    } catch (error) {
        /* BGM 加载失败不影响页面 */
    }

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
        getGlass: () => ({ ...glass }),
        setGlass,
        applyGlass,
        translatePage,
        translateSubtree,
        syncWidgetOffset,
        t: (key) => t(key, effectiveLanguage())
    };
})();
