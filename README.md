# ops-workflows

Reusable Alchemy deployment workflow for `sweepies`.

For local changes to the exchange scripts, run `mise install` to use the
pinned Node version. This repository has no stored provider credentials.

Call `sweepies/ops-workflows/.github/workflows/alchemy-deployer-broker-auth.yml@main` from an approved repository. The called job requests GitHub OIDC, exchanges it with Pocket ID client `fce36569-010c-4e17-bd30-6fbf9088af07`, obtains Cloudflare and Railway credentials from the broker, and runs local `alchemy deploy`. The GitHub App scope is deliberately absent.

Before deployment, run the manual `Broker claim preflight` workflow. It prints only `iss`, `aud`, `sub`, and `job_workflow_ref`, never the raw assertion. Configure the Pocket ID federated credential Subject to exactly match the printed `sub`. GitHub's repository or organization OIDC subject template must include `job_workflow_ref` for Pocket ID to bind the reusable workflow identity.

The reusable workflow file is directly under `.github/workflows`, as GitHub requires. The single broker exchange implementation is in `.github/actions/broker-auth/broker-auth.mjs`; successful credentials stay in the deploy step's process tree and are masked immediately.

`sweepies/renovate-ce` calls this workflow with `deployment_profile: bun-fnox` and passes its `FNOX_AGE_KEY` secret. The called job installs Bun and fnox, decrypts only the Mend application secrets, then checks out Cloudflare and Railway credentials from the broker for `bun run deploy`. The default `npm` profile runs `npm ci` and `alchemy deploy`.
