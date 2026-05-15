/**
 * Homey Cloud Dashboard
 * Node.js-server som autentiserer mot Homey Cloud via OAuth2 og serverer dashboard.
 * Krever Node.js 18+ (for innebygd fetch).
 *
 * Start: node server.js
 * Konfig: kopier .env.example til .env og fyll inn verdier
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---- Konfig: les .env manuelt (ingen dotenv-avhengighet) ----
try {
  const env = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  env.split("\n").forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch (e) {
  console.warn("⚠️  Ingen .env-fil funnet i", __dirname);
}

const CLIENT_ID = process.env.HOMEY_CLIENT_ID;
const CLIENT_SECRET = process.env.HOMEY_CLIENT_SECRET;
const PORT = parseInt(process.env.PORT || "3000", 10);
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const TOKEN_FILE = path.join(__dirname, ".homey-tokens.json");

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${PORT}/spotify/auth/callback`;
const SPOTIFY_TOKEN_FILE = path.join(__dirname, ".spotify-tokens.json");

const ZAPTEC_USERNAME = process.env.ZAPTEC_USERNAME;
const ZAPTEC_PASSWORD = process.env.ZAPTEC_PASSWORD;
const ZAPTEC_CHARGER_ID = process.env.ZAPTEC_CHARGER_ID;

const AUDI_USERNAME = process.env.AUDI_USERNAME;
const AUDI_PASSWORD = process.env.AUDI_PASSWORD;
const AUDI_VIN      = process.env.AUDI_VIN;
const AUDI_COUNTRY  = (process.env.AUDI_COUNTRY || "NO").toUpperCase();
const AUDI_LANG     = "nb";

// ---- Ring API (lazy-init) ----
let _ringApi = null;
async function getRingApi() {
  if (_ringApi) return _ringApi;
  const token = process.env.RING_REFRESH_TOKEN;
  if (!token) throw new Error("RING_REFRESH_TOKEN ikke satt i .env");
  const { RingApi } = await import("ring-client-api");
  _ringApi = new RingApi({ refreshToken: token, controlCenterDisplayName: "Homey Dashboard" });
  _ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    process.env.RING_REFRESH_TOKEN = newRefreshToken;
    try {
      const envPath = path.join(__dirname, ".env");
      const current = fs.readFileSync(envPath, "utf8");
      const updated = current.replace(/^RING_REFRESH_TOKEN=.*/m, `RING_REFRESH_TOKEN=${newRefreshToken}`);
      fs.writeFileSync(envPath, updated.includes("RING_REFRESH_TOKEN") ? updated : current + `\nRING_REFRESH_TOKEN=${newRefreshToken}`);
    } catch {}
  });
  return _ringApi;
}
async function getRingCameras() {
  const api = await getRingApi();
  return api.getCameras();
}

// ---- iCalendar (.ics) parser ----
function parseICS(text) {
  const events = [];
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const blocks = unfolded.split("BEGIN:VEVENT");
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const get = (key) => {
      const m = block.match(new RegExp(`^${key}(?:;[^:]*)?:(.+)$`, "m"));
      return m ? m[1].trim().replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";") : null;
    };
    const summary = get("SUMMARY");
    if (!summary) continue;
    events.push({
      summary,
      dtstart: get("DTSTART"),
      dtend:   get("DTEND"),
      location: get("LOCATION"),
      allDay: /^DTSTART;VALUE=DATE:/m.test(block),
    });
  }
  return events;
}

function parseDTDate(str, allDay) {
  if (!str) return null;
  if (allDay || /^\d{8}$/.test(str)) {
    return { date: str.slice(0, 8), allDay: true, ts: null };
  }
  const m = str.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const ts = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${z || ""}`).getTime();
  let date = `${y}${mo}${d}`;
  if (z) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(ts));
      date = parts.find(p => p.type === "year").value +
             parts.find(p => p.type === "month").value +
             parts.find(p => p.type === "day").value;
    } catch {}
  }
  return { date, allDay: false, ts };
}

function todayKey() {
  const n = new Date();
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, "0")}${String(n.getDate()).padStart(2, "0")}`;
}

const calCache = new Map(); // url → { data, expires }

// ---- Audi Connect ----
const AUDI_CLIENT_ID  = "f4d0934f-32bf-4ce4-b3c4-699a7049ad26@apps_vw-dilab_com";
const AUDI_IDK_BASE   = "https://identity.vwgroup.io";
const AUDI_TOKEN_EP   = "https://emea.bff.cariad.digital/login/v1/idk/token";
const AUDI_AZS_BASE   = "https://emea.bff.cariad.digital/login/v1/audi";
const AUDI_VEHICLE_BASE = "https://emea.bff.cariad.digital/vehicle/v1";
const AUDI_HEADERS    = { "User-Agent": "Android/4.31.0 (Build 800341641.root project 'myaudi_android'.ext.buildTime) Android/13", "X-App-Version": "4.31.0", "X-App-Name": "myAudi", "Accept": "text/html,application/json", "Accept-Charset": "utf-8" };
let _audiSession = null;

