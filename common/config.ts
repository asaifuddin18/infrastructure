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
  /** Subject-claim prefixes GitHub may issue for this repository. */
  readonly githubSubjectPrefixes: readonly string[];
  /** Create the GitHub OIDC provider, or import the one the account already has. */
  readonly createGithubOidcProvider: boolean;
  /** Create the Vercel OIDC provider, or import the one the account already has. */
  readonly createVercelOidcProvider: boolean;
  /**
   * Whether the Arena match worker may reserve concurrency, and therefore whether it is
   * allowed to consume its queue at all.
   *
   * Reserving requires the account's Lambda "Concurrent executions" quota to be above 10.
   * AWS refuses to let unreserved concurrency fall below that floor, so at a quota of
   * exactly 10 — where a new account starts — reserving any amount is arithmetically
   * impossible and the deploy fails outright.
   *
   * That reservation is the only thing keeping a shared Riot API key inside its rate
   * limit, because the key is a single global token bucket rather than a per-caller one.
   * So while this is false the worker's event source is disabled too: the queue still
   * accepts work and nothing drains it. That pairing is deliberate — an unthrottled
   * worker is worse than a stopped one, and tying both to one flag means ingestion cannot
   * start unthrottled by accident.
   *
   * Check the quota before turning this on:
   *
   *   aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384
   */
  readonly reserveArenaWorkerConcurrency: boolean;
  /**
   * Public base URL of the deployed dashboard. The daily schedule is only created once
   * this is known, since it posts to the app's cron endpoint.
   */
  readonly appUrl: string | null;
}

const SHARED = {
  account: '664658497880',
  region: 'us-east-1',
  vercelTeamSlug: 'asaifuddin18s-projects',
  vercelProjectName: 'investment-dashboard',
  githubOwner: 'asaifuddin18',
  githubRepo: 'infrastructure',
  // GitHub issues immutable subject claims carrying numeric owner and repo ids for
  // newer repositories, while older ones still use the plain name form. Both are
  // matched exactly so the role keeps working whichever this repository emits.
  githubSubjectPrefixes: [
    'repo:asaifuddin18/infrastructure',
    'repo:asaifuddin18@42976135/infrastructure@1332660767',
  ],
  // Both providers already exist in this account, created by earlier projects.
  createGithubOidcProvider: false,
  createVercelOidcProvider: false,
  // This account's Lambda concurrency quota is still the new-account value of 10, which
  // makes any reservation impossible. An increase to 1000 was requested on 2026-08-25;
  // turn this on once it is granted, and the worker starts draining its queue throttled.
  reserveArenaWorkerConcurrency: false,
} as const;

// Set once the Vercel project exists; until then the daily schedule is not created.
const APP_URLS: Record<EnvironmentName, string | null> = {
  dev: null,
  prod: null,
};

const CONFIGS: Record<EnvironmentName, EnvironmentConfig> = {
  dev: { name: 'dev', ...SHARED, appUrl: APP_URLS.dev },
  prod: { name: 'prod', ...SHARED, appUrl: APP_URLS.prod },
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

/**
 * SSM parameter holding the Riot API key for an environment.
 *
 * Deliberately not a Secrets Manager secret, unlike the dashboard's credentials in this
 * same repository. A Riot development key expires every 24 hours, so this is rotated
 * daily; Parameter Store SecureStrings are free where Secrets Manager bills per secret
 * per month, and the rotation is a one-line CLI call either way.
 *
 * CloudFormation cannot create a SecureString with a value, so the parameter itself is
 * created out of band and the stacks only grant read on this name:
 *
 *   aws ssm put-parameter --name /arena/riot-api-key/prod \
 *     --type SecureString --value RGAPI-... --overwrite
 */
export function riotApiKeyParameterName(env: EnvironmentName): string {
  return `/arena/riot-api-key/${env}`;
}
