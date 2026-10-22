(function () {
    const HISTORY_LIMIT = 20;
    const REQUEST_TIMEOUT = 6000;
    const MAX_IP_LENGTH = 45;
    const MAX_TEXT_LENGTH = 40;
    const MAX_ISP_LENGTH = 60;

    const PROVIDERS = [
        {
            url: "https://ipwho.is/",
            read(data) {
                if (!data || data.success === false || !data.ip) {
                    return null;
                }
                const connection = data.connection || {};
                return {
                    ip: data.ip,
                    latitude: data.latitude,
                    longitude: data.longitude,
                    city: data.city,
                    region: data.region,
                    country: data.country,
                    isp: connection.isp || connection.org
                };
            }
        },
        {
            url: "https://ipinfo.io/json",
            read(data) {
                if (!data || !data.ip) {
                    return null;
                }
                const [latitude, longitude] = String(data.loc || "").split(",");
                return {
                    ip: data.ip,
                    latitude,
                    longitude,
                    city: data.city,
                    region: data.region,
                    country: data.country,
                    isp: data.org
                };
            }
        },
        {
            url: "https://api.ip.sb/geoip",
            read(data) {
                if (!data || !data.ip) {
                    return null;
                }
                return {
                    ip: data.ip,
                    latitude: data.latitude,
                    longitude: data.longitude,
                    city: data.city,
                    region: data.region,
                    country: data.country,
                    isp: data.isp || data.organization
                };
            }
        },
        {
            url: "https://ipapi.co/json/",
            read(data) {
                if (!data || !data.ip) {
                    return null;
                }
                return {
                    ip: data.ip,
                    latitude: data.latitude,
                    longitude: data.longitude,
                    city: data.city,
                    region: data.region,
                    country: data.country_name,
                    isp: data.org
                };
            }
        },
        {
            url: "https://api.ipify.org/?format=json",
            read(data) {
                return data && data.ip ? { ip: data.ip } : null;
            }
        }
    ];

    function clean(value, limit) {
        const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
        return text ? text.slice(0, limit) : "";
    }

    function coord(value, limit) {
        const number = Number(value);
        return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
    }

    function requestJson(url) {
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT) : null;

        return fetch(url, { cache: "no-store", signal: controller ? controller.signal : undefined })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                return response.json();
            })
            .finally(() => {
                if (timer) {
                    clearTimeout(timer);
                }
            });
    }

    function normalize(raw) {
        let latitude = coord(raw.latitude, 90);
        let longitude = coord(raw.longitude, 180);
        if (latitude === null || longitude === null) {
            latitude = null;
            longitude = null;
        }

        const entry = {};
        const ip = clean(raw.ip, MAX_IP_LENGTH);
        if (ip) {
            entry.ip = ip;
        }
        if (latitude !== null) {
            entry.latitude = latitude;
            entry.longitude = longitude;
        }
        for (const [key, value, limit] of [
            ["city", raw.city, MAX_TEXT_LENGTH],
            ["region", raw.region, MAX_TEXT_LENGTH],
            ["country", raw.country, MAX_TEXT_LENGTH],
            ["isp", raw.isp, MAX_ISP_LENGTH]
        ]) {
            const text = clean(value, limit);
            if (text) {
                entry[key] = text;
            }
        }

        return entry;
    }

    async function locate() {
        for (const provider of PROVIDERS) {
            try {
                const data = await requestJson(provider.url);
                const entry = provider.read(data);
                if (entry) {
                    return normalize(entry);
                }
            } catch (error) {
                /* 换下一个来源 */
            }
        }
        return normalize({});
    }

    function timestamp() {
        const now = new Date();
        const pad = (value) => String(value).padStart(2, "0");
        return `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} `
            + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    function hasCoords(entry) {
        return Boolean(entry)
            && Number.isFinite(Number(entry.latitude))
            && Number.isFinite(Number(entry.longitude));
    }

    function describe(entry) {
        const parts = [];
        for (const value of [entry.city, entry.region, entry.country]) {
            const text = clean(value, MAX_TEXT_LENGTH);
            if (text && !parts.some((item) => item.toLowerCase() === text.toLowerCase())) {
                parts.push(text);
            }
        }
        return parts.length ? parts.join("，") : "未知位置";
    }

    async function recordLogin(accountName) {
        if (!accountName || !window.VTXApi) {
            return null;
        }

        const entry = { time: timestamp(), ...(await locate()) };

        try {
            const accounts = await window.VTXApi.commit((data) => {
                const account = data[accountName];
                if (!account) {
                    throw new Error("账户不存在");
                }
                const history = Array.isArray(account.loginHistory) ? account.loginHistory : [];
                history.push(entry);
                account.loginHistory = history.slice(-HISTORY_LIMIT);
                return `登录记录：${accountName}${entry.ip ? ` ${entry.ip}` : ""}`;
            });
            return { entry, accounts };
        } catch (error) {
            /* 登录记录失败不能影响登录本身 */
            return null;
        }
    }

    window.VTXGeo = { locate, recordLogin, hasCoords, describe };
})();
