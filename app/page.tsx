'use client';
import React, { useEffect, useMemo, useRef, useState } from "react";

type Segment = {
  id: string;
  text: string;
  translation?: string;
  status?: "idle" | "translating" | "fresh" | "stale" | "error";
  locked?: boolean;
  errorMsg?: string;
};

type LayoutMode = "side" | "below";
type Provider = "dummy" | "libre" | "backend";
type SegMode = "sentence" | "paragraph";

const NL = "\n";
const LS_DOC = "bw_mvp_light_doc";

function hashStr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return String(h >>> 0);
}
function debounce<T extends (...args: any[]) => void>(fn: T, wait = 600) {
  let t: any; return (...args: Parameters<T>) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// HTML -> 纯文本（句子分割用）
function htmlToPlainText(html: string) {
  const div = document.createElement("div");
  div.innerHTML = html;
  const blocks = new Set(["P","DIV","LI","H1","H2","H3","H4","H5","H6","BLOCKQUOTE"]);
  function walk(n: Node): string {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent || "";
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement;
      if (el.tagName === "BR") return NL;
      let out = ""; for (const c of Array.from(el.childNodes)) out += walk(c);
      if (blocks.has(el.tagName)) out += NL; return out;
    }
    return "";
  }
  const text = Array.from(div.childNodes).map(walk).join("");
  return text.replace(new RegExp(NL + "{3,}", "g"), NL + NL);
}
// HTML -> 段落数组（段落分割用）
function extractParagraphsFromHTML(html: string): string[] {
  const root = document.createElement("div"); root.innerHTML = html;
  const toText = (el: HTMLElement): string => {
    let out = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent || "";
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as HTMLElement;
        if (e.tagName === "BR") out += NL; else out += toText(e);
      }
    });
    return out.trim();
  };
  const paras: string[] = [];
  root.childNodes.forEach((n) => {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement; const t = toText(el); if (t) paras.push(t);
    } else if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent || "").trim(); if (t) paras.push(t);
    }
  });
  if (paras.length) return paras;
  const single = (root.textContent || "").trim(); return single ? [single] : [];
}
// 句子切分
function splitIntoSentences(text: string): string[] {
  const re = new RegExp(`[^。.！？!?${NL}]+[。.！？!?${NL}]*`, "g");
  const arr = text.match(re); if (!arr) return text ? [text] : []; return arr;
}

// 安全复制（Clipboard API 受限时用 fallback）
async function copyText(str: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(str || ""); return true; }
  } catch {}
  try {
    const ta = document.createElement("textarea"); ta.value = str || ""; ta.setAttribute("readonly",""); ta.style.position="fixed"; ta.style.opacity="0"; ta.style.left="-9999px";
    document.body.appendChild(ta); ta.focus(); ta.select(); const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
  } catch { return false; }
}

