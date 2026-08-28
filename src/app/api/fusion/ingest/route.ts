/**
 * ════════════════════════════════════════════════════════════════
 *  OSIRIS — Data Fusion Ingest
 *  Entry point for unstructured material: a file upload, a pasted
 *  block of text, or a URL. Extracts plain text, then hands it to
 *  the document-store fusion pipeline (chunk + index + NER + link
 *  into the entity graph). See lib/store/document-store.ts.
 * ════════════════════════════════════════════════════════════════
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_TEXT_CHARS = 400_000; // safety cap — see chunkText's own MAX_CHUNKS too

async function getDocStore() {
  return import('@/lib/store/document-store');
}

async function extractFromFile(file: File): Promise<{ text: string; mime: string; kind: string; method: string }> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const name = file.name || 'upload';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const mime = file.type || '';

  if (ext === 'pdf' || mime === 'application/pdf') {
    const { extractPdfText } = await import('@/lib/doc-extract');
    const { text, method } = await extractPdfText(buffer);
    return { text, mime: mime || 'application/pdf', kind: 'file', method };
  }
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) {
    const { extractImageText } = await import('@/lib/doc-extract');
    const { text, method } = await extractImageText(buffer);
    return { text, mime: mime || 'image/png', kind: 'image', method };
  }
  if (['txt', 'md', 'csv', 'log', 'xml', 'yaml', 'yml'].includes(ext) || mime.startsWith('text/')) {
    return { text: buffer.toString('utf-8'), mime: mime || 'text/plain', kind: 'file', method: 'utf8' };
  }
  if (ext === 'json' || mime === 'application/json') {
    try {
      const parsed = JSON.parse(buffer.toString('utf-8'));
      return { text: JSON.stringify(parsed, null, 2), mime: 'application/json', kind: 'file', method: 'json' };
    } catch {
      return { text: buffer.toString('utf-8'), mime: 'application/json', kind: 'file', method: 'json-raw' };
    }
  }
  return { text: '', mime: mime || 'application/octet-stream', kind: 'file', method: 'unsupported' };
}

async function extractFromUrl(url: string): Promise<{ text: string; title: string; mime: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OSIRIS-Fusion/1.0)', 'Accept': 'text/html,application/json,*/*' },
    signal: AbortSignal.timeout(15000),
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json();
    return { text: JSON.stringify(json, null, 2), title: url, mime: 'application/json' };
  }
  const html = await res.text();
  const { extractHtmlText, extractHtmlTitle } = await import('@/lib/doc-extract');
  return { text: extractHtmlText(html), title: extractHtmlTitle(html) || url, mime: 'text/html' };
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || '';
    const ds = await getDocStore();

    let title = '';
    let text = '';
    let mime = '';
    let kind = 'text';
    let uri: string | undefined;
    let method = 'direct';

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file') as File | null;
      const url = form.get('url') as string | null;
      title = (form.get('title') as string) || file?.name || url || '';

      if (file) {
        const ext = await extractFromFile(file);
        text = ext.text; mime = ext.mime; kind = ext.kind; method = ext.method;
      } else if (url) {
        const ext = await extractFromUrl(url);
        text = ext.text; mime = ext.mime; kind = 'url'; uri = url;
        if (!title) title = ext.title;
      } else {
        text = (form.get('text') as string) || '';
        kind = 'text';
      }
    } else {
      const body = await req.json().catch(() => ({}));
      if (body.url) {
        const ext = await extractFromUrl(body.url);
        text = ext.text; mime = ext.mime; kind = 'url'; uri = body.url;
        title = body.title || ext.title;
      } else {
        text = body.text || '';
        title = body.title || '';
        kind = body.kind || 'text';
        mime = body.mime || 'text/plain';
      }
    }

    text = text.slice(0, MAX_TEXT_CHARS);
    if (!text.trim()) {
      return NextResponse.json({ error: 'No extractable text content', method }, { status: 400 });
    }
    if (!title.trim()) title = `Untitled ${kind} — ${new Date().toISOString().slice(0, 19)}`;

    const result = await ds.ingestDocument({ title, text, kind, mime, uri, metadata: { extractionMethod: method } });

    return NextResponse.json({
      success: true,
      ...result,
      textLength: text.length,
      summary: result.deduped
        ? `Already ingested (matches existing source ${result.sourceId}) — ${result.entitiesLinked.length} linked entities`
        : `Ingested "${title}": ${result.chunkCount} chunks indexed, ${result.entitiesLinked.length} entities linked, ${result.relationshipsCreated} relationships created`,
    });
  } catch (e: any) {
    console.error('[FusionIngest] error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET() {
  const ds = await getDocStore();
  const counts = await ds.getSourceCounts();
  return NextResponse.json(counts);
}
