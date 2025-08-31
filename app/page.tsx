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

type Provider = "dummy" | "libre" | "backend";
type SegMode = "sentence" | "paragraph" | "whole";

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
  const root = document.createElement("div");
  root.innerHTML = html;

  const BLOCK_SELECTOR = "p,li,h1,h2,h3,h4,h5,h6,blockquote,pre";

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

  // 优先使用明确的段落级元素
  let blocks = Array.from(root.querySelectorAll(BLOCK_SELECTOR));
  // 只保留“叶子”块，避免 div/li 内部还有 p 被重复计入
  const leafBlocks = blocks.filter((el) => !(el as HTMLElement).querySelector(BLOCK_SELECTOR));
  blocks = leafBlocks.length ? leafBlocks : blocks;

  let paras: string[] = [];
  if (blocks.length > 0) {
    paras = blocks.map((el) => toText(el as HTMLElement)).filter((t) => !!t);
  } else {
    // 无明确块元素时，尝试用顶层子元素划分
    const children = Array.from(root.children) as HTMLElement[];
    if (children.length > 0) {
      paras = children.map((el) => toText(el)).filter(Boolean);
    } else {
      // 纯文本兜底：按空行拆段，最后按单行换行尽量拆
      const text = (root.textContent || "").replace(/\r\n?/g, "\n").trim();
      if (text) {
        paras = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
        if (paras.length <= 1 && text.includes("\n")) {
          const tmp = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
          if (tmp.length > 1) paras = tmp;
        }
      }
    }
  }

  // 单段内仍存在多行换行时，尝试进一步按空行拆分
  if (paras.length <= 1 && paras[0]?.includes("\n")) {
    const p0 = paras[0];
    const firstPass = p0.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    if (firstPass.length > 1) return firstPass;
    const secondPass = p0.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (secondPass.length > 1) return secondPass;
  }

  return paras;
}
// 句子切分
function splitIntoSentences(text: string): string[] {
  const t = text || "";
  const out: string[] = [];
  const isDigit = (c: string) => /[0-9]/.test(c);
  const closers = new Set(['"', "'", '”', '’', '」', '』', '）', ')', ']', '】', '＞', '>']);
  const n = t.length;
  let i = 0;
  let buf = "";
  while (i < n) {
    const ch = t[i];
    const next = t[i + 1] || '';
    const prev = t[i - 1] || '';

    if (ch === '\n') {
      if (buf.trim()) out.push(buf.trim());
      buf = ""; i++; continue;
    }

    buf += ch;

    // 句末判断
    if (ch === '.') {
      // 小数/版本号等，不作为句末：digit . digit
      if (isDigit(prev) && isDigit(next)) { i++; continue; }
      // 省略号 ... 保持到最后一个点
      if (next === '.') { i++; continue; }
      // 吸收紧随其后的右引号/括号等
      let j = i + 1;
      while (j < n && closers.has(t[j])) { buf += t[j]; j++; }
      i = j;
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    if (ch === '!' || ch === '?') {
      // 连续 ?! 或 !! 作为同一结尾
      if (next === '!' || next === '?') { i++; continue; }
      let j = i + 1;
      while (j < n && closers.has(t[j])) { buf += t[j]; j++; }
      i = j;
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    if (ch === '。' || ch === '！' || ch === '？') {
      let j = i + 1;
      while (j < n && closers.has(t[j])) { buf += t[j]; j++; }
      i = j;
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }

    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
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

  // 智能下载（不使用文件保存选择器）：a[download] 或 window.open 兜底
  function downloadBlobSmart(filename: string, blob: Blob): boolean {
    const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
    const url = URL.createObjectURL(blob);
    try {
      if (inIframe) {
        const win = window.open(url, '_blank');
        if (!win) throw new Error('popup blocked');
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 5000);
        return true;
      } else {
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url); } catch {} }, 0);
        return true;
      }
    } catch (e) {
      console.warn('download fallback failed:', e);
      try {
        window.open(url, '_blank');
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 5000);
        return true;
      } catch {}
    }
    return false;
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

// 纯文本 -> 段落数组（按空行优先，其次按单行换行兜底）
function splitPlainIntoParagraphs(text: string): string[] {
  const t = (text || "").replace(/\r\n?/g, "\n").trim();
  if (!t) return [];
  let paras = t.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (paras.length <= 1 && t.includes("\n")) {
    const tmp = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (tmp.length > 1) paras = tmp;
  }
  return paras;
}

