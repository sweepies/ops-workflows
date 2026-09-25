#!/usr/bin/env node
// Run a deployment command with credentials available only to this process tree.
import { spawn } from "node:child_process";
import { resolve, relative, isAbsolute } from "node:path";

const separator = process.argv.indexOf("--");
const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
if (!command.length) throw new Error("Usage: node scripts/broker-auth.mjs -- <command> [args]");
const { POCKET_ISSUER, POCKET_CLIENT_ID, BROKER_URL, POCKET_FEDERATED_AUDIENCE,
  ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN } = process.env;
if (![POCKET_ISSUER, POCKET_CLIENT_ID, BROKER_URL, POCKET_FEDERATED_AUDIENCE,
  ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN].every(Boolean)) {
  throw new Error("Missing Pocket ID, broker, or GitHub OIDC environment configuration");
}
function mask(value) { process.stdout.write(`::add-mask::${value}\n`); }
async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Credential exchange failed with HTTP ${response.status}`);
  return response.json();
}
const oidcUrl = new URL(ACTIONS_ID_TOKEN_REQUEST_URL);
oidcUrl.searchParams.set("audience", POCKET_FEDERATED_AUDIENCE);
const assertion = (await getJson(oidcUrl, { headers: { Authorization: `Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } })).value;
if (typeof assertion !== "string") throw new Error("GitHub OIDC response lacked a token");
mask(assertion);
const issuer = POCKET_ISSUER.replace(/\/$/, "");
const discovery = await getJson(`${issuer}/.well-known/openid-configuration`);
if (discovery.issuer !== issuer || !discovery.token_endpoint ||
  new URL(discovery.token_endpoint).origin !== new URL(issuer).origin) {
  throw new Error("Pocket ID discovery mismatch");
}
const form = new URLSearchParams({
  grant_type: "client_credentials",
  client_id: POCKET_CLIENT_ID,
  client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  client_assertion: assertion,
  resource: "https://broker.ops.sweepy.dev",
  scope: "cloudflare:full-access railway:full-access",
});
const accessToken = (await getJson(discovery.token_endpoint, { method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form })).access_token;
if (typeof accessToken !== "string") throw new Error("Pocket ID response lacked an access token");
mask(accessToken);
async function checkout(path) {
  const url = new URL(path, BROKER_URL);
  if (url.origin !== new URL(BROKER_URL).origin) throw new Error("Broker URL mismatch");
  const data = await getJson(url, { method: "POST", headers: {
    Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json",
  }, body: "{}" });
  if (typeof data.token !== "string" || !data.token) throw new Error("Broker response lacked a token");
  mask(data.token);
  return data.token;
}
const cloudflare = await checkout("/v1/cloudflare/token");
const railway = await checkout("/v1/railway/token");
const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const cwd = resolve(workspace, process.env.ALCHEMY_DIRECTORY ?? ".");
const offset = relative(workspace, cwd);
if (isAbsolute(offset) || offset === ".." || offset.startsWith("../")) throw new Error("Alchemy directory must be in the caller workspace");
const child = spawn(command[0], command.slice(1), {
  cwd, stdio: "inherit", env: { ...process.env, CLOUDFLARE_API_TOKEN: cloudflare, RAILWAY_API_TOKEN: railway },
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
