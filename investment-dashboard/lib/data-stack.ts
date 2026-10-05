import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../common/config';

export interface DataStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * Persistent state for the investment dashboard: the better-auth session store, the
 * application data table, and the keys and credentials guarding SnapTrade access.
 */
export class DataStack extends Stack {
  public readonly authTable: dynamodb.Table;
  public readonly dataTable: dynamodb.Table;
  public readonly userSecretKey: kms.Key;
  public readonly snaptradeCredentials: secretsmanager.Secret;
  public readonly cronSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { config } = props;
    const isProd = config.name === 'prod';
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // Being retired: a SnapTrade personal API key has no per-user secrets to encrypt, and
    // CloudTrail shows the key was never used. Removing a resource applies the deletion
    // policy already deployed, so this deploy switches it to DESTROY and the next removes
    // the key. exportValue keeps the cross-stack export alive until the Vercel stack has
    // dropped its import; deleting both at once would fail the deploy.
    this.userSecretKey = new kms.Key(this, 'UserSecretKey', {
      alias: `alias/dashboard-user-secret-${config.name}`,
      description: 'Retired: never used, scheduled for removal',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: isProd ? Duration.days(30) : Duration.days(7),
    });
    this.exportValue(this.userSecretKey.keyArn);

    this.authTable = new dynamodb.Table(this, 'AuthTable', {
      tableName: `dashboard-auth-${config.name}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      removalPolicy,
    });

    this.dataTable = new dynamodb.Table(this, 'DataTable', {
      tableName: `dashboard-data-${config.name}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    this.snaptradeCredentials = new secretsmanager.Secret(this, 'SnapTradeCredentials', {
      secretName: `dashboard/snaptrade/${config.name}`,
      description: 'SnapTrade partner clientId and consumerKey',
      removalPolicy,
    });

    this.cronSecret = new secretsmanager.Secret(this, 'CronSecret', {
      secretName: `dashboard/cron-secret/${config.name}`,
      description: 'Shared secret required by the dashboard snapshot endpoint',
      removalPolicy,
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });

    new CfnOutput(this, 'CronSecretArn', { value: this.cronSecret.secretArn });
    new CfnOutput(this, 'AuthTableName', { value: this.authTable.tableName });
    new CfnOutput(this, 'DataTableName', { value: this.dataTable.tableName });
    new CfnOutput(this, 'SnapTradeSecretArn', { value: this.snaptradeCredentials.secretArn });
  }
}
