(function () {
    const ITERATIONS = 310000;
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

    async function deriveKey(passphrase, salt, iterations) {
        const baseKey = await crypto.subtle.importKey(
            "raw",
            encoder.encode(passphrase),
            "PBKDF2",
            false,
            ["deriveKey"]
        );

        return crypto.subtle.deriveKey(
            { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
            baseKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    }

    async function encrypt(token, passphrase) {
        assertSupported();
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await deriveKey(passphrase, salt, ITERATIONS);
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

    async function decrypt(config, passphrase) {
        assertSupported();

        if (!config || !config.ciphertext) {
            throw new Error("secure.json 里还没有加密 token，请先用 crypto.html 生成。");
        }

        const iterations = Number(config.iterations) || ITERATIONS;
        const key = await deriveKey(passphrase, fromBase64(config.salt), iterations);

        let plaintext;
        try {
            plaintext = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: fromBase64(config.iv) },
                key,
                fromBase64(config.ciphertext)
            );
        } catch (error) {
            throw new Error("口令错误，或 secure.json 已损坏，无法解密 token。");
        }

        return decoder.decode(plaintext).trim();
    }

    window.VTXCrypto = { encrypt, decrypt, ITERATIONS };
})();
