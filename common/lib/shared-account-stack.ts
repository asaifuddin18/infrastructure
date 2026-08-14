import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config';

/** Default CDK bootstrap qualifier. Change only if the account was bootstrapped with a custom one. */
const CDK_BOOTSTRAP_QUALIFIER = 'hnb659fds';

/** Issuer host for GitHub Actions OIDC tokens. */
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

export interface SharedAccountStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * Account-wide resources shared by every project and environment. OIDC providers are
 * global per issuer URL, so this stack is deliberately not environment-scoped — a
 * per-environment copy would fail on the second deploy with "provider already exists".
 */
export class SharedAccountStack extends Stack {
  public readonly vercelOidcProvider: iam.IOpenIdConnectProvider;
  public readonly vercelIssuerHost: string;
  public readonly vercelAudience: string;

  constructor(scope: Construct, id: string, props: SharedAccountStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.vercelIssuerHost = `oidc.vercel.com/${config.vercelTeamSlug}`;
    this.vercelAudience = `https://vercel.com/${config.vercelTeamSlug}`;

    this.vercelOidcProvider = this.resolveProvider(
      'Vercel',
      this.vercelIssuerHost,
      [this.vercelAudience],
      config.createVercelOidcProvider,
      config,
    );

    new CfnOutput(this, 'VercelOidcProviderArn', {
      value: this.vercelOidcProvider.openIdConnectProviderArn,
    });

    const githubProvider = this.resolveProvider(
      'Github',
      GITHUB_OIDC_HOST,
      ['sts.amazonaws.com'],
      config.createGithubOidcProvider,
      config,
    );

    const deployRole = this.createGithubDeployRole(config, githubProvider);
    new CfnOutput(this, 'GithubDeployRoleArn', {
      value: deployRole.roleArn,
      description: 'Set as the AWS_DEPLOY_ROLE_ARN repository variable in GitHub',
    });
  }

  /**
   * Returns the OIDC provider for an issuer, either creating it or importing the one
   * the account already has. IAM permits a single provider per issuer URL, so a second
   * create attempt fails with EntityAlreadyExistsException.
   */
  private resolveProvider(
    id: string,
    issuerHost: string,
    clientIds: string[],
    create: boolean,
    config: EnvironmentConfig,
  ): iam.IOpenIdConnectProvider {
    if (create) {
      return new iam.OpenIdConnectProvider(this, `${id}OidcProvider`, {
        url: `https://${issuerHost}`,
        clientIds,
      });
    }
    return iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      `${id}OidcProviderImported`,
      `arn:aws:iam::${config.account}:oidc-provider/${issuerHost}`,
    );
  }

  /**
   * Creates the role the GitHub Action assumes to run CDK. Rather than granting
   * administrator access, it may only assume the CDK bootstrap roles, which are
   * themselves scoped to what CloudFormation needs.
   */
  private createGithubDeployRole(
    config: EnvironmentConfig,
    provider: iam.IOpenIdConnectProvider,
  ): iam.Role {
    const repo = `${config.githubOwner}/${config.githubRepo}`;

    const role = new iam.Role(this, 'GithubDeployRole', {
      roleName: `github-deploy-${config.githubRepo}`,
      description: `CDK deployments from ${repo}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
        },
        StringLike: {
          [`${GITHUB_OIDC_HOST}:sub`]: config.githubSubjectPrefixes.flatMap((prefix) => [
            `${prefix}:ref:refs/heads/main`,
            `${prefix}:pull_request`,
            `${prefix}:environment:*`,
          ]),
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${config.account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-*-${config.account}-${config.region}`,
        ],
      }),
    );

    return role;
  }
}
