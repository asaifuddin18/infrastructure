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
│   ├── config.ts             # env-var driven deployment config
│   └── market-calendar.ts    # US market holidays
├── investment-dashboard/
│   └── lib/                  # stacks for the investment dashboard
└── .github/workflows/deploy.yml
```

## Deployment

- Deployed via the **GitHub Action**, never manually.
- Pull request → `cdk diff` (posted as a PR comment). Merge to `main` → `cdk deploy`
  against **prod**. `workflow_dispatch` allows a manual `dev` deploy.
- The Action authenticates with AWS through **GitHub OIDC** — there are no long-lived
  access keys anywhere in this repo.

### Required GitHub repository variables

| Variable | Purpose |
|---|---|
| `AWS_ACCOUNT_ID` | Target AWS account |
| `AWS_REGION` | Target region |
| `AWS_DEPLOY_ROLE_ARN` | Role the Action assumes via OIDC (output of `common-account`) |
| `VERCEL_TEAM_SLUG` | Builds the Vercel OIDC issuer URL |
| `VERCEL_PROJECT_NAME` | Scopes the Vercel role trust policy |
| `SIGNUP_ALLOWLIST` | Comma-separated Google emails permitted to sign up |

`REPO_OWNER` and `REPO_NAME` are derived from the GitHub context automatically — they
are not repository variables, and must not be named with a `GITHUB_` prefix because
Actions reserves it.

`common/config.ts` fails fast if any required variable is missing, so a
misconfigured deploy stops before touching AWS.

Locally, the same values are read from a gitignored `infrastructure/.env`.

### OIDC providers are account-global

IAM allows exactly **one OIDC provider per issuer URL per account**. If another
project already created one (very common for `token.actions.githubusercontent.com`),
creating a second fails with `EntityAlreadyExistsException`.

Two opt-in flags control this, both defaulting to `false` (import the existing one):

| Variable | Set to `true` only when |
|---|---|
| `CREATE_GITHUB_OIDC_PROVIDER` | The account has no GitHub Actions OIDC provider yet |
| `CREATE_VERCEL_OIDC_PROVIDER` | The account has no provider for your Vercel team slug |

Check what already exists before deploying:

```bash
aws iam list-open-id-connect-providers
```

When importing, confirm the existing provider's client ID list contains the audience
this repo needs (`sts.amazonaws.com` for GitHub). A provider missing the audience will
create the role fine but fail at assume-role time.

## Conventions

- Every AWS resource lives in the appropriate project directory or in `common/`.
- Anything shared by multiple projects goes in `common/` rather than being duplicated.
- Environments are `dev` and `prod`, selected with `--context env=<name>`. Stacks are
  named `<project>-<stack>-<env>`.
- **Production resources carry `RemovalPolicy.RETAIN`**; dev resources are
  destroyable. Never relax this for a table holding financial data.
- Prefer fewer, cohesive stacks over many fine-grained ones — cross-stack exports lock
  resources and make refactoring painful.

## Stacks

| Stack | Scope | Contents |
|---|---|---|
| `common-account` | Account-wide, **not** per-env | Vercel + GitHub OIDC providers, CDK deploy role |
| `dashboard-data-<env>` | Per env | Auth table, data table, KMS key, SnapTrade secret |
| `dashboard-vercel-oidc-<env>` | Per env | IAM roles for Vercel deployments |

`common-account` deliberately has no environment suffix. OIDC providers are global per
issuer URL, so a per-environment copy would fail on the second deploy with "provider
already exists". Its template is identical under `--context env=dev` and `env=prod`.

## First-time account setup

There is a bootstrapping order here: the GitHub Action assumes a role that CDK itself
creates, so `common-account` must be deployed once from a workstation before CI can
deploy anything.

```bash
npx cdk bootstrap aws://<account-id>/<region>
```

```bash
npx cdk deploy common-account
```

Then set the `GithubDeployRoleArn` output as the `AWS_DEPLOY_ROLE_ARN` repository
variable. After that, everything deploys through the Action.
