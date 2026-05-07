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

    // Proxy til Homey API
    if (p.startsWith("/homey/")) {
      if (!state.tokens) return send(res, 401, { error: "Ikke autentisert" });
      const apiPath = "/" + p.slice("/homey/".length) + (url.search || "");
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : null;
      const data = await homeyRequest(req.method, apiPath, body);
      return send(res, 200, data);
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
