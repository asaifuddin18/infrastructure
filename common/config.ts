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
}

const SHARED = {
  account: '664658497880',
  region: 'us-east-1',
  vercelTeamSlug: 'asaifuddin18s-projects',
  vercelProjectName: 'investment-dashboard',
  githubOwner: 'asaifuddin18',
  githubRepo: 'infrastructure',
  // Both providers already exist in this account, created by earlier projects.
  createGithubOidcProvider: false,
  createVercelOidcProvider: false,
} as const;

const CONFIGS: Record<EnvironmentName, EnvironmentConfig> = {
  dev: { name: 'dev', ...SHARED },
  prod: { name: 'prod', ...SHARED },
};

/**
 * Returns the configuration for a deployment environment. Values are committed rather
 * than read from the environment: an AWS account id is not a secret, and hardcoding it
 * means CI needs no configuration to deploy correctly.
 */
export function loadConfig(name: EnvironmentName): EnvironmentConfig {
  return CONFIGS[name];
}

/**
 * Builds a stack name namespaced by project and environment so multiple projects and
 * environments can coexist in one AWS account.
 */
export function stackName(project: string, stack: string, env: EnvironmentName): string {
  return `${project}-${stack}-${env}`;
}
