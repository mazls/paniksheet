/*
 * Raid-Helper CORS Proxy – Cloudflare Worker
 * ------------------------------------------------------------------
 * Warum?  Die Raid-Helper Events-Liste (GET /api/v4/servers/{id}/events)
 * benötigt einen Authorization-Header. Dieser löst im Browser einen
 * CORS-Preflight aus, den Raid-Helper nur für die Origin raid-helper.xyz
 * erlaubt – Anfragen von z.B. github.io werden geblockt. Dieser Worker
 * reicht die Anfrage serverseitig weiter (inkl. Authorization) und
 * antwortet mit offenem CORS (*).
 *
 * Deploy (kostenlos, ~5 Min):
 *  1. https://dash.cloudflare.com  ->  Workers & Pages  ->  Create  ->  Worker
 *  2. Diesen Code komplett einfügen ("Quick edit") und "Deploy" klicken.
 *  3. Die Worker-URL kopieren (z.B. https://raidhelper-proxy.DEINNAME.workers.dev/)
 *  4. Im Tool unter "Raidhelper API Konfiguration" als "Proxy URL" eintragen
 *     und speichern.
 *
 * Sicherheit: Der Worker leitet ausschließlich an https://raid-helper.xyz/
 * weiter, ist also kein offener Proxy. Der API-Key wird nur durchgereicht,
 * nicht gespeichert.
 */
export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: cors });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target || !target.startsWith('https://raid-helper.xyz/')) {
      return new Response(
        JSON.stringify({ error: 'Only https://raid-helper.xyz/ targets are allowed' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    const upstream = await fetch(target, {
      method: 'GET',
      headers: {
        'Authorization': request.headers.get('Authorization') || '',
        'Accept': 'application/json',
      },
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      },
    });
  },
};
