#!/usr/bin/env node
// Fetch one KV v2 path from OpenBao via Pocket ID.
//
// 1. Exchange the caller-minted GitHub OIDC token at Pocket ID (client
//    credentials grant with a JWT bearer assertion) for a short-lived
//    Bao-scoped access token.
// 2. Log in to OpenBao with that token (JWT auth backend trusting Pocket ID).
// 3. Read the KV v2 path.
// Every key becomes a masked env var for subsequent steps via $GITHUB_ENV.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

const { BAO_ADDRESS, BAO_JWT_MOUNT, BAO_JWT_ROLE, BAO_SECRET_PATH,
  GITHUB_OIDC_TOKEN, POCKET_ISSUER, POCKET_CLIENT_ID, POCKET_RESOURCE,
  POCKET_SCOPE, GITHUB_ENV } = process.env;
for (const [k, v] of Object.entries({ BAO_ADDRESS, BAO_JWT_MOUNT, BAO_JWT_ROLE,
  BAO_SECRET_PATH, GITHUB_OIDC_TOKEN, POCKET_ISSUER, POCKET_CLIENT_ID,
  POCKET_RESOURCE, POCKET_SCOPE, GITHUB_ENV })) {
  if (!v) throw new Error(`Missing required environment: ${k}`);
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Request failed: HTTP ${res.status} ${url} ${detail.slice(0, 300)}`);
  }
  return res.json();
}

function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

// Mask the caller-minted assertion too: it arrives as a secret, but belt
// and suspenders if this action is ever wired differently.
process.stdout.write(`::add-mask::${GITHUB_OIDC_TOKEN}\n`);

// 1. Discover Pocket ID's token endpoint and exchange the GitHub assertion.
const discovery = await getJson(`${POCKET_ISSUER}/.well-known/openid-configuration`);
if (discovery.issuer !== POCKET_ISSUER) throw new Error("Pocket ID issuer mismatch");
const exchangeBody = new URLSearchParams({
  grant_type: "client_credentials",
  client_id: POCKET_CLIENT_ID,
  client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  client_assertion: GITHUB_OIDC_TOKEN,
  resource: POCKET_RESOURCE,
  scope: POCKET_SCOPE,
});
const exchange = await getJson(discovery.token_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: exchangeBody,
});
const pocketToken = exchange?.access_token;
if (typeof pocketToken !== "string" || !pocketToken) {
  throw new Error("Pocket ID exchange lacked an access token");
}
process.stdout.write(`::add-mask::${pocketToken}\n`);
const claims = decodePayload(pocketToken);
const aud = claims.aud;
if (!(Array.isArray(aud) ? aud.includes(POCKET_RESOURCE) : aud === POCKET_RESOURCE)) {
  throw new Error("Pocket ID token missing the Bao audience");
}
console.log(JSON.stringify({
  pocket_issuer: claims.iss,
  pocket_subject: claims.sub,
  pocket_audience: aud,
  pocket_scope: claims.scope ?? claims.scp,
  pocket_lifetime_seconds: claims.exp - claims.iat,
}));

// 2. Trade it for a short-lived OpenBao token.
const login = await getJson(`${BAO_ADDRESS}/v1/auth/${BAO_JWT_MOUNT}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jwt: pocketToken, role: BAO_JWT_ROLE }),
});
const baoToken = login?.auth?.client_token;
if (typeof baoToken !== "string" || !baoToken) throw new Error("OpenBao login lacked a client token");

// 3. Read the KV v2 path.
const [mount, ...rest] = BAO_SECRET_PATH.split("/").filter(Boolean);
if (!mount || rest.length === 0) throw new Error(`Bad secret path: ${BAO_SECRET_PATH}`);
const kv = await getJson(`${BAO_ADDRESS}/v1/${mount}/data/${rest.join("/")}`, {
  headers: { "X-Vault-Token": baoToken },
});
const data = kv?.data?.data;
if (!data || typeof data !== "object") throw new Error("OpenBao KV response had no data");

// 4. Mask every value and export it for later steps.
// add-mask only registers the first line of a multiline value, so mask
// each line separately; otherwise multiline secrets leak into step logs
// via the runner's environment dump.
const delimiter = `EOF_${randomBytes(8).toString("hex")}`;
let envOut = "";
for (const [key, value] of Object.entries(data)) {
  if (typeof value !== "string") throw new Error(`Secret ${key} is not a string`);
  for (const line of value.split("\n")) {
    if (line) process.stdout.write(`::add-mask::${line}\n`);
  }
  envOut += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
}
appendFileSync(GITHUB_ENV, envOut);
console.log(`Exported ${Object.keys(data).length} secrets from ${BAO_SECRET_PATH}`);
