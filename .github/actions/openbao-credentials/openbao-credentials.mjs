#!/usr/bin/env node
// Fetch deploy credentials from OpenBao with this job's GitHub OIDC token.
//
// 1. Request a GitHub OIDC token for the OpenBao audience.
// 2. Log in to OpenBao's GitHub JWT auth mount; the role binds the caller's
//    repository_id, workflow_ref, job_workflow_ref and ref claims.
// 3. Read the KV v2 path.
// 4. Mint a Cloudflare API token from the cloudflare/ mount. Its lease belongs
//    to the OpenBao token, so the workflow's revoke step deletes it.
// Every value becomes a masked env var for subsequent steps via $GITHUB_ENV.
import { randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { BAO_ADDRESS, BAO_JWT_MOUNT, BAO_JWT_ROLE, BAO_SECRET_PATH, BAO_CLOUDFLARE_ROLE,
  GITHUB_ENV, RUNNER_TEMP, ACTIONS_ID_TOKEN_REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN } = process.env;
// The roles' bound_audiences is the OpenBao address unless a caller overrides it.
const BAO_AUDIENCE = process.env.BAO_AUDIENCE || BAO_ADDRESS;
for (const [k, v] of Object.entries({ BAO_ADDRESS, BAO_JWT_MOUNT, BAO_JWT_ROLE,
  BAO_SECRET_PATH, BAO_CLOUDFLARE_ROLE, BAO_AUDIENCE, GITHUB_ENV, RUNNER_TEMP,
  ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN })) {
  if (!v) throw new Error(`Missing required environment: ${k}`);
}

// Never include response bodies in errors: credential responses carry secrets.
async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Request failed: HTTP ${res.status} ${url}`);
  return res.json();
}

// add-mask only registers the first line of a multiline value, so mask each line.
function mask(value) {
  for (const line of value.split("\n")) {
    if (line) process.stdout.write(`::add-mask::${line}\n`);
  }
}

// 1. Mint the assertion in this step so it is never stored or passed between jobs.
const oidcUrl = new URL(ACTIONS_ID_TOKEN_REQUEST_URL);
oidcUrl.searchParams.set("audience", BAO_AUDIENCE);
const assertion = (await getJson(oidcUrl, {
  headers: { Authorization: `Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
}))?.value;
if (typeof assertion !== "string" || !assertion) throw new Error("GitHub OIDC response lacked a token");
mask(assertion);

// 2. Trade it for a short-lived OpenBao token, kept for the revoke step.
const login = await getJson(`${BAO_ADDRESS}/v1/auth/${BAO_JWT_MOUNT}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jwt: assertion, role: BAO_JWT_ROLE }),
});
const baoToken = login?.auth?.client_token;
if (typeof baoToken !== "string" || !baoToken) throw new Error("OpenBao login lacked a client token");
mask(baoToken);
writeFileSync(join(RUNNER_TEMP, "openbao-token"), baoToken, { mode: 0o600 });
const headers = { "X-Vault-Token": baoToken };

// 3. Read the KV v2 path.
const [mount, ...rest] = BAO_SECRET_PATH.split("/").filter(Boolean);
if (!mount || rest.length === 0) throw new Error(`Bad secret path: ${BAO_SECRET_PATH}`);
const kv = await getJson(`${BAO_ADDRESS}/v1/${mount}/data/${rest.join("/")}`, { headers });
const data = kv?.data?.data;
if (!data || typeof data !== "object") throw new Error("OpenBao KV response had no data");

// 4. Mint the Cloudflare token.
const cloudflare = await getJson(`${BAO_ADDRESS}/v1/cloudflare/creds/${encodeURIComponent(BAO_CLOUDFLARE_ROLE)}`, { headers });
const cloudflareToken = cloudflare?.data?.token;
if (typeof cloudflareToken !== "string" || !cloudflareToken) throw new Error("OpenBao Cloudflare response lacked a token");
if (Object.hasOwn(data, "CLOUDFLARE_API_TOKEN")) throw new Error(`${BAO_SECRET_PATH} must not hold CLOUDFLARE_API_TOKEN`);
const exported = { ...data, CLOUDFLARE_API_TOKEN: cloudflareToken };

const delimiter = `EOF_${randomBytes(8).toString("hex")}`;
let envOut = "";
for (const [key, value] of Object.entries(exported)) {
  if (typeof value !== "string") throw new Error(`Secret ${key} is not a string`);
  mask(value);
  envOut += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
}
appendFileSync(GITHUB_ENV, envOut);
console.log(`Exported ${Object.keys(data).length} secrets from ${BAO_SECRET_PATH} and a Cloudflare token from role ${BAO_CLOUDFLARE_ROLE} (lease ${cloudflare.lease_duration}s)`);
