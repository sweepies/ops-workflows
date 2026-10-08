#!/usr/bin/env node
// Fetch one KV v2 path from OpenBao with this job's GitHub OIDC token.
//
// 1. Request a GitHub OIDC token for the OpenBao audience.
// 2. Log in to OpenBao's GitHub JWT auth mount; the role binds the caller's
//    repository_id, workflow_ref, job_workflow_ref and ref claims.
// 3. Read the KV v2 path.
// Every key becomes a masked env var for subsequent steps via $GITHUB_ENV.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

const { BAO_ADDRESS, BAO_JWT_MOUNT, BAO_JWT_ROLE, BAO_SECRET_PATH, BAO_AUDIENCE,
  GITHUB_ENV, ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN } = process.env;
for (const [k, v] of Object.entries({ BAO_ADDRESS, BAO_JWT_MOUNT, BAO_JWT_ROLE,
  BAO_SECRET_PATH, BAO_AUDIENCE, GITHUB_ENV, ACTIONS_ID_TOKEN_REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN })) {
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

// 1. Mint the assertion in this step so it is never stored or passed between jobs.
const oidcUrl = new URL(ACTIONS_ID_TOKEN_REQUEST_URL);
oidcUrl.searchParams.set("audience", BAO_AUDIENCE);
const assertion = (await getJson(oidcUrl, {
  headers: { Authorization: `Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
}))?.value;
if (typeof assertion !== "string" || !assertion) throw new Error("GitHub OIDC response lacked a token");
process.stdout.write(`::add-mask::${assertion}\n`);

// 2. Trade it for a short-lived OpenBao token.
const login = await getJson(`${BAO_ADDRESS}/v1/auth/${BAO_JWT_MOUNT}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jwt: assertion, role: BAO_JWT_ROLE }),
});
const baoToken = login?.auth?.client_token;
if (typeof baoToken !== "string" || !baoToken) throw new Error("OpenBao login lacked a client token");
process.stdout.write(`::add-mask::${baoToken}\n`);

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
