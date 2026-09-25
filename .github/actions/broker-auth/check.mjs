// Provider calls stay inside the credential-bearing process tree. Print status only.
const cloudflare = process.env.CLOUDFLARE_API_TOKEN;
const railway = process.env.RAILWAY_API_TOKEN;
if (!cloudflare || !railway) throw new Error("Broker checkout did not provide both credentials");
const cfResponse = await fetch("https://api.cloudflare.com/client/v4/accounts/ea30263a65e823508797117cd5f89ad6", {
  headers: { Authorization: `Bearer ${cloudflare}` },
});
const cfData = await cfResponse.json();
if (!cfResponse.ok || cfData.success !== true) throw new Error(`Cloudflare token rejected: HTTP ${cfResponse.status}`);
const railwayResponse = await fetch("https://backboard.railway.com/graphql/v2", {
  method: "POST", headers: { Authorization: `Bearer ${railway}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: "query { me { id } }" }),
});
const railwayData = await railwayResponse.json();
if (!railwayResponse.ok || railwayData.errors?.length || !railwayData.data?.me?.id) {
  throw new Error(`Railway token rejected: HTTP ${railwayResponse.status}`);
}
console.log("Cloudflare account access and Railway account identity verified");
