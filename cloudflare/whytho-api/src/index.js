/* whytho-api
 *
 * A clean front door for the WhyTho edge functions, so the public API reads as
 * https://whytho-api.jakelabate.com/notes rather than a Supabase project ref and
 * a /functions/v1/ prefix nobody should have to type.
 *
 * It also does the thing the functions cannot do for themselves: rate limiting at
 * the edge, before a request costs an invocation.
 *
 * Routing is by prefix. Anything to do with the connector or its OAuth flow belongs
 * to why-mcp, everything else is the public read and write API.
 */

const SUPABASE = 'https://vvekkbboqqkxnlpmxazh.supabase.co/functions/v1';
const MCP_PREFIXES = ['/mcp', '/token', '/register', '/revoke', '/issue-code', '/.well-known'];

function isMcp(pathname) {
  return MCP_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));
}

// Rate limit per key when there is one, per IP when there is not. Keys are hashed
// so nothing sensitive is used as a counter key.
async function limiterKey(request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { key: 'ip:' + (request.headers.get('CF-Connecting-IP') || '0.0.0.0'), anon: true };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { key: 'k:' + hex.slice(0, 32), anon: false };
}

function tooMany(retryAfter) {
  return new Response(JSON.stringify({
    error: 'Too many requests. Slow down, cache what you poll, and page in blocks rather than looping single requests.'
  }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Preflight never reaches the origin, and never counts against a limit.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    if (url.pathname === '/' || url.pathname === '') {
      return Response.redirect('https://whytho.jakelabate.com/docs.html', 302);
    }

    const { key, anon } = await limiterKey(request);
    const limiter = anon ? env.ANON_LIMITER : env.API_LIMITER;
    const { success } = await limiter.limit({ key });
    if (!success) return tooMany(60);

    const target = SUPABASE + (isMcp(url.pathname) ? '/why-mcp' : '/why-api') + url.pathname + url.search;
    const upstream = await fetch(new Request(target, request));

    // Pass the response through untouched apart from saying where it came from,
    // which makes a misrouted request obvious in the browser network tab.
    const out = new Response(upstream.body, upstream);
    out.headers.set('X-WhyTho-Upstream', isMcp(url.pathname) ? 'why-mcp' : 'why-api');
    return out;
  }
};
