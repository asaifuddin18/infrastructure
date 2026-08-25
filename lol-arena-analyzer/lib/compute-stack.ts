import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'node:path';
import { Construct } from 'constructs';
import { EnvironmentConfig, riotApiKeyParameterName } from '../../common/config';
import { ArenaDataStack } from './data-stack';

export interface ArenaComputeStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly data: ArenaDataStack;
}

/**
 * How long the worker may spend on one batch. Two Riot calls, a gzip, and a handful of
 * DynamoDB writes per match, times a batch of five, with room for the limiter to pace.
 */
const WORKER_TIMEOUT = Duration.seconds(120);

/**
 * Six times the function timeout, as AWS recommends. Too short and SQS redelivers a
 * message the worker is still successfully processing, producing duplicate work against
 * a rate-limited API.
 */
const QUEUE_VISIBILITY_TIMEOUT = Duration.seconds(WORKER_TIMEOUT.toSeconds() * 6);

/**
 * Small batches keep the blast radius of a rate limit small: when Riot says stop, the
 * worker defers what is left of the batch, and a smaller batch means fewer messages
 * pushed toward the dead letter queue for a reason unrelated to their content.
 */
const WORKER_BATCH_SIZE = 5;

/**
 * The CDK default is to never expire log groups, which is where side-project AWS bills
 * actually come from — long after the compute itself has gone quiet.
 */
const LOG_RETENTION = logs.RetentionDays.TWO_WEEKS;

/**
 * Compute for the Arena ingestion pipeline: the queue, the two Lambdas, and the wiring
 * between them. Everything here is disposable and can be destroyed and redeployed
 * without touching the corpus in `ArenaDataStack`.
 */
