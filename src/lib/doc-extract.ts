/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Unstructured Text Extraction Helpers
 *  Turns raw bytes (PDF / image / HTML) into plain text for the
 *  Data Fusion ingestion pipeline (see lib/store/document-store.ts).
 *  Every extractor is best-effort: a missing optional dependency or
 *  a malformed file degrades to an empty/partial string, it never throws.
 * ═══════════════════════════════════════════════════════════════
 */

let _pdfParse: any = null;
async function getPdfParse() {
  if (!_pdfParse) {
    try {
      const mod: any = await import('pdf-parse');
      _pdfParse = mod.default || mod;
    } catch {}
  }
  return _pdfParse;
}

let _Tesseract: any = null;
async function getTesseract() {
  if (!_Tesseract) {
    try { _Tesseract = (await import('tesseract.js')).default || require('tesseract.js'); } catch {}
  }
  return _Tesseract;
}

/** Extract text from a PDF buffer. Text-layer parse first, regex fallback for malformed PDFs. */
export async function extractPdfText(buffer: Buffer): Promise<{ text: string; method: string }> {
  try {
    const pdfParse = await getPdfParse();
    if (pdfParse) {
      const data = await pdfParse(buffer);
      const text = data.text?.trim();
      if (text && text.length > 40) return { text, method: 'pdf-parse' };
    }
  } catch {}

  try {
    const raw = buffer.toString('binary');
    const matches: string[] = [];
    const re = /\(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const t = m[1]
        .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
        .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
        .replace(/\\(.)/g, '$1');
      if (t.length > 2 && !t.startsWith('\\') && !/^[\s\-.0-9]+$/.test(t)) matches.push(t);
    }
    if (matches.length > 0) {
      const text = matches.join('\n').trim();
      if (text.length > 40) return { text, method: 'regex-fallback' };
    }
  } catch {}

  return { text: '', method: 'failed' };
}

/** OCR an image buffer (PNG/JPG/...) via Tesseract.js. */
export async function extractImageText(buffer: Buffer): Promise<{ text: string; method: string }> {
  try {
    const Tesseract = await getTesseract();
    if (!Tesseract) return { text: '', method: 'unavailable' };
    const { data } = await Tesseract.recognize(buffer, 'eng', { logger: () => {} });
    const text = (data?.text || '').trim();
    return { text, method: text ? 'tesseract-ocr' : 'no-text-detected' };
  } catch {
    return { text: '', method: 'failed' };
  }
}

/** Strip an HTML document down to readable text. */
export function extractHtmlText(html: string): string {
  let clean = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  clean = clean.replace(/<style[\s\S]*?<\/style>/gi, '');
  clean = clean.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  clean = clean.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  clean = clean.replace(/<br\s*\/?>/gi, '\n');
  clean = clean.replace(/<\/p>/gi, '\n\n');
  clean = clean.replace(/<\/?[^>]+(>|$)/g, '');
  clean = clean.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  clean = clean.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  return clean;
}

export function extractHtmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : '';
}
