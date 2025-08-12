export const runtime = 'edge'; // 可删

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export async function OPTIONS() { return new Response(null, { headers: CORS }); }

export async function POST(req: Request) {
  try {
    const { q, source = 'auto', target = 'en' } = await req.json();
    if (!q || typeof q !== 'string') {
      return new Response('Bad Request: q is required', { status: 400, headers: CORS });
    }
    const endpoint = process.env.LIBRE_ENDPOINT ?? 'https://libretranslate.de/translate';
    const apiKey = process.env.LIBRE_API_KEY;

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q, source, target, format: 'text', api_key: apiKey || undefined }),
    });
    if (!r.ok) return new Response('Upstream ' + r.status, { status: 502, headers: CORS });

    const data = await r.json();
    const text = data?.translatedText ?? (Array.isArray(data) ? data[0]?.translatedText : undefined);
    if (!text) return new Response('Bad upstream payload', { status: 502, headers: CORS });

    return new Response(JSON.stringify({ text }), { status: 200, headers: { 'content-type': 'application/json', ...CORS } });
  } catch (e: any) {
    return new Response('Internal Error: ' + (e?.message || String(e)), { status: 500, headers: CORS });
  }
}
