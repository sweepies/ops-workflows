# ops-workflows

Reusable Alchemy deployment workflow for `sweepies`.

For local changes to the exchange scripts, run `mise install` to use the
pinned Node version. This repository has no stored provider credentials.

Call `sweepies/ops-workflows/.github/workflows/alchemy-deployer-broker-auth.yml@main` from an approved repository, granting `id-token: write`. The called job requests its own GitHub OIDC tokens, exchanges them with the caller's Pocket ID clients, obtains Cloudflare and Railway credentials from the broker, and runs local `alchemy deploy`. The GitHub App scope is deliberately absent. No assertion is passed between jobs or stored as an artifact.

Each calling repository needs:

- An OIDC subject template of `repo` + `job_workflow_ref` with immutable subjects: `gh api -X PUT repos/sweepies/<repo>/actions/oidc/customization/sub -F use_default=false -f 'include_claim_keys[]=repo' -f 'include_claim_keys[]=job_workflow_ref' -F use_immutable_subject=true`. The resulting `sub` is `repo:sweepies@7191851/<repo>@<repo id>:job_workflow_ref:sweepies/ops-workflows/.github/workflows/alchemy-deployer-broker-auth.yml@refs/heads/main`, distinct per repository even though every caller runs this same workflow.
- Its own Pocket ID broker client (`pocket_broker_client_id`) and, in bao mode, its own OpenBao client (`pocket_bao_client_id`), each with that exact Subject. Pocket ID matches federated identities by issuer, so one client cannot trust several subjects.

ops-workflows' own preflights use client `fce36569-010c-4e17-bd30-6fbf9088af07`. Run the manual `Broker claim preflight` here (or the equivalent `claim_preflight: true` call from a caller) to print `iss`, `aud`, `sub`, and `job_workflow_ref`, never the raw assertion.

In bao mode the job reads one KV v2 path from `https://bao.maccrae.family` through the `jwt-pocket` mount; no tailnet join is needed.

The reusable workflow file is directly under `.github/workflows`, as GitHub requires. The single broker exchange implementation is in `.github/actions/broker-auth/broker-auth.mjs`; successful credentials stay in the deploy step's process tree and are masked immediately.

`sweepies/renovate-ce` and `sweepies/remote-agent` call this workflow with `deployment_profile: bun` and `secret_source: bao`. The default `npm` profile runs `npm ci` and `alchemy deploy`; `bun-fnox` decrypts secrets with the caller's `FNOX_AGE_KEY` instead of OpenBao.