export class ArenaComputeStack extends Stack {
  public readonly matchQueue: sqs.Queue;
  public readonly ingestStarter: nodejs.NodejsFunction;
  public readonly matchWorker: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ArenaComputeStackProps) {
    super(scope, id, props);

    const { config, data } = props;
    const parameterName = riotApiKeyParameterName(config.name);

    const deadLetterQueue = new sqs.Queue(this, 'MatchFetchDlq', {
      queueName: `arena-match-fetch-dlq-${config.name}`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    this.matchQueue = new sqs.Queue(this, 'MatchFetchQueue', {
      queueName: `arena-match-fetch-${config.name}`,
      visibilityTimeout: QUEUE_VISIBILITY_TIMEOUT,
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
    });

    /**
     * Reads the Riot API key from SSM over localhost with a cache, so a warm container
     * pays neither a GetParameter call nor a KMS decrypt per invocation.
     *
     * AWS republishes this layer almost daily, so the pinned version goes stale quickly.
     * That is deliberately harmless: the key loader falls back to the SSM SDK when the
     * extension is not answering, so a stale pin costs a little latency, never an outage.
     */
    const parametersExtension = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'ParametersAndSecretsExtension',
      `arn:aws:lambda:${config.region}:177933569100:layer:AWS-Parameters-and-Secrets-Lambda-Extension-Arm64:117`,
    );

    const sharedEnvironment = {
      TABLE_NAME: data.table.tableName,
      QUEUE_URL: this.matchQueue.queueUrl,
      RIOT_API_KEY_PARAM: parameterName,
      POWERTOOLS_LOG_LEVEL: config.name === 'prod' ? 'INFO' : 'DEBUG',
      // The extension caches parameters for this many seconds. A development key is
      // rotated daily, so five minutes of staleness after a rotation is acceptable and a
      // rotation is followed by at most one failed run.
      SSM_PARAMETER_STORE_TTL: '300',
    };

    this.ingestStarter = new nodejs.NodejsFunction(this, 'IngestStarter', {
      functionName: `arena-ingest-starter-${config.name}`,
      description: 'Resolves a Riot ID and enqueues its Arena match history',
      entry: path.join(__dirname, '..', 'handlers', 'ingest-starter.ts'),
      ...commonFunctionProps(),
      // Two cheap Riot calls and a Query; anything longer means something is wrong.
      timeout: Duration.seconds(60),
      memorySize: 512,
      layers: [parametersExtension],
      environment: { ...sharedEnvironment, POWERTOOLS_SERVICE_NAME: 'arena-ingest-starter' },
      logGroup: new logs.LogGroup(this, 'IngestStarterLogs', {
        logGroupName: `/aws/lambda/arena-ingest-starter-${config.name}`,
        retention: LOG_RETENTION,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    this.matchWorker = new nodejs.NodejsFunction(this, 'MatchWorker', {
      functionName: `arena-match-worker-${config.name}`,
      description: 'Fetches, archives and persists one Arena match per message',
      entry: path.join(__dirname, '..', 'handlers', 'match-worker.ts'),
      ...commonFunctionProps(),
      timeout: WORKER_TIMEOUT,
      memorySize: 1024,
      /**
       * The throttle. A Riot API key is a single global token bucket, and the limit is
       * per key rather than per caller — so the instinctive serverless move of letting
       * SQS fan out to N concurrent workers spends the entire budget immediately and
       * earns nothing but 429s and backoff.
       *
       * One worker, pacing itself against the limits it reads from Riot's own response
       * headers, is the simplest correct answer at this throughput. Raising this is only
       * safe alongside a distributed token bucket, and only worth it with a production
       * key that has a meaningfully higher ceiling.
       */
      reservedConcurrentExecutions: 1,
      layers: [parametersExtension],
      environment: {
        ...sharedEnvironment,
        POWERTOOLS_SERVICE_NAME: 'arena-match-worker',
        RAW_BUCKET: data.rawBucket.bucketName,
      },
      logGroup: new logs.LogGroup(this, 'MatchWorkerLogs', {
        logGroupName: `/aws/lambda/arena-match-worker-${config.name}`,
        retention: LOG_RETENTION,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    this.matchWorker.addEventSource(
      new SqsEventSource(this.matchQueue, {
        batchSize: WORKER_BATCH_SIZE,
        // Without this a single poison match forces SQS to redeliver the whole batch, and
        // every already-persisted match in it is reprocessed.
        reportBatchItemFailures: true,
      }),
    );

    data.table.grantReadWriteData(this.ingestStarter);
    data.table.grantReadWriteData(this.matchWorker);
    data.rawBucket.grantReadWrite(this.matchWorker);
    this.matchQueue.grantSendMessages(this.ingestStarter);
    // The worker extends the visibility of its own messages to serve a Riot backoff
    // without burning billed Lambda duration on the wait.
    this.matchQueue.grantConsumeMessages(this.matchWorker);

    for (const fn of [this.ingestStarter, this.matchWorker]) {
      grantParameterRead(fn, config, parameterName);
    }

    /**
     * Anything reaching the dead letter queue means three attempts at one match all
     * failed, which is either a Riot payload this pipeline cannot parse or a bug. Both
     * are worth knowing about immediately, and queue depth is also the earliest signal of
     * abuse once the endpoint is public in M2.
     */
    new cloudwatch.Alarm(this, 'DlqNotEmpty', {
      alarmName: `arena-match-fetch-dlq-${config.name}`,
      alarmDescription: 'Arena match ingestion sent a message to the dead letter queue',
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, 'IngestStarterFunctionName', { value: this.ingestStarter.functionName });
    new CfnOutput(this, 'MatchQueueUrl', { value: this.matchQueue.queueUrl });
    new CfnOutput(this, 'DeadLetterQueueUrl', { value: deadLetterQueue.queueUrl });
    new CfnOutput(this, 'RiotApiKeyParameter', {
      value: parameterName,
      description: 'Populate with: aws ssm put-parameter --type SecureString --overwrite',
    });
  }
}

/**
 * Properties both functions share. ARM64 is cheaper and faster for this workload, and
 * neither function goes in a VPC — DynamoDB, S3, SQS and SSM are all reachable over
 * their public endpoints with IAM auth, and staying out of a VPC keeps cold starts low.
 */
function commonFunctionProps() {
  return {
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    bundling: {
      minify: true,
      sourceMap: true,
      // The handlers and the packages they pull in are ESM; emitting ESM avoids the
      // interop edge cases that come from down-converting to CommonJS.
      format: nodejs.OutputFormat.ESM,
      /**
       * Bundle the AWS SDK rather than using the copy in the runtime. It costs a larger
       * artifact and buys a deployment that behaves identically regardless of which SDK
       * version a given runtime happens to ship.
       */
      bundleAwsSDK: true,
      target: 'node22',
    },
  } as const;
}

/**
 * The Riot API key is read from SSM at runtime, never from an environment variable.
 * Development keys expire every 24 hours; a parameter makes each rotation a one-line CLI
 * call, where an environment variable would make it a redeploy.
 */
function grantParameterRead(
  fn: lambda.Function,
  config: EnvironmentConfig,
  parameterName: string,
): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${config.region}:${config.account}:parameter${parameterName}`,
      ],
    }),
  );

  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [`arn:aws:kms:${config.region}:${config.account}:alias/aws/ssm`],
    }),
  );
}
