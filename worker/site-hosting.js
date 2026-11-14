/* 12.1.3：Vtoy / VDEX 多页文件托管。 */
const VTOY_PREFIX = "vtoy:app:";
const VDEX_PREFIX = "vdex:site:";

function htmlResponse(html, bridge) {
    let body = String(html || "");
    const script = `<script>${bridge}<\/script>`;
    if (/<\/body>/i.test(body)) body = body.replace(/<\/body>/i, script + "</body>");
    else body += script;
    return new Response(body, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff"
        }
    });
}

function textResponse(content, type) {
    return new Response(String(content || ""), {
        headers: {
            "content-type": `${type}; charset=utf-8`,
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff"
        }
    });
}

function notFound() {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function vtoyBridge() {
    return `(function(){
        var pending={},seq=0;
        window.VTX={
            login:function(){return call("login");},
            getUser:function(){return call("user");},
            getBalance:function(){return call("balance");}
        };
        function call(method){
            return new Promise(function(resolve,reject){
                var id="r"+(++seq);
                pending[id]={resolve:resolve,reject:reject};
                parent.postMessage({source:"vtoy-app",id:id,method:method},"*");
                setTimeout(function(){if(pending[id]){delete pending[id];reject(new Error("请求超时"));}},20000);
            });
        }
        window.addEventListener("message",function(event){
            var data=event.data||{};
            if(data.source!=="vtoy-host"||!data.id||!pending[data.id])return;
            var item=pending[data.id];delete pending[data.id];
            if(data.ok)item.resolve(data.result);
            else{var error=new Error(data.error||"请求被拒绝");error.status=data.status||0;error.code=data.code||"";item.reject(error);}
        });
    })();`;
}

function vdexBridge(name, plan) {
    return `(function(){
        var origin="https://xsmmc.caldson.us.ci";
        window.VDEX={
            plan:${JSON.stringify(plan)},
            login:function(){
                return new Promise(function(resolve,reject){
                    var popup=window.open(origin+"/API_LOGIN.html","vdex-login","width=480,height=680");
                    if(!popup){var blocked=new Error("登录窗口被拦截");blocked.status=402;blocked.code="login_rejected";reject(blocked);return;}
                    var done=false;
                    function finish(){if(done)return;done=true;window.removeEventListener("message",onMessage);clearInterval(timer);}
                    function onMessage(event){if(event.origin!==origin)return;var data=event.data||{};if(data.type!=="vtx-login"||!data.ok)return;finish();var account=(data.result&&data.result.account)||{};resolve({login:data.result.login,username:account.username,uid:account.uid});}
                    window.addEventListener("message",onMessage);
                    var timer=setInterval(function(){if(popup.closed){finish();var error=new Error("用户拒绝登录");error.status=402;error.code="login_rejected";reject(error);}},300);
                });
            },
            pay:function(){window.open(origin+"/API_VTXPAY.html","_blank");},
            getData:function(){return fetch("/api/vdex/data?name=${encodeURIComponent(name)}").then(function(r){return r.json();}).then(function(r){return r.data;});}
        };
    })();`;
}

function parseTarget(pathname, prefix) {
    const rest = decodeURIComponent(pathname.slice(prefix.length));
    const parts = rest.split("/").filter(Boolean);
    if (!parts.length) return null;
    const name = parts.shift();
    const file = parts.join("/") || "index.html";
    if (!name || name === "." || name === ".." || /[\\/]/.test(file) || file === "." || file === "..") return null;
    return { name, file };
}

export async function serveVtoyPage(request, env, url) {
    const target = parseTarget(url.pathname, "/vtoy-app/");
    if (!target) return notFound();
    const record = await env.ACCOUNTS_KV.get(VTOY_PREFIX + target.name, "json");
    if (!record) return notFound();
    const file = target.file;
    if (file.endsWith(".html")) {
        const pages = record.pages || { "index.html": record.html };
        const html = pages[file] || (file === "index.html" ? record.html : "");
        if (!html) return notFound();
        return htmlResponse(html, vtoyBridge());
    }
    if (file === "style.css") return textResponse(record.css, "text/css");
    if (file === "app.js") return textResponse(record.js, "text/javascript");
    return notFound();
}

export async function serveVdexPage(request, env, url) {
    const target = parseTarget(url.pathname, "/vdex-site/");
    if (!target) return notFound();
    const record = await env.ACCOUNTS_KV.get(VDEX_PREFIX + target.name, "json");
    if (!record) return notFound();
    const file = target.file;
    if (file.endsWith(".html")) {
        const pages = record.pages || { "index.html": record.html };
        const html = pages[file] || (file === "index.html" ? record.html : "");
        if (!html) return notFound();
        const bridge = (record.plan === "pro" || record.plan === "enterprise") ? vdexBridge(record.name, record.plan) : "";
        return htmlResponse(html, bridge);
    }
    if (file === "style.css") return textResponse(record.css, "text/css");
    if (file === "script.js") return textResponse(record.js, "text/javascript");
    if (file === "data.json") {
        const data = await env.ACCOUNTS_KV.get("vdex:data:" + target.name, "json");
        return textResponse(JSON.stringify(data == null ? null : data, null, 2), "application/json");
    }
    return notFound();
}