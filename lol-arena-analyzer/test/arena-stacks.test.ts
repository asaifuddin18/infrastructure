import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { loadConfig, EnvironmentConfig, EnvironmentName } from '../../common/config';
import { ArenaDataStack } from '../lib/data-stack';
import { ArenaComputeStack } from '../lib/compute-stack';

/**
 * These assertions exist for a small number of properties that are load-bearing and
 * silently lost in a refactor. Each one, if dropped, fails in a way that looks like
 * something else: a deleted corpus looks like a bad migration, and a missing concurrency
 * cap looks like Riot rate limiting the account for no reason.
 */

interface SynthResult {
  data: Template;
  compute: Template;
}

/**
 * Synthesising the compute stack runs esbuild over both handlers, which dominates the
 * runtime of this suite. The templates are immutable once produced, so each environment
 * is built once and shared.
 */
const cache = new Map<string, SynthResult>();

function synth(env: EnvironmentName, overrides: Partial<EnvironmentConfig> = {}): SynthResult {
  const key = `${env}:${JSON.stringify(overrides)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const app = new cdk.App();
  const config = { ...loadConfig(env), ...overrides };
  const stackEnv = { account: config.account, region: config.region };

  const data = new ArenaDataStack(app, `arena-data-${env}`, { env: stackEnv, config });
  const compute = new ArenaComputeStack(app, `arena-compute-${env}`, {
    env: stackEnv,
    config,
    data,
  });

  const result: SynthResult = {
    data: Template.fromStack(data),
    compute: Template.fromStack(compute),
  };
  cache.set(key, result);
  return result;
}

/** The account quota currently forbids a reservation, so both branches are pinned here. */
const THROTTLED: Partial<EnvironmentConfig> = { reserveArenaWorkerConcurrency: true };
const UNTHROTTLED: Partial<EnvironmentConfig> = { reserveArenaWorkerConcurrency: false };

describe('ArenaDataStack', () => {
  it('retains the table and the archive in production', () => {
    // Raw match data is irreplaceable in practice: Riot's history retention is finite and
    // the API key is rate limited, so a corpus lost to a bad deploy is simply gone.
    const { data } = synth('prod');

    data.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    data.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('leaves dev destroyable', () => {
    const { data } = synth('dev');

    data.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
    data.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  });

  it('keeps point-in-time recovery on', () => {
    synth('prod').data.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  it('blocks all public access to the archive', () => {
    synth('prod').data.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('uses a composite key so one table serves every access pattern', () => {
    synth('prod').data.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });
});

describe('ArenaComputeStack', () => {
  it('pins the match worker to a single concurrent execution when it may reserve', () => {
    // The throttle. A Riot API key is one global token bucket shared by every caller, so
    // letting SQS fan out spends the whole budget instantly and earns only 429s.
    const { compute } = synth('prod', THROTTLED);

    compute.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'arena-match-worker-prod',
      ReservedConcurrentExecutions: 1,
    });
    compute.hasResourceProperties('AWS::Lambda::EventSourceMapping', { Enabled: true });
  });

  it('stops the worker rather than running it unthrottled', () => {
    // An account whose Lambda concurrency quota is 10 cannot reserve anything at all.
    // Deploying the worker anyway with the queue live would let SQS scale it out against
    // a shared, rate-limited key, so the event source is held closed instead. Enqueued
    // matches wait; they are not lost.
    const { compute } = synth('prod', UNTHROTTLED);

    const workers = compute.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'arena-match-worker-prod' },
    });
    const [worker] = Object.values(workers);
    expect(worker.Properties.ReservedConcurrentExecutions).toBeUndefined();

    compute.hasResourceProperties('AWS::Lambda::EventSourceMapping', { Enabled: false });
  });

  it('does not cap concurrency on the starter, which makes no expensive calls', () => {
    const { compute } = synth('prod', THROTTLED);

    const starters = compute.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'arena-ingest-starter-prod' },
    });
    const [starter] = Object.values(starters);
    expect(starter.Properties.ReservedConcurrentExecutions).toBeUndefined();
  });

  it('sends repeatedly failing matches to a dead letter queue', () => {
    synth('prod', THROTTLED).compute.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'arena-match-fetch-prod',
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('gives the queue a visibility timeout six times the worker timeout', () => {
    // Too short and SQS redelivers a message the worker is still processing, producing
    // duplicate work against a rate-limited API.
    const { compute } = synth('prod', THROTTLED);

    compute.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'arena-match-fetch-prod',
      VisibilityTimeout: 720,
    });
    compute.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'arena-match-worker-prod',
      Timeout: 120,
    });
  });

  it('reports partial batch failures', () => {
    // Without this one poison match forces redelivery of its entire batch.
    synth('prod', THROTTLED).compute.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      BatchSize: 5,
    });
  });

  it('runs both functions on ARM64', () => {
    const { compute } = synth('prod', THROTTLED);
    const functions = compute.findResources('AWS::Lambda::Function');

    expect(Object.keys(functions)).toHaveLength(2);
    for (const fn of Object.values(functions)) {
      expect(fn.Properties.Architectures).toEqual(['arm64']);
    }
  });

  it('sets an explicit log retention on every log group', () => {
    // The CDK default is to never expire, which is where side-project AWS bills come from.
    const { compute } = synth('prod', THROTTLED);
    const groups = compute.findResources('AWS::Logs::LogGroup');

    expect(Object.keys(groups)).toHaveLength(2);
    for (const group of Object.values(groups)) {
      expect(group.Properties.RetentionInDays).toBe(14);
    }
  });

  it('never puts the Riot API key in an environment variable', () => {
    // Development keys expire daily; the functions read the key from SSM at runtime so a
    // rotation is a CLI call rather than a redeploy.
    const { compute } = synth('prod', THROTTLED);

    for (const fn of Object.values(compute.findResources('AWS::Lambda::Function'))) {
      const variables: Record<string, unknown> = fn.Properties.Environment?.Variables ?? {};
      expect(variables.RIOT_API_KEY_PARAM).toBe('/arena/riot-api-key/prod');

      for (const value of Object.values(variables)) {
        expect(String(value)).not.toMatch(/^RGAPI-/);
      }
    }
  });

  it('scopes parameter read access to the arena key alone', () => {
    synth('prod', THROTTLED).compute.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ssm:GetParameter',
            Resource: 'arn:aws:ssm:us-east-1:664658497880:parameter/arena/riot-api-key/prod',
          }),
        ]),
      }),
    });
  });

  it('alarms as soon as anything lands in the dead letter queue', () => {
    synth('prod', THROTTLED).compute.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'arena-match-fetch-dlq-prod',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 1,
    });
  });

  it('keeps the data stores out of the compute stack entirely', () => {
    // A bad compute deploy must never be able to take the corpus with it.
    const { compute } = synth('prod', THROTTLED);

    expect(Object.keys(compute.findResources('AWS::DynamoDB::Table'))).toHaveLength(0);
    expect(Object.keys(compute.findResources('AWS::S3::Bucket'))).toHaveLength(0);
  });
});
