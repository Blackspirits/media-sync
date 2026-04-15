/**
 * core/toast.js — Toast notifications and progress toasts.
 *
 * Source of truth: filmin.user.js
 * Used by: filmin, filmtwist, pandaplus, zigzag
 *
 * Each service runs on its own domain, so a single shared namespace is fine.
 */

const CSS_ID       = "bs-ms-toast-css";
const CONTAINER_ID = "bs-ms-toast-container";

function _injectToastCSS() {
    if (document.getElementById(CSS_ID)) return;
    const s = document.createElement("style");
    s.id = CSS_ID;
    s.textContent = `
    #${CONTAINER_ID} { position:fixed;bottom:20px;right:20px;z-index:1000000;
        display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none; }
    .bs-ms-toast { background:rgba(10,14,22,.97);color:#f1f5f9;padding:11px 18px;
        border-radius:8px;font-size:13.5px;font-weight:500;max-width:340px;
        font-family:system-ui,-apple-system,sans-serif;
        border:1px solid rgba(255,255,255,.08);border-left:3px solid #00e0a4;
        box-shadow:0 8px 24px rgba(0,0,0,.6);backdrop-filter:blur(8px);
        animation:bsMsSlideIn .35s cubic-bezier(.16,1,.3,1) forwards; }
    .bs-ms-toast-success { border-left-color:#10b981 !important; }
    .bs-ms-toast-error   { border-left-color:#ef4444 !important; }
    .bs-ms-toast-warning { border-left-color:#f59e0b !important; }
    .bs-ms-toast-info    { border-left-color:#00e0a4 !important; }
    .bs-ms-toast.bs-ms-toast-out { animation:bsMsSlideOut .25s ease-in forwards; }
    .bs-ms-toast-progress { width:300px;display:flex;flex-direction:column;gap:8px; }
    @keyframes bsMsSlideIn  { from { transform:translateX(calc(100% + 24px));opacity:0; } to { transform:translateX(0);opacity:1; } }
    @keyframes bsMsSlideOut { from { transform:translateX(0);opacity:1; } to { transform:translateX(calc(100% + 24px));opacity:0; } }
    `;
    (document.head || document.documentElement).appendChild(s);
}

function _getToastContainer() {
    _injectToastCSS();
    let c = document.getElementById(CONTAINER_ID);
    if (!c) {
        c = document.createElement("div");
        c.id = CONTAINER_ID;
        document.documentElement.appendChild(c);
    }
    return c;
}

/**
 * Shows an animated progress toast.
 * Pass current === -1 to dismiss immediately.
 * Pass current >= total to auto-dismiss after 1s.
 */
export function progressToast(id, title, current, total) {
    const container = _getToastContainer();
    let pToast = document.getElementById(id);
    if (!pToast) {
        pToast = document.createElement("div");
        pToast.id = id;
        pToast.className = "bs-ms-toast bs-ms-toast-progress";
        pToast.style.cssText = "padding:12px 18px;background:rgba(10,14,22,.97);border:1px solid rgba(255,255,255,.1);border-left:3px solid #3b82f6;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.6);animation:bsMsSlideIn .35s cubic-bezier(.16,1,.3,1) forwards;";
        pToast.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#f1f5f9;margin-bottom:8px;">
                <span class="bs-ms-progress-title" style="font-weight:500;"></span>
                <span class="bs-ms-progress-pct" style="font-size:11px;color:#94a3b8;">0%</span>
            </div>
            <div style="width:100%;height:4px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden;">
                <div class="bs-ms-progress-fill" style="width:0%;height:100%;background:#3b82f6;transition:width .2s;border-radius:2px;"></div>
            </div>`;
        container.appendChild(pToast);
    }
    if (total > 0) {
        const pct = Math.round((current / total) * 100);
        pToast.querySelector(".bs-ms-progress-title").textContent = title;
        pToast.querySelector(".bs-ms-progress-pct").textContent   = `${current}/${total} (${pct}%)`;
        pToast.querySelector(".bs-ms-progress-fill").style.width  = `${pct}%`;
        if (current >= total) {
            setTimeout(() => {
                pToast.classList.add("bs-ms-toast-out");
                pToast.addEventListener("animationend", () => pToast.remove(), { once: true });
            }, 1000);
        }
    } else if (current === -1) {
        pToast.classList.add("bs-ms-toast-out");
        pToast.addEventListener("animationend", () => pToast.remove(), { once: true });
    }
}

/**
 * Shows a temporary notification popup.
 * @param {string} msg
 * @param {number} duration  milliseconds (default 4000)
 * @param {"info"|"success"|"error"|"warning"} type
 */
export function toast(msg, duration = 4000, type = "info") {
    const container = _getToastContainer();
    const t = document.createElement("div");
    t.className = `bs-ms-toast bs-ms-toast-${type}`;
    t.textContent = msg;
    container.appendChild(t);
    const dismiss = () => {
        t.classList.add("bs-ms-toast-out");
        t.addEventListener("animationend", () => t.remove(), { once: true });
    };
    setTimeout(dismiss, duration);
}

/** Client-side file download fallback (creates a temporary <a> element) */
export function downloadFallback(filename, content) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
}