function _audiCookies(headers) {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);
  const jar = {};
  for (const c of list) { const [kv] = c.split(";"); const eq = kv.indexOf("="); if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim(); }
  return jar;
}
function _cookieStr(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "); }

function _hiddenInputs(html) {
  const inputs = {}; const re = /<input[^>]+>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    if (!/type=['"]?hidden/i.test(m[0])) continue;
    const nm = m[0].match(/name=['"]([^'"]+)['"]/i); const vm = m[0].match(/value=['"]([^'"]*)['"]/i);
    if (nm) inputs[nm[1]] = vm ? vm[1] : "";
  }
  return inputs;
}

function _parseIDK(html) {
  const str  = (key, src) => (src || html).match(new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`))?.[1] || null;
  const hmac = str("hmac"); const relay = str("relayState"); const post = str("postAction");
  const csrf = html.match(/csrf_token\s*:\s*'([^']+)'/)?.[1] || html.match(/csrf_token\s*:\s*"([^"]+)"/)?.[1];
  const csrfParam = html.match(/csrf_parameterName\s*:\s*['"]([^'"]+)['"]/)?.[1] || "_csrf";
  return { templateModel: { hmac, relayState: relay, postAction: post }, csrf_token: csrf, csrf_parameterName: csrfParam };
}

async function audiLogin() {
  const cookies = {};
  const verifier   = crypto.randomBytes(32).toString("base64url");
  const challenge  = crypto.createHash("sha256").update(verifier).digest("base64url");
  const oauthState = crypto.randomBytes(16).toString("hex");

  // Step 1: Get email login page
  const authUrl = new URL(`${AUDI_IDK_BASE}/oidc/v1/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: AUDI_CLIENT_ID, redirect_uri: "myaudi:///", scope: "openid profile mbb", state: oauthState, prompt: "login", code_challenge: challenge, code_challenge_method: "S256" }))
    authUrl.searchParams.set(k, v);

  let resp = await fetch(authUrl.toString(), { headers: AUDI_HEADERS, redirect: "manual" });
  let base = AUDI_IDK_BASE;
  while (resp.status >= 300 && resp.status < 400) {
    Object.assign(cookies, _audiCookies(resp.headers));
    base = new URL(resp.headers.get("location"), base).toString();
    resp = await fetch(base, { headers: { ...AUDI_HEADERS, Cookie: _cookieStr(cookies) }, redirect: "manual" });
  }
  Object.assign(cookies, _audiCookies(resp.headers));
  const emailHtml = await resp.text();

  // Parse email form data from window._IDK or hidden inputs
  const emailIdk = _parseIDK(emailHtml);
  const emailHmac = emailIdk?.templateModel?.hmac || emailHtml.match(/"hmac"\s*:\s*"([^"]+)"/)?.[1];
  const emailCsrf = emailIdk?.csrf_token || emailHtml.match(/"csrf_token"\s*:\s*"([^"]+)"/)?.[1];
  const emailCsrfParam = emailIdk?.csrf_parameterName || "_csrf";
  const emailRelay = emailIdk?.templateModel?.relayState || emailHtml.match(/"relayState"\s*:\s*"([^"]+)"/)?.[1];
  if (!emailHmac) throw new Error("Audi: HMAC ikke funnet på e-post-siden");

  // Step 2: POST email
  const emailBody = new URLSearchParams({
    ..._hiddenInputs(emailHtml),
    email: AUDI_USERNAME, hmac: emailHmac,
    ...(emailCsrf ? { [emailCsrfParam]: emailCsrf } : {}),
    ...(emailRelay ? { relayState: emailRelay } : {}),
  }).toString();
  let emailResp = await fetch(`${AUDI_IDK_BASE}/signin-service/v1/${AUDI_CLIENT_ID}/login/identifier`, {
    method: "POST", redirect: "manual",
    headers: { ...AUDI_HEADERS, "Content-Type": "application/x-www-form-urlencoded", Cookie: _cookieStr(cookies) },
    body: emailBody,
  });
  Object.assign(cookies, _audiCookies(emailResp.headers));
  // Follow redirect to password page
  while (emailResp.status >= 300 && emailResp.status < 400) {
    const loc = emailResp.headers.get("location") || "";
    if (loc.startsWith("myaudi:///")) break;
    base = new URL(loc, AUDI_IDK_BASE).toString();
    emailResp = await fetch(base, { headers: { ...AUDI_HEADERS, Cookie: _cookieStr(cookies) }, redirect: "manual" });
    Object.assign(cookies, _audiCookies(emailResp.headers));
  }
  const passHtml = await emailResp.text();

  // Parse password form data from window._IDK
  const passIdk = _parseIDK(passHtml);
  const passHmac  = passIdk?.templateModel?.hmac   || passHtml.match(/"hmac"\s*:\s*"([^"]+)"/)?.[1];
  const passCsrf  = passIdk?.csrf_token             || passHtml.match(/csrf_token\s*:\s*['"]([^'"]+)['"]/)?.[1];
  const csrfParam = passIdk?.csrf_parameterName     || "_csrf";
  const passRelay = passIdk?.templateModel?.relayState || passHtml.match(/"relayState"\s*:\s*"([^"]+)"/)?.[1];
  const postAct   = passIdk?.templateModel?.postAction || "login/authenticate";
  if (!passHmac) throw new Error("Audi: HMAC ikke funnet på passord-siden");

  // Step 3: POST password
  const passBody = new URLSearchParams({
    email: AUDI_USERNAME, password: AUDI_PASSWORD, hmac: passHmac,
    ...(passCsrf  ? { [csrfParam]: passCsrf }    : {}),
    ...(passRelay ? { relayState: passRelay }     : {}),
  }).toString();
  let passResp = await fetch(`${AUDI_IDK_BASE}/signin-service/v1/${AUDI_CLIENT_ID}/${postAct}`, {
    method: "POST", redirect: "manual",
    headers: { ...AUDI_HEADERS, "Content-Type": "application/x-www-form-urlencoded", Cookie: _cookieStr(cookies) },
    body: passBody,
  });
  Object.assign(cookies, _audiCookies(passResp.headers));

  // Step 4: Follow redirects to get auth code
  let authCode = null; let hops = 0;
  while (passResp.status >= 300 && passResp.status < 400 && hops++ < 12) {
    const loc = passResp.headers.get("location") || "";
    if (loc.startsWith("myaudi:///") || loc.includes("code=")) {
      try { authCode = new URL(loc.replace("myaudi:///", "https://x.test/")).searchParams.get("code"); } catch {}
      break;
    }
    passResp = await fetch(new URL(loc, AUDI_IDK_BASE).toString(), { headers: { ...AUDI_HEADERS, Cookie: _cookieStr(cookies) }, redirect: "manual" });
    Object.assign(cookies, _audiCookies(passResp.headers));
  }
  if (!authCode) throw new Error("Audi: auth-kode ikke funnet etter innlogging");

  // Step 5: Exchange code → IDK access/refresh tokens
  const idkResp = await fetch(AUDI_TOKEN_EP, {
    method: "POST",
    headers: { ...AUDI_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: AUDI_CLIENT_ID, grant_type: "authorization_code", code: authCode, redirect_uri: "myaudi:///", code_verifier: verifier }).toString(),
  });
  if (!idkResp.ok) throw new Error(`Audi IDK token: ${idkResp.status} ${await idkResp.text()}`);
  const idk = await idkResp.json();

  // IDK access_token works directly with vehicle API (AZS tokens lose required jtt claim)
  _audiSession = {
    token: idk.access_token,
    refreshToken: idk.refresh_token,
    expiry: Date.now() + ((idk.expires_in || 3600) - 60) * 1000,
  };
  console.log("Audi: innlogget OK");
  return _audiSession;
}

