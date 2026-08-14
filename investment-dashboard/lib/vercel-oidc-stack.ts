import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../common/config';
import { DataStack } from './data-stack';

export interface VercelOidcStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly data: DataStack;
  readonly oidcProvider: iam.IOpenIdConnectProvider;
  readonly issuerHost: string;
  readonly audience: string;
}

/**
 * Vercel deployment environments that may assume an AWS role. Preview and development
 * deployments are pinned to the dev environment's data so they can never read
 * production holdings.
 */
type VercelEnvironment = 'production' | 'preview' | 'development';

/**
 * Grants Vercel deployments short-lived AWS credentials through OIDC federation,
 * removing the need for static access keys in the frontend project.
 */
export class VercelOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: VercelOidcStackProps) {
    super(scope, id, props);

    const { config } = props;

    const vercelEnvironments: VercelEnvironment[] =
      config.name === 'prod' ? ['production'] : ['preview', 'development'];

    for (const vercelEnv of vercelEnvironments) {
      const role = this.createRole(props, vercelEnv);
      new CfnOutput(this, `VercelRoleArn${capitalize(vercelEnv)}`, {
        value: role.roleArn,
        description: `Set as AWS_ROLE_ARN in the Vercel ${vercelEnv} environment`,
      });
    }
  }

  /**
   * Builds one least-privilege role scoped to a single Vercel environment. The trust
   * policy pins both the audience and the exact subject claim, so a preview deployment
   * cannot assume the production role even within the same team.
   */
  private createRole(props: VercelOidcStackProps, vercelEnv: VercelEnvironment): iam.Role {
    const { config, data, oidcProvider, issuerHost, audience } = props;

    const subject = `owner:${config.vercelTeamSlug}:project:${config.vercelProjectName}:environment:${vercelEnv}`;

    const role = new iam.Role(this, `VercelRole${capitalize(vercelEnv)}`, {
      roleName: `dashboard-vercel-${vercelEnv}-${config.name}`,
      description: `Vercel ${vercelEnv} deployments of ${config.vercelProjectName}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          [`${issuerHost}:aud`]: audience,
          [`${issuerHost}:sub`]: subject,
        },
      }),
    });

    data.authTable.grantReadWriteData(role);
    data.dataTable.grantReadWriteData(role);
    data.userSecretKey.grantEncryptDecrypt(role);
    data.snaptradeCredentials.grantRead(role);

    return role;
  }
}

/**
 * Uppercases the first character so environment names can be used in CDK construct ids.
 */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
