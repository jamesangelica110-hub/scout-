const UA = "SignalScout/2.3 (contact: tomsantomiwa@gmail.com)";
const H = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: H });

// Races several async factories; resolves with the first truthy success,
// rejects only once every factory has failed or the overall timeout hits.
function firstSuccess(factories, timeoutMs) {
  return new Promise((resolve, reject) => {
    let pending = factories.length, settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("timeout")); } }, timeoutMs);
    for (const factory of factories) {
      factory().then(v => {
        if (settled) return;
        if (v) { settled = true; clearTimeout(timer); resolve(v); }
        else if (--pending === 0 && !settled) { settled = true; clearTimeout(timer); reject(new Error("no result")); }
      }).catch(() => {
        if (settled) return;
        if (--pending === 0 && !settled) { settled = true; clearTimeout(timer); reject(new Error("all failed")); }
      });
    }
  });
}

async function getJson(url, opts = {}, ms = 6000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// All three geocoders race in parallel; whichever answers first wins.
async function geocode(city, country, timeoutMs) {
  const q = `${city}, ${country}`;
  return firstSuccess([
    async () => { const d = await getJson("https://nominatim.openstreetmap.org/search?" + new URLSearchParams({ q, format: "jsonv2", limit: 1 }), { headers: { "User-Agent": UA } }, timeoutMs); return d?.[0] && { lat: +d[0].lat, lon: +d[0].lon }; },
    async () => { const d = await getJson("https://photon.komoot.io/api/?" + new URLSearchParams({ q, limit: 1 }), { headers: { "User-Agent": UA } }, timeoutMs); const f = d?.features?.[0]; return f && { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }; },
    async () => { const d = await getJson("https://geocode.maps.co/search?" + new URLSearchParams({ q }), {}, timeoutMs); return d?.[0] && { lat: +d[0].lat, lon: +d[0].lon }; },
  ], timeoutMs + 1500).catch(() => null);
}

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

async function overpassAtRadius(lat, lon, pattern, radius, timeoutMs) {
  const query = `[out:json][timeout:${Math.max(5, Math.round(timeoutMs / 1000) - 2)}];nwr(around:${radius},${lat.toFixed(6)},${lon.toFixed(6)})[~"^(website|contact:website)$"~"."][~"^(name|brand|craft|shop|office|amenity|healthcare|industrial|tourism|operator)$"~"${pattern}",i];out center tags 200;`;
  const body = new URLSearchParams({ data: query }).toString();
  return firstSuccess(
    ENDPOINTS.map(endpoint => async () => {
      const r = await fetch(endpoint, { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }),
    timeoutMs + 1500
  ).catch(() => null);
}

// Escalates radius only while there's time left in the overall budget.
async function findLeads(lat, lon, pattern, limit, deadline) {
  const radii = [15000, 40000];
  const seen = new Set();
  const leads = [];
  for (const radius of radii) {
    const left = deadline - Date.now();
    if (left < 5000) break; // not enough time left for a meaningful attempt
    const payload = await overpassAtRadius(lat, lon, pattern, radius, Math.min(left - 2000, 14000));
    if (payload) {
      for (const el of payload.elements || []) {
        const t = el.tags || {};
        const name = t.name || t.brand || t.operator;
        let site = t.website || t["contact:website"];
        if (!name || !site) continue;
        if (!/^https?:\/\//i.test(site)) site = "https://" + site;
        let host;
        try { host = new URL(site).hostname.toLowerCase(); } catch { continue; }
        if (seen.has(host)) continue;
        seen.add(host);
        const detail = ["craft", "shop", "office", "amenity", "healthcare", "industrial", "tourism", "description"]
          .filter(k => t[k]).map(k => `${k}: ${t[k]}`).join(", ");
        leads.push({
          name, link: site,
          snippet: detail || "Mapped business with a public website",
          source: "OpenStreetMap (ODbL)",
          sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        });
        if (leads.length >= limit) return leads;
      }
    }
    if (leads.length >= limit) break;
  }
  return leads;
}

const MAILBOXES = new Set(["info","hello","contact","office","sales","support","service","services","booking","bookings","enquiries","inquiries","admin","team","quote","quotes"]);
const SOCIAL = { "instagram.com": "Instagram", "facebook.com": "Facebook", "linkedin.com": "LinkedIn", "youtube.com": "YouTube", "tiktok.com": "TikTok", "x.com": "X", "twitter.com": "X" };

async function audit(url, timeoutMs) {
  const res = { url, score: 0, signals: [], checked: false, emails: [], whatsapp: [], socials: {} };
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const html = (await r.text()).slice(0, 300000);
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || "";
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1]?.trim() || "";
    const h1 = (html.match(/<h1[\s>]/gi) || []).length, h2 = (html.match(/<h2[\s>]/gi) || []).length;
    const checks = [
      [!!title, 15, "Page title present"], [!!desc, 15, "Meta description present"],
      [h1 > 0, 10, "H1 heading present"], [h1 === 1, 5, "Single H1 heading"],
      [html.includes("application/ld+json"), 20, "JSON-LD structured data detected"],
      [/LocalBusiness|Organization|ProfessionalService/.test(html), 10, "Business schema type detected"],
      [/rel=["']canonical["']/i.test(html), 5, "Canonical link appears present"],
      [h2 > 0, 5, "Useful section headings present"],
      [html.replace(/<[^>]+>/g, " ").length > 500, 5, "Substantive page text detected"],
    ];
    for (const [ok, pts, label] of checks) { if (ok) res.score += pts; res.signals.push({ ok, label }); }
    const emails = new Set();
    for (const m of html.matchAll(/\b([a-z0-9._%+\-]+)@([a-z0-9.\-]+\.[a-z]{2,})\b/gi)) if (MAILBOXES.has(m[1].toLowerCase().split("+")[0])) emails.add(m[0].toLowerCase());
    for (const [host, name] of Object.entries(SOCIAL)) {
      const m = html.match(new RegExp(`https?://(?:www\\.)?${host.replace(".", "\\.")}/[^"'\\s<>]+`, "i"));
      if (m) res.socials[name] = m[0];
    }
    res.whatsapp = [...new Set([...html.matchAll(/https?:\/\/wa\.me\/([0-9]{8,})/gi)].map(m => "https://wa.me/" + m[1]))];
    Object.assign(res, { checked: true, title, description: desc.slice(0, 300), emails: [...emails] });
  } catch (e) { res.error = String(e.message || "Audit failed").slice(0, 180); }
  return res;
}

// All audits run in parallel — wall time is one audit's timeout, not N times it.
async function runAudits(leads, deadline) {
  const left = deadline - Date.now();
  const perAuditTimeout = Math.max(3000, Math.min(7000, left - 1500));
  return Promise.all(leads.map(l => audit(l.link, perAuditTimeout).then(a => ({ ...l, audit: a }))));
}

async function handleSearch(request, deadline) {
  let d; try { d = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  const niche = String(d.niche || "").trim().slice(0, 120), city = String(d.city || "").trim().slice(0, 100), country = String(d.country || "").trim().slice(0, 100);
  const limit = Math.max(1, Math.min(parseInt(d.limit) || 15, 25));
  if (!niche || !city || !country) return json({ error: "Enter a niche, country, and city." }, 400);

  let lat, lon;
  const raw = String(d.coords || d.coordinates || "").trim();
  if (raw) {
    const p = raw.split(",").map(s => parseFloat(s.trim()));
    if (p.length < 2 || isNaN(p[0]) || isNaN(p[1])) return json({ error: "Invalid coordinates. Use: 25.7617, -80.1918" }, 400);
    [lat, lon] = p;
  } else {
    const g = await geocode(city, country, 6000);
    if (!g) return json({ error: `Could not find "${city}". Add the state, or enter coordinates manually (Miami: 25.7617, -80.1918).` }, 422);
    ({ lat, lon } = g);
  }

  const stop = new Set(["business","businesses","service","services","near","best","local"]);
  const words = [...new Set((niche.match(/[\w-]+/g) || []).filter(w => w.length >= 3 && !stop.has(w.toLowerCase())))];
  if (!words.length) return json({ error: "Add a more specific niche, such as 'roofers'." }, 400);
  const pattern = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|").slice(0, 300);

  const raws = await findLeads(lat, lon, pattern, limit, deadline);
  if (!raws.length) {
    return json({ error: "No mapped businesses with a public website were found nearby, even after widening the search. Try a broader niche term (e.g. 'plumbing' instead of 'emergency plumber'), a nearby larger city, or fewer leads." }, 200);
  }

  const leads = await runAudits(raws, deadline);
  return json({
    query: `${niche} ${city} ${country}`,
    leads,
    returned: leads.length,
    note: "Businesses mapped in OpenStreetMap with matching niche tags and a website. Search radius widens automatically (15km \u2192 40km) until enough results are found or time runs out. Coverage varies by area.",
  });
}

async function handleAudit(request, deadline) {
  let d; try { d = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  if (!Array.isArray(d.leads) || d.leads.length > 25) return json({ error: "Send up to 25 businesses per batch." }, 400);
  const cleaned = d.leads.filter(i => i && i.name && i.link && /^https?:\/\//i.test(String(i.link)))
    .map(i => ({ name: String(i.name).slice(0, 180), link: String(i.link).slice(0, 1000), source: String(i.source || "User supplied list").slice(0, 80) }));
  const leads = await runAudits(cleaned, deadline);
  return json({ leads, returned: leads.length, note: "Public website checks completed." });
}

// Guarantees a real HTTP response within budgetMs, no matter what happens
// inside `work` — this is what stops Cloudflare from ever returning an
// empty/truncated body to the browser.
function withDeadline(work, budgetMs, fallback) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, budgetMs);
    work.then(v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } })
        .catch(e => { if (!done) { done = true; clearTimeout(timer); resolve(json({ error: String(e.message || e).slice(0, 300) }, 500)); } });
  });
}

const BUDGET_MS = 25000;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const deadline = Date.now() + BUDGET_MS - 1500; // leave 1.5s headroom to always finish and serialize a reply
    if (pathname === "/api/status") return json({ configured: true, version: "2.3", provider: "OpenStreetMap and Overpass API" });
    if (pathname === "/api/search" && request.method === "POST") {
      return withDeadline(handleSearch(request, deadline), BUDGET_MS, json({ error: "The search took too long and was stopped before finishing. Try fewer leads, a broader niche, or a bigger nearby city." }, 504));
    }
    if (pathname === "/api/audit" && request.method === "POST") {
      return withDeadline(handleAudit(request, deadline), BUDGET_MS, json({ error: "The website check took too long and was stopped. Try a smaller batch." }, 504));
    }
    if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
