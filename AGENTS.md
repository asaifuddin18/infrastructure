# AGENTS.md — infrastructure

This repository holds the AWS infrastructure for personal projects.

## Purpose

All AWS resources are defined and created from this repository. Nothing should
be provisioned by hand in the AWS console — if a resource is needed, it belongs
here as code so it is reproducible and reviewable.

## Toolchain

AWS CDK v2 (TypeScript), deployed by a GitHub Action. A single CDK app at the repo
root instantiates stacks from every project directory, so one `npm install` and one
deploy covers the whole account.

## Repository structure

- One sub-directory **per project**, holding that project's stacks under `lib/`.
- A **`common/`** directory for configuration, shared constructs, and helpers used by
  more than one project.

```
infrastructure/
├── bin/infrastructure.ts     # CDK app entry point; registers every project's stacks
├── common/
│   ├── config.ts             # committed per-environment config
│   ├── market-calendar.ts    # US market holidays
│   └── lib/                  # account-wide shared stacks
├── investment-dashboard/
│   └── lib/                  # stacks for the investment dashboard
├── lol-arena-analyzer/
│   ├── lib/                  # stacks for the Arena analyser
│   ├── handlers/             # Lambda entry points (see "Lambda code" below)
│   └── test/                 # CDK assertions
└── .github/workflows/deploy.yml
```

## Configuration

Config lives in `common/config.ts` and is **committed, not environment-driven**. An
AWS account id is not a secret, and hardcoding it means CI needs no repository
variables to deploy correctly — the role ARN it assumes is also committed.

To point this at a different account, edit `SHARED` in `common/config.ts`.

The one credential the workflow does need is a token for **GitHub Packages**, which the
Arena Lambda code is pulled from. Its npm registry requires authentication on every
read, public packages included, so `npm ci` cannot run anonymously. The built-in
`GITHUB_TOKEN` is sufficient provided each `@asaifuddin18/arena-*` package grants this
repository access under its "Manage Actions access" setting; without that, a classic PAT
with `read:packages` has to be stored as a repository secret.

## Lambda code

`investment-dashboard` avoids Lambda entirely, invoking the app's own endpoint through
an EventBridge API destination so its logic lives in one place. Arena cannot do that —
an SQS consumer pinned to one concurrent execution is not an HTTP endpoint — so it has
real Lambda functions here.

The code still lives in the application repository. `lol-arena-analyzer/handlers/*.ts`
are one-line re-exports of published packages, and `NodejsFunction` bundles them with
esbuild. The analysis engine therefore stays next to the web app and MCP server that
will share it, and this repository keeps declaring resources rather than implementing
behaviour.

The cost is a two-step release: bump and publish in
[`LoLArenaAnalyzer`](https://github.com/asaifuddin18/LoLArenaAnalyzer), then
`npm update @asaifuddin18/arena-*` here, commit the lockfile, and open a PR.

## Deployment

- Deployed via the **GitHub Action**, never manually.
- Pull request → `cdk diff` against dev, posted as a PR comment.
- Merge to `main` → `cdk deploy --all` against **prod**.
- `workflow_dispatch` allows a manual `dev` or `prod` deploy.
- The Action authenticates with AWS through **GitHub OIDC** — no long-lived keys.

## Stacks

| Stack | Scope | Contents |
|---|---|---|
| `common-account` | Account-wide, **not** per-env | Vercel + GitHub OIDC providers, CDK deploy role |
| `dashboard-data-<env>` | Per env | Auth table, data table, KMS key, SnapTrade secret |
| `dashboard-vercel-oidc-<env>` | Per env | IAM roles for Vercel deployments |
| `dashboard-snapshot-schedule-<env>` | Per env | Daily 5pm PT schedule invoking the app's snapshot endpoint |
| `arena-data-<env>` | Per env | Arena single table and the raw match archive bucket |
| `arena-compute-<env>` | Per env | Match fetch queue, DLQ, ingest starter and match worker |

The Arena stacks are split on statefulness rather than cohesion. Raw match data is
irreplaceable in practice — Riot's history retention is finite and the API key is rate
limited — so a corpus lost to a bad compute deploy could not simply be refetched. Two
properties in `arena-compute` are load-bearing and easy to lose in a refactor: the
worker's `reservedConcurrentExecutions: 1`, which is the only thing keeping a shared
Riot API key inside its rate limit, and the queue's visibility timeout at six times the
worker timeout. `lol-arena-analyzer/test/` asserts both.

The Riot API key is an SSM `SecureString` rather than a Secrets Manager secret, unlike
the dashboard's credentials. A development key expires every 24 hours, so it is rotated
daily and Parameter Store is free where Secrets Manager bills per secret per month.
CloudFormation cannot create a SecureString with a value, so the parameter is created
out of band and the stacks only grant read on the name.

The schedule stack is only created once `appUrl` is set in `common/config.ts`. It uses
an EventBridge API destination rather than a Lambda so the fetching and ranking logic
lives in exactly one place — the application repository, where it is tested — instead
of being duplicated across repos. The shared secret reaches the connection as a
CloudFormation dynamic reference and is never written into a template.

`common-account` deliberately has no environment suffix. OIDC providers are global per
issuer URL, so a per-environment copy would fail on the second deploy with "provider
already exists". Its template is identical under `--context env=dev` and `env=prod`.

### OIDC providers are account-global

IAM allows exactly **one OIDC provider per issuer URL per account**. This account
already has providers for both GitHub Actions and Vercel, created by earlier projects,
so `createGithubOidcProvider` and `createVercelOidcProvider` are both `false` and the
existing providers are imported by ARN.

Set either to `true` only in an account that has none. Check first:

```bash
aws iam list-open-id-connect-providers
```

When importing, the existing provider's client ID list must contain the audience this
repo needs (`sts.amazonaws.com` for GitHub). A provider missing the audience creates
the role fine but fails at assume-role time.

## Conventions

- Every AWS resource lives in the appropriate project directory or in `common/`.
- Anything shared by multiple projects goes in `common/` rather than being duplicated.
- Environments are `dev` and `prod`, selected with `--context env=<name>`. Stacks are
  named `<project>-<stack>-<env>`.
- **Production resources carry `RemovalPolicy.RETAIN`**; dev resources are
  destroyable. Never relax this for a table holding financial data.
- Prefer fewer, cohesive stacks over many fine-grained ones — cross-stack exports lock
  resources and make refactoring painful.

## First-time account setup

There is a bootstrapping order: the GitHub Action assumes a role that CDK itself
creates, so `common-account` must be deployed once from a workstation before CI can
deploy anything.

```bash
npx cdk bootstrap aws://664658497880/us-east-1
```

```bash
npx cdk deploy common-account
```

After that, everything deploys through the Action with no further configuration.
