# ops-workflows

Reusable Alchemy deployment workflow for `sweepies`.

For local changes to the credential script, run `mise install` to use the
pinned Node version. This repository has no stored provider credentials.

Call `sweepies/ops-workflows/.github/workflows/alchemy-deploy.yml@main` from an approved repository, granting `id-token: write`. The called job requests its own GitHub OIDC token, logs in to OpenBao (at the caller's `BAO_ADDRESS` secret) through its GitHub JWT mount, exports one KV v2 path plus a freshly minted Cloudflare API token as masked environment variables, runs `alchemy deploy`, and finally revokes its OpenBao token. Revocation deletes the Cloudflare token at Cloudflare. No assertion or credential is passed between jobs or stored as an artifact.

```yaml
jobs:
  deploy:
    uses: sweepies/ops-workflows/.github/workflows/alchemy-deploy.yml@main
    with:
      deployment_profile: bun
      bao_jwt_role: <repo>-deploy
      bao_secret_path: kv/<repo>
      cloudflare_role: <repo>-deploy
    secrets: inherit
```

Each calling repository needs:

- An OIDC subject template of `repo` + `job_workflow_ref` with immutable subjects: `gh api -X PUT repos/sweepies/<repo>/actions/oidc/customization/sub -F use_default=false -f 'include_claim_keys[]=repo' -f 'include_claim_keys[]=job_workflow_ref' -F use_immutable_subject=true`.
- An Actions secret `BAO_ADDRESS` holding the OpenBao base URL (passed through `secrets: inherit`). It is a secret so the hostname never appears in public workflow files or logs; it is also the GitHub OIDC audience.
- A role on OpenBao's `jwt/` mount with `bound_audiences` set to that address and `bound_claims` on the caller's immutable `repository_id`, its `workflow_ref` (`sweepies/<repo>/.github/workflows/deploy.yml@refs/heads/main`), this workflow's `job_workflow_ref` (`sweepies/ops-workflows/.github/workflows/alchemy-deploy.yml@refs/heads/main`, or `@<sha>` when the caller pins a commit) and `ref: refs/heads/main`. Its policy reads `kv/data/<repo>` and `cloudflare/creds/<repo>-deploy`.
- A role on OpenBao's `cloudflare/` mount (account-owned tokens, short TTL) whose policies list only the permission groups and resources that repository's stack uses. `CLOUDFLARE_ACCOUNT_ID` and any other provider credentials (for example `RAILWAY_API_TOKEN`) live in the KV path.

Profiles: `bun` installs Bun through mise and runs `bun run deploy`; `npm` runs `npm ci` and `npm exec --no -- alchemy deploy`.

The reusable workflow file is directly under `.github/workflows`, as GitHub requires. The single credential implementation is `.github/actions/openbao-credentials/openbao-credentials.mjs`.