// 粘贴清洗
function escapeHtml(s: string) { return (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function sanitizePlainTextToHtml(text: string) {
  const t = (text || "").replace(/\r\n?/g,"\n");
  const paras = t.split(/\n{2,}/);
  return paras.map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g,"<br>")}</p>`).join("");
}

// 翻译实现
async function translateDummy(q: string, _src: string, tgt: string) { return `${q}` + (_src !== tgt ? ` [${tgt.toUpperCase()}]` : ""); }
async function translateLibre(q: string, src: string, tgt: string, endpoint: string, apiKey?: string) {
  const res = await fetch(endpoint || "https://libretranslate.de/translate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q, source: src, target: tgt, format: "text", api_key: apiKey || undefined }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (data?.translatedText) return data.translatedText as string;
  if (Array.isArray(data) && data[0]?.translatedText) return data[0].translatedText as string;
  throw new Error("Unexpected response");
}
async function translateBackend(q: string, src: string, tgt: string) {
  const res = await fetch('/api/translate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q, source: src, target: tgt })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const text = (data && (data.text ?? data.translatedText)) as string | undefined;
  if (!text) throw new Error('Bad response'); return text;
}

export default function Page() {
  const [layout, setLayout] = useState<LayoutMode>("side");
  const [segMode, setSegMode] = useState<SegMode>("sentence");
  const [provider, setProvider] = useState<Provider>("dummy");
  const [endpoint, setEndpoint] = useState("https://libretranslate.de/translate");
  const [apiKey, setApiKey] = useState("");
  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("en");
  const [autoTranslate, setAutoTranslate] = useState(true);

  const [html, setHtml] = useState("<p>在此像写文档一样输入；右侧/下方自动生成译文。</p>");
  const editorRef = useRef<HTMLDivElement | null>(null);

  const [segments, setSegments] = useState<Segment[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressActive, setProgressActive] = useState(false);
  const [draftBanner, setDraftBanner] = useState<{ html: string; savedAt: number } | null>(null);

  useEffect(() => { const el = editorRef.current; if (el && el.innerHTML !== html) el.innerHTML = html; }, [layout]);
  useEffect(() => { try { const raw = localStorage.getItem(LS_DOC); if (raw) { const obj = JSON.parse(raw); if (obj?.html && obj.html !== html) setDraftBanner({ html: obj.html, savedAt: obj.savedAt || Date.now() }); } } catch {} }, []);
  const debouncedSave = useRef(debounce((h: string) => { try { localStorage.setItem(LS_DOC, JSON.stringify({ html: h, savedAt: Date.now() })); } catch {} }, 1000));
  useEffect(() => { debouncedSave.current(html); }, [html]);
  useEffect(() => { const h = () => { try { localStorage.setItem(LS_DOC, JSON.stringify({ html, savedAt: Date.now() })); } catch {} }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [html]);

  useEffect(() => {
    let newSegTexts: string[] = [];
    if (segMode === "sentence") {
      const plain = htmlToPlainText(html); newSegTexts = splitIntoSentences(plain);
    } else { newSegTexts = extractParagraphsFromHTML(html); }
    setSegments((prev) => newSegTexts.map((t, i) => {
      const old = prev[i];
      if (old && old.text === t) return old;
      return { id: hashStr(i + ":" + t), text: t, translation: old?.locked ? old.translation : undefined, status: old ? (old.locked ? old.status : "stale") : "idle", locked: !!old?.locked };
    }));
  }, [html, segMode]);

  const autoRef = useRef(autoTranslate); useEffect(() => { autoRef.current = autoTranslate; }, [autoTranslate]);
  const translateRef = useRef<() => void>(() => {}); useEffect(() => { translateRef.current = translateStale; });
  const debouncedAuto = useRef(debounce(() => { if (autoRef.current) translateRef.current(); }, 700));

  function showToast(msg: string, type: "success" | "error" = "success") { setToast({ msg, type }); setTimeout(() => setToast(null), 1600); }
  function flushEditorDom() { const el = editorRef.current; if (!el) return; const domHtml = el.innerHTML; if (domHtml !== html) setHtml(domHtml); }
  function onLayoutChange(v: LayoutMode) { flushEditorDom(); setLayout(v); }
  function onEditorInput() { const el = editorRef.current; if (!el) return; setHtml(el.innerHTML); debouncedAuto.current(); }
  function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    try {
      e.preventDefault(); const cd = e.clipboardData;
      let txt = cd ? cd.getData("text/plain") : "";
      if (!txt) { const html = cd?.getData("text/html") || ""; if (html) { const d = document.createElement("div"); d.innerHTML = html; txt = d.textContent || (d as any).innerText || html; } }
      const safe = sanitizePlainTextToHtml(txt); document.execCommand("insertHTML", false, safe);
    } catch {} onEditorInput();
  }

  function newDoc() {
    if (confirm("清空当前文档并新建？")) { setHtml(""); setSegments([]); try { localStorage.removeItem(LS_DOC); } catch {} }
  }

  async function translateOne(seg: Segment): Promise<Segment> {
    try {
      let out = "";
      if (provider === "dummy") out = await translateDummy(seg.text, sourceLang, targetLang);
      else if (provider === "libre") out = await translateLibre(seg.text, sourceLang === "auto" ? "auto" : sourceLang, targetLang, endpoint, apiKey || undefined);
      else if (provider === "backend") out = await translateBackend(seg.text, sourceLang === "auto" ? "auto" : sourceLang, targetLang);
      return { ...seg, translation: out, status: "fresh", errorMsg: undefined };
    } catch (e: any) { return { ...seg, status: "error", errorMsg: e?.message || String(e) }; }
  }

  async function translateStale() {
    const idxs = segments.map((s, i) => ({ s, i })).filter(({ s }) => !s.locked && (!s.translation || s.status === "stale" || s.status === "error")).map(({ i }) => i);
    if (!idxs.length) return;
    setSegments((prev) => prev.map((s, i) => (idxs.includes(i) ? { ...s, status: "translating" } : s)));
    setBusy(true); setProgressActive(true); setProgress(0);
    let done = 0; const total = idxs.length; const conc = Math.min(3, total); let cursor = 0;
    const work = async () => { while (cursor < total) { const i = idxs[cursor++]; const updated = await translateOne(segments[i]); setSegments((prev) => prev.map((s, j) => (j === i ? updated : s))); done++; setProgress(Math.min(1, done / total)); } };
    await Promise.all(Array.from({ length: conc }).map(() => work()));
    setBusy(false); setProgress(1); setTimeout(() => setProgressActive(false), 400);
  }

  function refreshOne(i: number) { setSegments((prev) => prev.map((s, j) => (j === i ? { ...s, status: "stale" } : s))); translateStale(); }
  function refreshAll() { setSegments((prev) => prev.map((s) => (s.locked ? s : { ...s, status: "stale" }))); translateStale(); }
  function setLock(i: number, locked: boolean) { setSegments((prev) => prev.map((s, j) => (j === i ? { ...s, locked } : s))); }

  function exportMarkdown() {
    const parts: string[] = ["# Bilingual Document", ""];
    segments.forEach((s) => { if (!s.text.trim()) return; parts.push(s.text.trim()); const t = (s.translation || "").trim(); if (t) parts.push("> " + t); parts.push(""); });
    const blob = new Blob([parts.join(NL)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "bilingual.md"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  async function exportDocx() {
    try {
      const docx = await import('docx');
      const { Document, Packer, Paragraph, Table, TableCell, TableRow, WidthType, AlignmentType } = docx as any;
      const rows = segments
        .filter(s => (s.text && s.text.trim()) || (s.translation && s.translation.trim()))
        .map((s: Segment) => new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(s.text || '')], width: { size: 50, type: WidthType.PERCENTAGE } }),
            new TableCell({ children: [new Paragraph(s.translation || '')], width: { size: 50, type: WidthType.PERCENTAGE } }),
          ],
        }));
      const table = new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
      const doc = new Document({ sections: [{ children: [ new Paragraph({ text: 'Bilingual Document', heading: 'Heading1', alignment: AlignmentType.CENTER }), table ] }] });
      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'bilingual.docx'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`DOCX export failed: ${e?.message || String(e)}\n\n可先用 Export MD。`);
    }
  }

  const s = useMemo(() => {
    const total = segments.length; const fresh = segments.filter((s) => s.status === "fresh").length; const stale = segments.filter((s) => s.status === "stale").length; const trans = segments.filter((s) => s.status === "translating").length;
    return { total, fresh, stale, trans };
  }, [segments]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b relative">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-2">
          <div className="text-lg font-semibold mr-2">Bilingual Writer — MVP</div>
          <select className="border rounded px-2 py-1 text-sm" value={layout} onChange={(e) => onLayoutChange(e.target.value as LayoutMode)}>
            <option value="side">右侧译文</option>
            <option value="below">下方译文</option>
          </select>
          <select className="border rounded px-2 py-1 text-sm" value={segMode} onChange={(e)=>setSegMode(e.target.value as SegMode)}>
            <option value="sentence">按句子</option>
            <option value="paragraph">按段落</option>
          </select>
          <select className="border rounded px-2 py-1 text-sm" value={provider} onChange={(e)=>setProvider(e.target.value as Provider)}>
            <option value="dummy">Dummy(演示)</option>
            <option value="libre">LibreTranslate</option>
            <option value="backend">Backend(/api/translate)</option>
          </select>
          {provider === "libre" && (
            <>
              <input className="border rounded px-2 py-1 text-sm w-56" value={endpoint} onChange={(e)=>setEndpoint(e.target.value)} placeholder="Endpoint"/>
              <input className="border rounded px-2 py-1 text-sm w-40" value={apiKey} onChange={(e)=>setApiKey(e.target.value)} placeholder="API Key(可选)"/>
            </>
          )}
          <select className="border rounded px-2 py-1 text-sm" value={sourceLang} onChange={(e)=>setSourceLang(e.target.value)}>
            <option value="auto">Auto</option><option value="zh">Chinese</option><option value="en">English</option><option value="ja">Japanese</option><option value="ko">Korean</option>
          </select>
          <div className="text-slate-400">→</div>
          <select className="border rounded px-2 py-1 text-sm" value={targetLang} onChange={(e)=>setTargetLang(e.target.value)}>
            <option value="en">English</option><option value="zh">Chinese</option><option value="ja">Japanese</option><option value="ko">Korean</option>
          </select>
          <label className="ml-2 text-sm flex items-center gap-1"><input type="checkbox" checked={autoTranslate} onChange={(e)=>setAutoTranslate(e.target.checked)} /> 自动翻译</label>
          <div className="ml-auto flex items-center gap-2">
            <button className="border rounded px-2 py-1 text-sm" onClick={exportMarkdown}>Export MD</button>
            <button className="border rounded px-2 py-1 text-sm" onClick={exportDocx}>Export DOCX</button>
            <button className="border rounded px-2 py-1 text-sm" onClick={refreshAll} disabled={busy}>全部刷新</button>
            <button className="bg-emerald-600 text-white rounded px-3 py-1 text-sm" onClick={translateStale} disabled={busy}>Translate now</button>
            <button className="border rounded px-2 py-1 text-sm" onClick={newDoc}>新文档</button>
          </div>
        </div>
        {progressActive && (<div className="absolute left-0 bottom-0 h-[2px] bg-emerald-500" style={{ width: Math.round(progress*100) + "%" }} />)}
      </header>

      {draftBanner && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-5xl mx-auto px-4 py-2 text-sm flex items-center justify-between">
            <div>检测到上次草稿（{new Date(draftBanner.savedAt).toLocaleString()}）是否恢复？</div>
            <div className="flex gap-2">
              <button className="border rounded px-2 py-1 text-sm" onClick={()=>{ try{localStorage.removeItem(LS_DOC);}catch{}; setDraftBanner(null); }}>丢弃</button>
              <button className="bg-emerald-600 text-white rounded px-3 py-1 text-sm" onClick={()=>{ setHtml(draftBanner.html); setDraftBanner(null); }}>恢复</button>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        {layout === "side" ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-2xl border shadow-sm p-4">
              <div className="text-sm text-slate-500 mb-2">像文档一样编辑（支持粘贴清洗、自动翻译）</div>
              <div ref={editorRef} contentEditable suppressContentEditableWarning className="min-h-[44vh] rounded-xl border p-4 focus:outline-none prose max-w-none"
                   onInput={onEditorInput} onBlur={onEditorInput} onPaste={onPaste} onCompositionEnd={onEditorInput} />
            </div>
            <div className="bg-white rounded-2xl border shadow-sm p-4">
              <div className="text-sm text-slate-500">{s.fresh}/{s.total} ready · {s.stale} stale {s.trans ? `· ${s.trans}…` : ""}</div>
              <div className="mt-3 space-y-3">
                {segments.length === 0 && <div className="text-sm text-slate-400">输入文本后，这里显示对齐译文。</div>}
                {segments.map((seg, i) => (
                  <div key={seg.id} className="rounded-xl border p-3" data-seg={seg.id}>
                    <div className="text-xs text-slate-500 whitespace-pre-wrap">{seg.text}</div>
                    <div className="mt-2 p-2 bg-slate-50 border rounded translation-box whitespace-pre-wrap min-h-[1.5rem]">
                      {seg.translation || (seg.status === "translating" ? "Translating…" : "")}
                      {seg.status === "error" && <div className="text-xs text-red-600">{seg.errorMsg}</div>}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-sm">
                      <button className="border rounded px-2 py-1" onClick={()=>refreshOne(i)} disabled={seg.locked || busy}>刷新</button>
                      <button className="border rounded px-2 py-1" onClick={()=>setLock(i, !seg.locked)}>{seg.locked ? "已锁定" : "未锁定"}</button>
                      <button className="border rounded px-2 py-1" onClick={async()=>{ const ok = await copyText(seg.translation || ""); showToast(ok ? "已复制" : "复制失败", ok ? "success" : "error"); }}>复制译文</button>
                      {seg.status === "stale" && <span className="text-xs text-amber-600">需更新</span>}
                      {seg.status === "fresh" && <span className="text-xs text-emerald-600">最新</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border shadow-sm p-4">
            <div className="text-sm text-slate-500 mb-2">文档视图（原文 + 下方译文）</div>
            <div ref={editorRef} contentEditable suppressContentEditableWarning className="min-h-[24vh] rounded-xl border p-4 focus:outline-none prose max-w-none"
                 onInput={onEditorInput} onBlur={onEditorInput} onPaste={onPaste} onCompositionEnd={onEditorInput} />
            <div className="mt-4 space-y-4">
              {segments.map((seg, i) => (
                <div key={seg.id} className="rounded-xl border p-3" data-seg={seg.id}>
                  <div className="whitespace-pre-wrap leading-7">{seg.text}</div>
                  <div className="mt-2 pl-3 border-l-2 bg-slate-50 rounded whitespace-pre-wrap text-sm translation-box">
                    {seg.translation || (seg.status === "translating" ? "Translating…" : "")}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-sm">
                    <button className="border rounded px-2 py-1" onClick={()=>refreshOne(i)} disabled={seg.locked || busy}>刷新</button>
                    <button className="border rounded px-2 py-1" onClick={()=>setLock(i, !seg.locked)}>{seg.locked ? "已锁定" : "未锁定"}</button>
                    <button className="border rounded px-2 py-1" onClick={async()=>{ const ok = await copyText(seg.translation || ""); showToast(ok ? "已复制" : "复制失败", ok ? "success" : "error"); }}>复制译文</button>
                    {seg.status === "stale" && <span className="text-xs text-amber-600">需更新</span>}
                    {seg.status === "fresh" && <span className="text-xs text-emerald-600">最新</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {toast && (<div className={`fixed bottom-4 right-4 z-50 text-white px-3 py-2 rounded-xl shadow ${toast.type === "success" ? "bg-emerald-600" : "bg-amber-600"}`}>{toast.msg}</div>)}
      <footer className="max-w-5xl mx-auto px-4 pb-8 text-xs text-slate-400">Lightweight MVP · 同域 Backend 可选</footer>
    </div>
  );
}