export default function Page() {
  const [segMode, setSegMode] = useState<SegMode>("sentence");
  const [provider, setProvider] = useState<Provider>("dummy");
  const [endpoint, setEndpoint] = useState("https://libretranslate.de/translate");
  const [apiKey, setApiKey] = useState("");
  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("en");
  const [autoTranslate, setAutoTranslate] = useState(true);

  const [html, setHtml] = useState("<p>在此像写文档一样输入；旁侧自动生成译文。</p>");
  const editorRef = useRef<HTMLDivElement | null>(null);

  const [segments, setSegments] = useState<Segment[]>([]);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressActive, setProgressActive] = useState(false);
  const [draftBanner, setDraftBanner] = useState<{ html: string; savedAt: number } | null>(null);

  // 将 state 写回编辑器：避免每次键入都重设，只有当编辑器不在焦点时才同步，防止光标跳动
  useEffect(() => {
    const el = editorRef.current; if (!el) return;
    if (document.activeElement === el) return;
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [html]);
  useEffect(() => { try { const raw = localStorage.getItem(LS_DOC); if (raw) { const obj = JSON.parse(raw); if (obj?.html && obj.html !== html) setDraftBanner({ html: obj.html, savedAt: obj.savedAt || Date.now() }); } } catch {} }, []);
  const debouncedSave = useRef(debounce((h: string) => { try { localStorage.setItem(LS_DOC, JSON.stringify({ html: h, savedAt: Date.now() })); } catch {} }, 1000));
  useEffect(() => { debouncedSave.current(html); }, [html]);
  useEffect(() => { const h = () => { try { localStorage.setItem(LS_DOC, JSON.stringify({ html, savedAt: Date.now() })); } catch {} }; window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h); }, [html]);

  useEffect(() => {
    let newSegTexts: string[] = [];
    if (segMode === "sentence") {
      const plain = htmlToPlainText(html); newSegTexts = splitIntoSentences(plain);
    } else if (segMode === "paragraph") {
      newSegTexts = extractParagraphsFromHTML(html);
    } else {
      const plain = htmlToPlainText(html).trim();
      newSegTexts = plain ? [plain] : [];
    }
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
  // 单一布局，无需切换
  function onEditorInput() { const el = editorRef.current; if (!el) return; setHtml(el.innerHTML); debouncedAuto.current(); }
  function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    try {
      e.preventDefault();
      const cd = e.clipboardData;
      const htmlClip = cd?.getData("text/html");
      if (htmlClip && htmlClip.trim()) {
        // 优先使用 HTML，提取并归一化为 <p> 段落，保留 <br>
        const paras = extractParagraphsFromHTML(htmlClip);
        const safeHtml = paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
        document.execCommand("insertHTML", false, safeHtml);
      } else {
        // 退化为纯文本处理
        const txt = cd ? cd.getData("text/plain") : "";
        const safe = sanitizePlainTextToHtml(txt);
        document.execCommand("insertHTML", false, safe);
      }
    } catch {}
    onEditorInput();
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

  async function exportMarkdown() {
    if (downloading) return;
    setDownloading(true);
    try {
      const parts: string[] = ["# Bilingual Document", ""];
      if (segMode === 'whole') {
        // 用 HTML 精准抽取原文段落，译文用空行拆段对齐（尽力保持结构）
        const srcParas = extractParagraphsFromHTML(html);
        const tgtAll = (segments[0]?.translation || "").trim();
        const tgtParas = splitPlainIntoParagraphs(tgtAll);
        const n = Math.max(srcParas.length, tgtParas.length);
        for (let i = 0; i < n; i++) {
          const sp = (srcParas[i] || '').trim();
          const tp = (tgtParas[i] || '').trim();
          if (sp) parts.push(sp);
          if (tp) {
            // 保留段内换行的引用格式
            const q = tp.split(/\n/).map((l) => "> " + l).join("\n");
            parts.push(q);
          }
          parts.push("");
        }
      } else {
        segments.forEach((s) => {
          if (!s.text.trim()) return;
          parts.push(s.text.trim());
          const t = (s.translation || "").trim();
          if (t) {
            const q = t.split(/\n/).map((l) => "> " + l).join("\n");
            parts.push(q);
          }
          parts.push("");
        });
      }
      const blob = new Blob([parts.join(NL)], { type: "text/markdown;charset=utf-8" });
  const ok = downloadBlobSmart("bilingual.md", blob);
      if (!ok) showToast("下载被阻止，建议在浏览器中打开或放宽限制", "error");
    } finally {
      setDownloading(false);
    }
  }
  async function exportDocx() {
    if (downloading) return;
    setDownloading(true);
    try {
      const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, Table, TableCell, TableRow, WidthType, AlignmentType, BorderStyle } = docx as any;

      const makeParas = (text: string) => {
        // 段落级：按空行拆；段内：单行换行转为换行符
        const paras: any[] = [];
        const blocks = splitPlainIntoParagraphs(text);
        if (!blocks.length) return [new Paragraph("")];
        for (const b of blocks) {
          const lines = b.split(/\n/);
          const runs: any[] = [];
          lines.forEach((line, idx) => {
            runs.push(new TextRun({ text: line || '' }));
            if (idx < lines.length - 1) runs.push(new TextRun({ text: "", break: 1 }));
          });
          paras.push(new Paragraph({ children: runs.length ? runs : [new TextRun("")] }));
        }
        return paras;
      };

      let children: any[] = [ new Paragraph({ text: 'Bilingual Document', heading: 'Heading1', alignment: AlignmentType.CENTER }) ];
      if (segMode === 'whole' && segments.length) {
        // 整体模式：单行双列表格，外框 + 中间竖线，无横线
        const srcParas = extractParagraphsFromHTML(html);
        const tgtParas = splitPlainIntoParagraphs(segments[0].translation || "");
        let leftChildren: any[] = [];
        let rightChildren: any[] = [];
        srcParas.forEach((p, i) => { if (i>0) leftChildren.push(new Paragraph("")); leftChildren.push(...makeParas(p)); });
        tgtParas.forEach((p, i) => { if (i>0) rightChildren.push(new Paragraph("")); rightChildren.push(...makeParas(p)); });
        if (!leftChildren.length) leftChildren = [new Paragraph("")];
        if (!rightChildren.length) rightChildren = [new Paragraph("")];
        const table = new Table({
          rows: [ new TableRow({
            children: [
              new TableCell({ children: leftChildren, width: { size: 50, type: WidthType.PERCENTAGE } }),
              new TableCell({ children: rightChildren, width: { size: 50, type: WidthType.PERCENTAGE } }),
            ],
          }) ],
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
            bottom: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
            left: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
            right: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
            insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
            insideVertical: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
          },
        });
        children.push(table);
      } else {
        // 非整体模式仍用表格对齐
        const rows = segments
          .filter(s => (s.text && s.text.trim()) || (s.translation && s.translation.trim()))
          .map((s: Segment) => new TableRow({
            children: [
              new TableCell({ children: makeParas(s.text || ''), width: { size: 50, type: WidthType.PERCENTAGE } }),
              new TableCell({ children: makeParas(s.translation || ''), width: { size: 50, type: WidthType.PERCENTAGE } }),
            ],
          }));
        const table = new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
        children.push(table);
      }
      const doc = new Document({ sections: [{ children }] });
      const blob = await Packer.toBlob(doc);
  const ok = downloadBlobSmart('bilingual.docx', blob);
      if (!ok) showToast('下载被阻止，建议在浏览器中打开或放宽限制', 'error');
    } catch (e: any) {
      showToast(`DOCX 导出失败：${e?.message || String(e)}`, 'error');
    } finally {
      setDownloading(false);
    }
  }

  const s = useMemo(() => {
    const total = segments.length; const fresh = segments.filter((s) => s.status === "fresh").length; const stale = segments.filter((s) => s.status === "stale").length; const trans = segments.filter((s) => s.status === "translating").length;
    return { total, fresh, stale, trans };
  }, [segments]);

  return (
    <div>
      <header className="bw-header">
        <div className="bw-container bw-toolbar">
          <div className="bw-title">Bilingual Writer</div>
          <select className="bw-select" value={segMode} onChange={(e)=>setSegMode(e.target.value as SegMode)}>
            <option value="sentence">按句子</option>
            <option value="paragraph">按段落</option>
            <option value="whole">整体</option>
          </select>
          <select className="bw-select" value={provider} onChange={(e)=>setProvider(e.target.value as Provider)}>
            <option value="dummy">Dummy(演示)</option>
            <option value="libre">LibreTranslate</option>
            <option value="backend">Backend(/api/translate)</option>
          </select>
          {provider === "libre" && (
            <>
              <input className="bw-input" value={endpoint} onChange={(e)=>setEndpoint(e.target.value)} placeholder="Endpoint"/>
              <input className="bw-input" value={apiKey} onChange={(e)=>setApiKey(e.target.value)} placeholder="API Key(可选)"/>
            </>
          )}
          <select className="bw-select" value={sourceLang} onChange={(e)=>setSourceLang(e.target.value)}>
            <option value="auto">Auto</option><option value="zh">Chinese</option><option value="en">English</option><option value="ja">Japanese</option><option value="ko">Korean</option>
          </select>
          <div className="bw-meta">→</div>
          <select className="bw-select" value={targetLang} onChange={(e)=>setTargetLang(e.target.value)}>
            <option value="en">English</option><option value="zh">Chinese</option><option value="ja">Japanese</option><option value="ko">Korean</option>
          </select>
          <label className="bw-meta" style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}><input type="checkbox" checked={autoTranslate} onChange={(e)=>setAutoTranslate(e.target.checked)} /> 自动翻译</label>
          <div className="bw-grow">
            <button className="bw-btn" onClick={exportMarkdown} disabled={downloading}>导出 MD</button>
            <button className="bw-btn" onClick={exportDocx} disabled={downloading}>导出 DOCX</button>
            <button className="bw-btn" onClick={refreshAll} disabled={busy}>全部刷新</button>
            <button className="bw-btn bw-btn-primary" onClick={translateStale} disabled={busy}>立即翻译</button>
            <button className="bw-btn" onClick={newDoc}>新文档</button>
          </div>
        </div>
        {progressActive && (<div className="bw-progress" style={{ width: Math.round(progress*100) + "%" }} />)}
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

      <main className="bw-container bw-main">
        <div className="bw-grid">
          <div className="bw-card">
            <div className="bw-meta" style={{ marginBottom: 8 }}>像文档一样编辑（支持粘贴清洗、自动翻译）</div>
            <div ref={editorRef} contentEditable suppressContentEditableWarning className="bw-editor"
                 onInput={onEditorInput} onBlur={onEditorInput} onPaste={onPaste} onCompositionEnd={onEditorInput} />
          </div>
          <div className="bw-card">
            <div className="bw-meta">就绪 {s.fresh}/{s.total} · 待更新 {s.stale}{s.trans ? ` · 进行中 ${s.trans}…` : ""}</div>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {segments.length === 0 && <div className="bw-meta">输入文本后，这里显示对齐译文。</div>}
              {segments.map((seg, i) => (
                <div key={seg.id} className="bw-card" style={{ padding: 12 }} data-seg={seg.id}>
                  {segMode !== 'whole' && (
                    <div className="bw-meta" style={{ whiteSpace: 'pre-wrap' }}>{seg.text}</div>
                  )}
                  <div className="bw-translation-box" style={{ marginTop: segMode !== 'whole' ? 8 : 0 }}>
                    {seg.translation || (seg.status === "translating" ? "Translating…" : "")}
                    {seg.status === "error" && <div className="bw-badge-err">{seg.errorMsg}</div>}
                  </div>
                  <div className="bw-actions">
                    <button className="bw-btn" onClick={()=>refreshOne(i)} disabled={seg.locked || busy}>刷新</button>
                    <button className="bw-btn" onClick={()=>setLock(i, !seg.locked)}>{seg.locked ? "已锁定" : "未锁定"}</button>
                    <button className="bw-btn" onClick={async()=>{ const ok = await copyText(seg.translation || ""); showToast(ok ? "已复制" : "复制失败", ok ? "success" : "error"); }}>复制译文</button>
                    {seg.status === "stale" && <span className="bw-badge-warn">需更新</span>}
                    {seg.status === "fresh" && <span className="bw-badge-ok">最新</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

  {toast && (<div className={`bw-toast ${toast.type === "success" ? "ok" : "warn"}`}>{toast.msg}</div>)}
  <footer className="bw-container bw-footer">Lightweight MVP · 同域 Backend 可选</footer>
    </div>
  );
}
