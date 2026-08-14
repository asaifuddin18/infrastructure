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

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { config } = props;
    const isProd = config.name === 'prod';
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.userSecretKey = new kms.Key(this, 'UserSecretKey', {
      alias: `alias/dashboard-user-secret-${config.name}`,
      description: 'Envelope-encrypts per-user SnapTrade userSecret values stored in DynamoDB',
      enableKeyRotation: true,
      removalPolicy,
      pendingWindow: isProd ? Duration.days(30) : Duration.days(7),
    });

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

    new CfnOutput(this, 'AuthTableName', { value: this.authTable.tableName });
    new CfnOutput(this, 'DataTableName', { value: this.dataTable.tableName });
    new CfnOutput(this, 'UserSecretKeyArn', { value: this.userSecretKey.keyArn });
    new CfnOutput(this, 'SnapTradeSecretArn', { value: this.snaptradeCredentials.secretArn });
  }
}
