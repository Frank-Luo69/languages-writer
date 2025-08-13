// 使用 Node 运行时，方便用 crypto 计算 MD5（百度翻译签名需要）
export const runtime = 'nodejs';

import crypto from 'crypto';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export async function OPTIONS() {
  return new Response(null, { headers: CORS });
}

// 语言代码兼容：Next 前端用 en/zh/ja/ko，百度用 en/zh/jp/kor
function mapLangToBaidu(code: string) {
  if (!code || code === 'auto') return 'auto';
  if (code === 'ja') return 'jp';
  if (code === 'ko') return 'kor';
  return code; // en、zh 直接兼容
}

async function translateWithBaidu(q: string, from: string, to: string) {
  const appid = process.env.BAIDU_APP_ID;
  const secret = process.env.BAIDU_SECRET;
  if (!appid || !secret) throw new Error('BAIDU_APP_ID 或 BAIDU_SECRET 未配置');

  const salt = String(Date.now());
  const signStr = `${appid}${q}${salt}${secret}`;
  const sign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex');

  const params = new URLSearchParams({
    q,
    from: mapLangToBaidu(from),
    to: mapLangToBaidu(to),
    appid,
    salt,
    sign,
  });

  const res = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) throw new Error('Upstream ' + res.status);

  const data = await res.json() as any;
  if (data.error_code) {
    throw new Error(`Baidu error ${data.error_code}: ${data.error_msg || ''}`);
  }
  const items = (data.trans_result || []) as Array<{ src: string; dst: string }>;
  const text = items.map(i => i.dst).join('\n');
  return text || '';
}

// 兜底：如果没配百度，就走 LibreTranslate 公共服务（无需密钥）
async function translateWithLibre(q: string, from: string, to: string) {
  const endpoint = process.env.LIBRE_ENDPOINT || 'https://libretranslate.de/translate';
  const apiKey = process.env.LIBRE_API_KEY;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q, source: from || 'auto', target: to || 'en', format: 'text', api_key: apiKey || undefined }),
  });
  if (!res.ok) throw new Error('Upstream ' + res.status);
  const data = await res.json() as any;
  const text = data?.translatedText ?? (Array.isArray(data) ? data[0]?.translatedText : undefined);
  if (!text) throw new Error('Bad upstream payload');
  return text;
}

export async function POST(req: Request) {
  try {
    const { q, source = 'auto', target = 'en' } = await req.json();
    if (!q || typeof q !== 'string') {
      return new Response('Bad Request: q is required', { status: 400, headers: CORS });
    }

    let text: string;
    if (process.env.BAIDU_APP_ID && process.env.BAIDU_SECRET) {
      text = await translateWithBaidu(q, source, target);
    } else {
      text = await translateWithLibre(q, source, target);
    }

    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { 'content-type': 'application/json', ...CORS },
    });
  } catch (e: any) {
    return new Response('Internal Error: ' + (e?.message || String(e)), {
      status: 500,
      headers: CORS,
    });
  }
}