async function ensureAudi() {
  if (!AUDI_USERNAME) throw new Error("AUDI_USERNAME ikke konfigurert");
  if (_audiSession && Date.now() < _audiSession.expiry) return _audiSession;
  if (_audiSession?.refreshToken) {
    try {
      const r = await fetch(AUDI_TOKEN_EP, {
        method: "POST",
        headers: { ...AUDI_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: AUDI_CLIENT_ID, grant_type: "refresh_token", refresh_token: _audiSession.refreshToken }).toString(),
      });
      if (r.ok) {
        const d = await r.json();
        _audiSession = { token: d.access_token, refreshToken: d.refresh_token || _audiSession.refreshToken, expiry: Date.now() + ((d.expires_in || 3600) - 60) * 1000 };
        return _audiSession;
      }
    } catch {}
  }
  return audiLogin();
}

// ---- Ring doorbell ding listener ----
let lastDing = null;
let dingListenersSetup = false;
const snapshotCache = {}; // { [cameraId]: { buf, ts } }
let sonosDiscoveryPromise = null; // ensures discovery runs exactly once

async function setupDingListeners() {
  if (dingListenersSetup) return;
  dingListenersSetup = true;

  // Only alert on dings that arrive after this moment
  const startedAt = Date.now();

  try {
    const cameras = await getRingCameras();
    if (!cameras.length) return;

    const seenDingIds = new Set();
    const restClient = cameras[0].restClient;

    const handleDing = (cam) => {
      lastDing = { cameraId: String(cam.id), cameraName: cam.name, timestamp: Date.now() };
      console.log(`🔔 Ringeklokke: ${cam.name}`);
    };

    // FCM push — instant notification when it works
    cameras.forEach(cam => {
      if (typeof cam.onDoorbellPressed?.subscribe === "function") {
        cam.onDoorbellPressed.subscribe(() => {
          seenDingIds.add(`fcm-${Date.now()}`); // mark so polling doesn't double-fire
          handleDing(cam);
        });
      }
    });

    // Poll /dings/active every 2s as fallback (Ring REST API lags ~15-20s behind push)
    setInterval(async () => {
      try {
        const active = await restClient.request({ url: "https://api.ring.com/clients_api/dings/active" });
        for (const ding of active) {
          if (ding.kind !== "ding") continue;
          if (seenDingIds.has(ding.id)) continue;
          seenDingIds.add(ding.id);
          const cam = cameras.find(c => c.id === ding.doorbot_id);
          if (!cam) continue;
          handleDing(cam);
        }
        if (seenDingIds.size > 200) seenDingIds.clear();
      } catch {}
    }, 2000);

    // Pre-cache snapshots — retry every 5s until all cameras have a cached image, then every 30s
    const refreshSnapshots = async () => {
      for (const cam of cameras) {
        try {
          const buf = await Promise.race([
            cam.getSnapshot(),
            new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 8000)),
          ]);
          snapshotCache[cam.id] = { buf, ts: Date.now() };
        } catch {}
      }
    };

    // Pre-cache one snapshot per camera at startup — no periodic background refresh
    refreshSnapshots();

    console.log(`Ring: poller ${cameras.length} kamera(er) for dørklokke-hendelser`);
  } catch (e) {
    console.warn("Ring ding-lytter:", e.message);
    dingListenersSetup = false;
  }
}

// ---- Spotify ----
let spotifyTokens = null;
let spotifyOauthState = null;
try { spotifyTokens = JSON.parse(fs.readFileSync(SPOTIFY_TOKEN_FILE, "utf8")); } catch {}

function persistSpotifyTokens() {
  try { fs.writeFileSync(SPOTIFY_TOKEN_FILE, JSON.stringify(spotifyTokens, null, 2)); } catch {}
}

