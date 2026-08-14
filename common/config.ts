/**
 * Deployment environment name. Each environment gets its own isolated set of stacks.
 */
export type EnvironmentName = 'dev' | 'prod';

/**
 * Resolved configuration for a single deployment environment.
 */
export interface EnvironmentConfig {
  readonly name: EnvironmentName;
  readonly account: string;
  readonly region: string;
  /** Vercel team slug, used to build the OIDC issuer URL. */
  readonly vercelTeamSlug: string;
  /** Vercel project name, used to scope the OIDC role trust policy. */
  readonly vercelProjectName: string;
  /** GitHub account owning the infrastructure repository. */
  readonly githubOwner: string;
  /** Infrastructure repository name, used to scope the deploy role trust policy. */
  readonly githubRepo: string;
  /** Create the GitHub OIDC provider, or import the one the account already has. */
  readonly createGithubOidcProvider: boolean;
  /** Create the Vercel OIDC provider, or import the one the account already has. */
  readonly createVercelOidcProvider: boolean;
  /** Google account emails permitted to sign up. Empty disables the allowlist gate. */
  readonly signupAllowlist: readonly string[];
}

const REQUIRED_ENV_VARS = [
  'CDK_DEPLOY_ACCOUNT',
  'CDK_DEPLOY_REGION',
  'VERCEL_TEAM_SLUG',
  'VERCEL_PROJECT_NAME',
  'REPO_OWNER',
  'REPO_NAME',
] as const;

/**
 * Parses a boolean environment variable, defaulting to false so provider creation is
 * opt-in. Importing a provider that does not exist fails far more clearly than
 * colliding with one that does.
 */
function isTrue(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

/**
 * Reads deployment configuration from environment variables, failing fast when any
 * required value is absent. Keeping account ids out of source control avoids
 * committing infrastructure identifiers to a public repository.
 */
export function loadConfig(name: EnvironmentName): EnvironmentConfig {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'See infrastructure/README.md for the expected deployment configuration.',
    );
  }

  const allowlist = (process.env.SIGNUP_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  return {
    name,
    account: process.env.CDK_DEPLOY_ACCOUNT!,
    region: process.env.CDK_DEPLOY_REGION!,
    vercelTeamSlug: process.env.VERCEL_TEAM_SLUG!,
    vercelProjectName: process.env.VERCEL_PROJECT_NAME!,
    githubOwner: process.env.REPO_OWNER!,
    githubRepo: process.env.REPO_NAME!,
    createGithubOidcProvider: isTrue(process.env.CREATE_GITHUB_OIDC_PROVIDER),
    createVercelOidcProvider: isTrue(process.env.CREATE_VERCEL_OIDC_PROVIDER),
    signupAllowlist: allowlist,
  };
}

/**
 * Builds a stack name namespaced by project and environment so multiple projects and
 * environments can coexist in one AWS account.
 */
export function stackName(project: string, stack: string, env: EnvironmentName): string {
  return `${project}-${stack}-${env}`;
}
