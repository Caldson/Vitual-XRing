/* 12.1.0：Vtoy / VDEX 的标题只从 HTML 的 <title> 读取，默认 Document。 */
export function documentTitle(html, fallback = "Document") {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
    if (!match) return fallback;
    const text = match[1]
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
    return text ? text.slice(0, 80) : fallback;
}
