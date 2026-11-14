(function () {
    const ITERATIONS = 310000;
    const STATIC_SECRET = "Vitual-XRing/secure.json/v1";

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    function toBase64(bytes) {
        let binary = "";
        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }
        return btoa(binary);
    }

    function fromBase64(text) {
        const binary = atob(String(text).replace(/\s/g, ""));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    }

    function assertSupported() {
        if (!window.crypto || !window.crypto.subtle) {
            throw new Error("当前页面无法使用浏览器加密（WebCrypto 需要 https 或 localhost）。");
        }
    }

    async function deriveKey(salt) {
        const baseKey = await crypto.subtle.importKey(
            "raw",
            encoder.encode(STATIC_SECRET),
            "PBKDF2",
            false,
            ["deriveKey"]
        );

        return crypto.subtle.deriveKey(
            { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
            baseKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    }

    async function encrypt(token) {
        assertSupported();
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await deriveKey(salt);
        const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            key,
            encoder.encode(token)
        );

        return {
            kdf: "PBKDF2-SHA256",
            iterations: ITERATIONS,
            salt: toBase64(salt),
            iv: toBase64(iv),
            ciphertext: toBase64(new Uint8Array(ciphertext))
        };
    }

    async function decrypt(config) {
        assertSupported();

        if (!config || !config.ciphertext) {
            throw new Error("secure.json 里还没有 token，请先用 crypto.html 生成。");
        }

        const key = await deriveKey(fromBase64(config.salt));

        let plaintext;
        try {
            plaintext = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: fromBase64(config.iv) },
                key,
                fromBase64(config.ciphertext)
            );
        } catch (error) {
            throw new Error("无法解密 token，请用 crypto.html 重新生成 secure.json。");
        }

        return decoder.decode(plaintext).trim();
    }

    window.VTXCrypto = { encrypt, decrypt };
})();