async function refreshSpotifyToken() {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: spotifyTokens.refresh_token }).toString(),
  });
  if (!r.ok) throw new Error(`Spotify token refresh failed: ${r.status}`);
  const data = await r.json();
  spotifyTokens = {
    ...spotifyTokens,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
  };
  persistSpotifyTokens();
}

async function spotifyFetch(method, apiPath, body) {
  if (!spotifyTokens) throw new Error("Ikke autentisert med Spotify");
  if (Date.now() >= spotifyTokens.expires_at) await refreshSpotifyToken();
  const r = await fetch(`https://api.spotify.com/v1${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${spotifyTokens.access_token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Spotify ${r.status}: ${await r.text()}`);
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// ---- Zaptec ----
let zaptecToken = null;
let zaptecTokenExpiry = 0;

async function ensureZaptecToken() {
  if (zaptecToken && Date.now() < zaptecTokenExpiry) return;
  const r = await fetch("https://api.zaptec.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", username: ZAPTEC_USERNAME, password: ZAPTEC_PASSWORD, scope: "openid" }).toString(),
  });
  if (!r.ok) throw new Error(`Zaptec autentisering feilet: ${r.status}`);
  const data = await r.json();
  zaptecToken = data.access_token;
  zaptecTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
}

async function zaptecFetch(method, path, body) {
  await ensureZaptecToken();
  const r = await fetch(`https://api.zaptec.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${zaptecToken}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Zaptec ${r.status}: ${await r.text()}`);
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\n❌ Mangler HOMEY_CLIENT_ID og/eller HOMEY_CLIENT_SECRET");
  console.error("   Opprett en API-klient på https://tools.developer.homey.app");
  console.error("   og legg verdiene i .env-filen.\n");
  process.exit(1);
}

// ---- State (i minnet + persistert) ----
let state = {
  tokens: null,         // { access_token, refresh_token, expires_at }
  homeyUrl: null,       // remoteUrl for Homey
  homeyName: null,
  sessionToken: null,   // session-token for spesifikk Homey
  oauthState: null,     // CSRF-beskyttelse
};

try {
  const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  state.tokens = saved.tokens;
} catch {}

const PREFS_FILE = path.join(__dirname, ".homey-prefs.json");
let prefs = {};
try { prefs = JSON.parse(fs.readFileSync(PREFS_FILE, "utf8")); } catch {}
function persistPrefs() {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch {}
}

function persist() {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ tokens: state.tokens }, null, 2)); } catch {}
}

// ---- OAuth & Homey ----
async function exchangeCode(code) {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://api.athom.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=authorization_code&code=${encodeURIComponent(code)}`,
  });
  if (!r.ok) throw new Error(`Token exchange failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  data.expires_at = Date.now() + (parseInt(data.expires_in, 10) - 60) * 1000;
  return data;
}

async function refreshTokens() {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://api.athom.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(state.tokens.refresh_token)}`,
  });
  if (!r.ok) throw new Error(`Refresh failed: ${r.status}`);
  const data = await r.json();
  data.expires_at = Date.now() + (parseInt(data.expires_in, 10) - 60) * 1000;
  state.tokens = data;
  persist();
}

async function ensureFreshToken() {
  if (!state.tokens) throw new Error("Not authenticated");
  if (Date.now() >= state.tokens.expires_at) await refreshTokens();
}

