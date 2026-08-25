import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../common/config';

export interface ArenaDataStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * Persistent state for the Arena analyser: the single table and the raw match archive.
 *
 * These live apart from the compute stack because raw match data is irreplaceable in
 * practice. Riot's match history retention is finite and the API key is rate limited, so
 * a corpus lost to a bad deploy could not simply be refetched — it would be gone. A stack
 * holding nothing but data is a stack a compute rollback cannot take with it.
 */
export class ArenaDataStack extends Stack {
  public readonly table: dynamodb.Table;
  public readonly rawBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ArenaDataStackProps) {
    super(scope, id, props);

    const { config } = props;
    const isProd = config.name === 'prod';
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    /**
     * One table, keyed so that a player's match list is a single Query returning
     * newest-first with no GSI: the sort key embeds the game's creation time subtracted
     * from a fixed ceiling and zero padded, which inverts the ordering.
     */
    this.table = new dynamodb.Table(this, 'MainTable', {
      tableName: `arena-main-${config.name}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Used by the per-IP and global ingestion caps that arrive with the public
      // endpoint in M2, so their counters expire without a sweeper.
      timeToLiveAttribute: 'ttl',
      removalPolicy,
    });

    /**
     * Raw summaries and timelines, gzipped. Timelines run to hundreds of kilobytes —
     * well past DynamoDB's 400KB item limit — and compress roughly tenfold.
     *
     * Versioning is off deliberately: these objects are written once and never updated,
     * so versions would only accumulate cost. Intelligent-Tiering handles the fact that
     * a match is read constantly the week it is played and almost never afterwards.
     */
    this.rawBucket = new s3.Bucket(this, 'RawBucket', {
      bucketName: `arena-raw-${config.account}-${config.region}-${config.name}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [
        {
          id: 'intelligent-tiering',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: Duration.days(30),
            },
          ],
        },
      ],
      removalPolicy,
      // Only meaningful in dev, where the policy is DESTROY. A retained bucket is never
      // emptied by CloudFormation.
      autoDeleteObjects: !isProd,
    });

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'RawBucketName', { value: this.rawBucket.bucketName });
  }
}