async function setupHomeySession() {
  await ensureFreshToken();

  // 1. Hent bruker og Homey-info
  const userRes = await fetch("https://api.athom.com/user/me", {
    headers: { Authorization: `Bearer ${state.tokens.access_token}` },
  });
  if (!userRes.ok) throw new Error(`User fetch failed: ${userRes.status}`);
  const user = await userRes.json();
  if (!user.homeys?.length) throw new Error("Ingen Homeys funnet på kontoen");
  const homey = user.homeys[0];
  state.homeyUrl = homey.remoteUrl;
  state.homeyName = homey.name;

  // 2. Hent delegation token
  const delegRes = await fetch("https://api.athom.com/delegation/token?audience=homey", {
    method: "POST",
    headers: { Authorization: `Bearer ${state.tokens.access_token}` },
  });
  if (!delegRes.ok) throw new Error(`Delegation failed: ${delegRes.status}`);
  const delegToken = await delegRes.json();

  // 3. Logg inn på Homey for å få session-token
  const sessionRes = await fetch(`${state.homeyUrl}/api/manager/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: delegToken }),
  });
  if (!sessionRes.ok) throw new Error(`Session failed: ${sessionRes.status}`);
  state.sessionToken = await sessionRes.json();
}

async function homeyRequest(method, apiPath, body) {
  if (!state.sessionToken || !state.homeyUrl) await setupHomeySession();

  const doRequest = async () => {
    const r = await fetch(`${state.homeyUrl}/api${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${state.sessionToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r;
  };

  let r = await doRequest();
  if (r.status === 401) {
    // Session utløpt - bygg ny
    await setupHomeySession();
    r = await doRequest();
  }
  if (!r.ok) throw new Error(`Homey API ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// ---- HTTP-server ----
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
    req.on("error", reject);
  });
}

const HTML_PATH = path.join(__dirname, "index.html");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // Frontend
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(HTML_PATH));
    }

    // Static assets from /public/
    if (p.startsWith("/public/") && !p.includes("..")) {
      const filePath = path.join(__dirname, p);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const mime = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
        res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream", "Cache-Control": "public, max-age=86400" });
        return res.end(fs.readFileSync(filePath));
      }
    }

    // Auth status
    if (p === "/auth/status") {
      return send(res, 200, {
        authenticated: !!state.tokens,
        homeyName: state.homeyName,
      });
    }

    // Start OAuth-flyt
    if (p === "/auth/login") {
      state.oauthState = crypto.randomBytes(16).toString("hex");
      const authUrl = `https://api.athom.com/oauth2/authorise?` +
        `response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&state=${state.oauthState}`;
      res.writeHead(302, { Location: authUrl });
      return res.end();
    }

    // OAuth callback
    if (p === "/auth/callback") {
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      if (returnedState !== state.oauthState) {
        return send(res, 400, "Ugyldig state-parameter");
      }
      if (!code) return send(res, 400, "Mangler code");
      state.tokens = await exchangeCode(code);
      persist();
      await setupHomeySession();
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    // Brukerpreferanser per enhet
    if (p === "/prefs") {
      if (req.method === "GET") return send(res, 200, prefs);
      if (req.method === "PUT") {
        const body = await readBody(req);
        prefs = body || {};
        persistPrefs();
        return send(res, 200, { ok: true });
      }
    }

    // Logg ut
    if (p === "/auth/logout") {
      state = { tokens: null, homeyUrl: null, homeyName: null, sessionToken: null, oauthState: null };
      try { fs.unlinkSync(TOKEN_FILE); } catch {}
      return send(res, 200, { ok: true });
    }

    // Sanntidsavganger fra Entur
    if (p === "/transit/departures") {
      const query = `{
        kragsvei: quay(id: "NSR:Quay:11584") {
          estimatedCalls(timeRange: 7200, numberOfDepartures: 2) {
            expectedDepartureTime realtime
            destinationDisplay { frontText }
            serviceJourney { line { publicCode transportMode } }
          }
        }
        amager: quay(id: "NSR:Quay:11676") {
          estimatedCalls(timeRange: 7200, numberOfDepartures: 2) {
            expectedDepartureTime realtime
            destinationDisplay { frontText }
            serviceJourney { line { publicCode transportMode } }
          }
        }
        holmenOsteraas: quay(id: "NSR:Quay:11669") {
          estimatedCalls(timeRange: 7200, numberOfDepartures: 2) {
            expectedDepartureTime realtime
            destinationDisplay { frontText }
            serviceJourney { line { publicCode transportMode } }
          }
        }
        holmenElling: quay(id: "NSR:Quay:11670") {
          estimatedCalls(timeRange: 7200, numberOfDepartures: 2) {
            expectedDepartureTime realtime
            destinationDisplay { frontText }
            serviceJourney { line { publicCode transportMode } }
          }
        }
      }`;
      const r = await fetch("https://api.entur.io/journey-planner/v3/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", "ET-Client-Name": "homey-dashboard-nicolai" },
        body: JSON.stringify({ query }),
      });
      if (!r.ok) throw new Error(`Entur API feilet: ${r.status}`);
      const json = await r.json();
      return send(res, 200, json.data || {});
    }

    // Værmelding fra MET Norway (Yr.no)
    if (p === "/weather/forecast") {
      if (!state._wxCache || Date.now() > state._wxExpiry) {
        const r = await fetch(
          "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=59.924&lon=10.648",
          { headers: { "User-Agent": "homey-dashboard/1.0 nicolai.eeg-larsen@brivo.no" } }
        );
        if (!r.ok) throw new Error(`MET API: ${r.status}`);
        state._wxCache = await r.json();
        state._wxExpiry = Date.now() + 30 * 60 * 1000;
      }
      return send(res, 200, state._wxCache);
    }

    // iCal kalender
    if (p === "/calendar/today") {
      const rawUrl = url.searchParams.get("url");
      if (!rawUrl) return send(res, 200, { events: [] });
      const calUrl = rawUrl.replace(/^webcal:\/\//i, "https://");
      try {
        const u = new URL(calUrl);
        if (!u.hostname.endsWith(".icloud.com"))
          return send(res, 400, { error: "Kun iCloud-kalendere støttes" });
      } catch {
        return send(res, 400, { error: "Ugyldig URL" });
      }
      const cached = calCache.get(calUrl);
      if (cached && Date.now() < cached.expires) return send(res, 200, cached.data);
      const cr = await fetch(calUrl, { headers: { "User-Agent": "homey-dashboard/1.0" } });
      if (!cr.ok) throw new Error(`Kalender: ${cr.status}`);
      const today = todayKey();
      const allEvents = parseICS(await cr.text());
      const events = allEvents
        .map(e => ({ ...e, sp: parseDTDate(e.dtstart, e.allDay) }))
        .filter(e => e.sp?.date === today)
        .sort((a, b) => {
          if (a.allDay && !b.allDay) return -1;
          if (!a.allDay && b.allDay) return 1;
          return (a.sp.ts || 0) - (b.sp.ts || 0);
        })
        .map(e => ({
          summary: e.summary,
          location: e.location || null,
          allDay: e.allDay,
          startTs: e.sp.ts,
          endTs: parseDTDate(e.dtend, e.allDay)?.ts || null,
        }));
      const result = { events };
      calCache.set(calUrl, { data: result, expires: Date.now() + 2 * 60 * 1000 });
      return send(res, 200, result);
    }

    // Ring kameraer
    if (p === "/camera/ring") {
      const cameras = await getRingCameras();
      if (process.env.RING_REFRESH_TOKEN) setupDingListeners().catch(() => {});
      return send(res, 200, cameras.map(c => ({ id: c.id, name: c.name, deviceType: c.deviceType })));
    }
    if (p === "/camera/ring/latest-ding") {
      if (process.env.RING_REFRESH_TOKEN) setupDingListeners().catch(() => {});
      const TTL = 70 * 1000;
      if (lastDing && Date.now() - lastDing.timestamp < TTL) {
        return send(res, 200, { ding: true, ...lastDing });
      }
      return send(res, 200, { ding: false });
    }
    if (p === "/camera/ring/test-ding") {
      const cameras = await getRingCameras();
      const doorbell = cameras[0];
      lastDing = { cameraId: doorbell ? String(doorbell.id) : "0", cameraName: doorbell ? doorbell.name : "Test-klokke", timestamp: Date.now() };
      console.log("🧪 Test-ding trigget manuelt");
      return send(res, 200, { ok: true });
    }
    if (p.startsWith("/camera/ring/")) {
      const id = parseInt(p.slice("/camera/ring/".length).split("/")[0]);
      const cameras = await getRingCameras();
      const cam = cameras.find(c => c.id === id);
      if (!cam) return send(res, 404, { error: "Kamera ikke funnet" });
      // Serve from cache if fresh (< 30s) — avoids hammering Ring on rapid requests
      const cached = snapshotCache[id];
      if (cached && Date.now() - cached.ts < 30_000) {
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
        return res.end(cached.buf);
      }
      // Fetch fresh snapshot on demand
      const snapshot = await Promise.race([
        cam.getSnapshot(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
      ]);
      snapshotCache[id] = { buf: snapshot, ts: Date.now() };
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
      return res.end(snapshot);
    }

    // Kamera snapshot-proxy (binary, ikke JSON)
    if (p.startsWith("/camera/snapshot/")) {
      if (!state.tokens) return send(res, 401, { error: "Ikke autentisert" });
      if (!state.sessionToken || !state.homeyUrl) await setupHomeySession();
      const imageId = p.slice("/camera/snapshot/".length).split("?")[0];
      const doFetch = async () => fetch(`${state.homeyUrl}/api/manager/images/${imageId}`, {
        headers: { Authorization: `Bearer ${state.sessionToken}` },
      });
      let r = await doFetch();
      if (r.status === 401) { await setupHomeySession(); r = await doFetch(); }
      if (!r.ok) throw new Error(`Camera snapshot: ${r.status}`);
      const ct = r.headers.get("content-type") || "image/jpeg";
      res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-store" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }

    // Proxy til Homey API
    if (p.startsWith("/homey/")) {
      if (!state.tokens) return send(res, 401, { error: "Ikke autentisert" });
      const apiPath = "/" + p.slice("/homey/".length) + (url.search || "");
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : null;
      if (req.method !== "GET") console.log(`Homey ${req.method} ${apiPath}`);
      const data = await homeyRequest(req.method, apiPath, body);
      return send(res, 200, data);
    }

    // ---- Sonos ----
    if (p === "/sonos/devices") {
      const { AsyncDeviceDiscovery, Sonos } = await import("sonos");
      if (!sonosDiscoveryPromise) {
        sonosDiscoveryPromise = (async () => {
          const discovery = new AsyncDeviceDiscovery();
          const found = await discovery.discoverMultiple({ timeout: 4000 }).catch(() => []);
          const initial = await Promise.all(found.map(async dev => {
            try {
              const s = new Sonos(dev.host);
              const attrs = await s.getZoneAttrs();
              return { ip: dev.host, name: attrs.CurrentZoneName };
            } catch { return null; }
          }));
          return [...new Map(initial.filter(Boolean).map(d => [d.ip, d])).values()]
            .sort((a, b) => a.name.localeCompare(b.name, "nb"));
        })();
      }
      const sonosKnownHosts = await sonosDiscoveryPromise;
      const devices = await Promise.all(sonosKnownHosts.map(async ({ ip, name }) => {
        try {
          const s = new Sonos(ip);
          const [state, vol, media] = await Promise.all([
            s.getCurrentState(),
            s.getVolume(),
            s.currentTrack().catch(() => null),
          ]);
          return { ip, name, state, volume: vol,
            track: media?.title || null, artist: media?.artist || null };
        } catch { return null; }
      }));
      return send(res, 200, devices.filter(Boolean));
    }

    if (p === "/sonos/radio" && req.method === "POST") {
      const { ip, streamUrl, stationName } = await readBody(req);
      const { Sonos } = await import("sonos");
      const s = new Sonos(ip);
      const parsed = new URL(streamUrl);
      const sonosUri = `x-rincon-mp3radio://${parsed.host}${parsed.pathname}${parsed.search}`;
      const metadata = `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="R:0/0/1" parentID="R:0/0" restricted="true"><dc:title>${stationName.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class></item></DIDL-Lite>`;
      await s.setAVTransportURI({ uri: sonosUri, metadata });
      await s.play();
      return send(res, 200, { ok: true });
    }

    if (p === "/sonos/spotify" && req.method === "POST") {
      const { ip, uri, name } = await readBody(req);
      const { Sonos } = await import("sonos");
      const s = new Sonos(ip);

      const buildTrackMeta = (trackUri, title) => {
        const enc = encodeURIComponent(trackUri).replace(/%3A/gi, "%3a");
        const safe = (title || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const sonosUri = `x-sonos-spotify:${enc}?sid=9&flags=8232&sn=1`;
        const meta = `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="10032028${enc}" parentID="00020000track:" restricted="true"><dc:title>${safe}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON2311_X_#Svc2311-0-Token</desc></item></DIDL-Lite>`;
        return { sonosUri, meta };
      };

      if (uri.startsWith("spotify:track")) {
        const { sonosUri, meta } = buildTrackMeta(uri, name);
        await s.setAVTransportURI({ uri: sonosUri, metadata: meta });
        await s.play();
      } else {
        // Playlist or album: fetch tracks via Spotify API and queue them
        const type = uri.startsWith("spotify:album") ? "albums" : "playlists";
        const id = uri.split(":").pop();
        const data = await spotifyFetch("GET", `/${type}/${id}/tracks?limit=50&fields=items(track(uri,name,artists))`);
        const tracks = (data?.items || []).map(i => i.track).filter(t => t?.uri);
        if (!tracks.length) return send(res, 404, { error: "Ingen spor funnet i spillelisten" });
        await s.flush();
        const first = tracks[0];
        const { sonosUri, meta } = buildTrackMeta(first.uri, first.name);
        await s.setAVTransportURI({ uri: sonosUri, metadata: meta });
        // Queue remaining tracks
        for (const t of tracks.slice(1)) {
          const { sonosUri: u, meta: m } = buildTrackMeta(t.uri, t.name);
          await s.queue({ uri: u, metadata: m });
        }
        await s.play();
      }
      return send(res, 200, { ok: true });
    }

    if (p === "/sonos/control" && req.method === "POST") {
      const { ip, action, volume } = await readBody(req);
      const { Sonos } = await import("sonos");
      const s = new Sonos(ip);
      if (action === "play") await s.play();
      else if (action === "pause") await s.pause();
      else if (action === "next") await s.next();
      else if (action === "prev") await s.previous();
      else if (action === "volume" && volume != null) await s.setVolume(Math.round(volume));
      return send(res, 200, { ok: true });
    }

    // ---- Spotify ----
    if (p === "/spotify/auth/status") {
      return send(res, 200, { authenticated: !!spotifyTokens });
    }

    if (p === "/spotify/auth/login") {
      if (!SPOTIFY_CLIENT_ID) return send(res, 400, { error: "SPOTIFY_CLIENT_ID ikke konfigurert i .env" });
      spotifyOauthState = crypto.randomBytes(16).toString("hex");
      const scopes = "playlist-read-private playlist-read-collaborative user-read-playback-state user-modify-playback-state user-read-currently-playing";
      const authUrl = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
        response_type: "code", client_id: SPOTIFY_CLIENT_ID,
        scope: scopes, redirect_uri: SPOTIFY_REDIRECT_URI, state: spotifyOauthState,
        show_dialog: "true",
      }).toString();
      res.writeHead(302, { Location: authUrl });
      return res.end();
    }

    if (p === "/spotify/auth/callback") {
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== spotifyOauthState) return send(res, 400, "Ugyldig state");
      if (!code) return send(res, 400, "Mangler code");
      const r = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: SPOTIFY_REDIRECT_URI }).toString(),
      });
      if (!r.ok) throw new Error(`Spotify token exchange: ${r.status}`);
      const data = await r.json();
      spotifyTokens = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in - 60) * 1000, scope: data.scope };
      persistSpotifyTokens();
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    if (p === "/spotify/auth/logout") {
      spotifyTokens = null;
      try { fs.unlinkSync(SPOTIFY_TOKEN_FILE); } catch {}
      return send(res, 200, { ok: true });
    }

    if (p === "/spotify/me/playlists") {
      const data = await spotifyFetch("GET", "/me/playlists?limit=30");
      return send(res, 200, data);
    }

    if (p === "/spotify/search") {
      const q = url.searchParams.get("q");
      if (!q) return send(res, 400, { error: "Mangler q" });
      const data = await spotifyFetch("GET", `/search?q=${encodeURIComponent(q)}&type=album,track&limit=10`);
      return send(res, 200, data);
    }

    if (p === "/spotify/devices") {
      const data = await spotifyFetch("GET", "/me/player/devices");
      return send(res, 200, data);
    }

    if (p === "/spotify/player") {
      const data = await spotifyFetch("GET", "/me/player");
      return send(res, 200, data);
    }

    if (p === "/spotify/play" && req.method === "POST") {
      const { context_uri, uris, device_id } = await readBody(req);
      const qs = device_id ? `?device_id=${device_id}` : "";
      const body = uris ? { uris } : { context_uri };
      await spotifyFetch("PUT", `/me/player/play${qs}`, body);
      return send(res, 200, { ok: true });
    }

    if (p === "/spotify/pause" && req.method === "POST") {
      const { device_id, resume } = await readBody(req);
      const qs = device_id ? `?device_id=${device_id}` : "";
      await spotifyFetch("PUT", resume ? `/me/player/play${qs}` : `/me/player/pause${qs}`, resume ? {} : undefined);
      return send(res, 200, { ok: true });
    }

    // ---- Zaptec ----
    if (p === "/zaptec/status") {
      if (!ZAPTEC_USERNAME) return send(res, 400, { error: "ZAPTEC_USERNAME ikke konfigurert" });
      const chargers = await zaptecFetch("GET", "/api/chargers?Roles=1");
      if (!chargers?.Data?.length) return send(res, 404, { error: "Ingen ladere funnet" });
      const charger = ZAPTEC_CHARGER_ID
        ? chargers.Data.find(c => c.Id === ZAPTEC_CHARGER_ID) || chargers.Data[0]
        : chargers.Data[0];
      const stateArr = await zaptecFetch("GET", `/api/chargers/${charger.Id}/state`);
      const s = {};
      (stateArr || []).forEach(x => { s[x.StateId] = x.ValueAsString; });
      return send(res, 200, {
        chargerId: charger.Id,
        name: charger.Name || "Zaptec-lader",
        mode: parseInt(s[710] ?? charger.OperatingMode ?? 1),
        isOnline: charger.IsOnline ?? false,
        powerW: parseFloat(s[513] || 0),
        sessionEnergy: parseFloat(s[553] || 0),
        currentL1: parseFloat(s[507] || 0),
        currentL2: parseFloat(s[508] || 0),
        currentL3: parseFloat(s[509] || 0),
      });
    }

    if (p === "/zaptec/authorize" && req.method === "POST") {
      if (!ZAPTEC_USERNAME) return send(res, 400, { error: "ZAPTEC_USERNAME ikke konfigurert" });
      let chargerId = ZAPTEC_CHARGER_ID;
      if (!chargerId) {
        const chargers = await zaptecFetch("GET", "/api/chargers?Roles=1");
        chargerId = chargers?.Data?.[0]?.Id;
        if (!chargerId) return send(res, 404, { error: "Ingen lader funnet" });
      }
      await zaptecFetch("POST", `/api/chargers/${chargerId}/authorizecharge`);
      return send(res, 200, { ok: true });
    }

    if (p === "/zaptec/stop" && req.method === "POST") {
      if (!ZAPTEC_USERNAME) return send(res, 400, { error: "ZAPTEC_USERNAME ikke konfigurert" });
      let chargerId = ZAPTEC_CHARGER_ID;
      if (!chargerId) {
        const chargers = await zaptecFetch("GET", "/api/chargers?Roles=1");
        chargerId = chargers?.Data?.[0]?.Id;
        if (!chargerId) return send(res, 404, { error: "Ingen lader funnet" });
      }
      await zaptecFetch("POST", `/api/chargers/${chargerId}/sendCommand/506`);
      return send(res, 200, { ok: true });
    }

    // ---- Audi ----
    if (p === "/audi/status") {
      const s = await ensureAudi();
      const r = await fetch(
        `${AUDI_VEHICLE_BASE}/vehicles/${AUDI_VIN}/selectivestatus?jobs=charging,climatisation,fuelStatus`,
        { headers: { ...AUDI_HEADERS, Authorization: `Bearer ${s.token}` } }
      );
      if (!r.ok) throw new Error(`Audi status: ${r.status} ${await r.text()}`);
      const d = await r.json();
      const ch = d.charging; const cl = d.climatisation; const fu = d.fuelStatus;
      return send(res, 200, {
        batteryPct:    ch?.batteryStatus?.value?.currentSOC_pct ?? null,
        rangeKm:       fu?.rangeStatus?.value?.primaryEngine?.remainingRange_km ?? fu?.rangeStatus?.value?.electricRange ?? ch?.batteryStatus?.value?.cruisingRangeElectric_km ?? null,
        chargingState: ch?.chargingStatus?.value?.chargingState ?? null,
        chargeKw:      ch?.chargingStatus?.value?.chargePower_kW ?? null,
        plugConnected: ch?.plugStatus?.value?.plugConnectionState === "connected",
        targetSoc:     ch?.chargingSettings?.value?.targetSOC_pct ?? null,
        climateOn:      ["cooling","heating","ventilation"].includes(cl?.climatisationStatus?.value?.climatisationState),
        climateState:   cl?.climatisationStatus?.value?.climatisationState ?? null,
        climateTemp:    cl?.climatisationSettings?.value?.targetTemperature_C ?? null,
        climateMinutes: cl?.climatisationStatus?.value?.remainingClimatisationTime_min ?? null,
      });
    }

    if (p === "/audi/climate/start" && req.method === "POST") {
      const s = await ensureAudi();
      const { temperature } = await readBody(req);
      const r = await fetch(`${AUDI_VEHICLE_BASE}/vehicles/${AUDI_VIN}/climatisation/start`, {
        method: "POST",
        headers: { ...AUDI_HEADERS, Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ climatisationMode: "comfort", targetTemperature: Math.round(temperature || 21), targetTemperatureUnit: "celsius", climatisationWithoutExternalPower: true, climatizationAtUnlock: false, windowHeatingEnabled: true, zoneFrontLeftEnabled: true, zoneFrontRightEnabled: true, zoneRearLeftEnabled: false, zoneRearRightEnabled: false }),
      });
      if (!r.ok) throw new Error(`Audi klima start: ${r.status} ${await r.text()}`);
      return send(res, 200, { ok: true });
    }

    if (p === "/audi/climate/stop" && req.method === "POST") {
      const s = await ensureAudi();
      const r = await fetch(`${AUDI_VEHICLE_BASE}/vehicles/${AUDI_VIN}/climatisation/stop`, {
        method: "POST",
        headers: { ...AUDI_HEADERS, Authorization: `Bearer ${s.token}` },
      });
      if (!r.ok) throw new Error(`Audi klima stopp: ${r.status} ${await r.text()}`);
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("Feil:", e.message);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n🏠 Homey Cloud Dashboard kjører!`);
  console.log(`   👉 Åpne http://localhost:${PORT} i nettleseren`);
  console.log(`   📋 Redirect URI registrert i Homey-klienten må være: ${REDIRECT_URI}\n`);
});
