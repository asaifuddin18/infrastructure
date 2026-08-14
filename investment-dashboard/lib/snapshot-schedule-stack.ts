import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../common/config';
import { DataStack } from './data-stack';

export interface SnapshotScheduleStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly data: DataStack;
  /** Public base URL of the deployed dashboard. */
  readonly appUrl: string;
}

/**
 * Invokes the dashboard's snapshot endpoint every weekday after after-hours trading
 * closes. An API destination is used rather than a Lambda so the fetching and ranking
 * logic lives in exactly one place, in the application repository where it is tested.
 */
export class SnapshotScheduleStack extends Stack {
  constructor(scope: Construct, id: string, props: SnapshotScheduleStackProps) {
    super(scope, id, props);

    const { config, data, appUrl } = props;

    const connection = new events.CfnConnection(this, 'SnapshotConnection', {
      name: `dashboard-snapshot-${config.name}`,
      authorizationType: 'API_KEY',
      description: 'Shared secret header for the dashboard snapshot endpoint',
      authParameters: {
        apiKeyAuthParameters: {
          apiKeyName: 'x-cron-secret',
          apiKeyValue: data.cronSecret.secretValue.unsafeUnwrap(),
        },
      },
    });

    const destination = new events.CfnApiDestination(this, 'SnapshotDestination', {
      name: `dashboard-snapshot-${config.name}`,
      connectionArn: connection.attrArn,
      httpMethod: 'POST',
      invocationEndpoint: `${appUrl}/api/cron/snapshot`,
      invocationRateLimitPerSecond: 1,
    });

    const deadLetterQueue = new sqs.Queue(this, 'SnapshotDlq', {
      queueName: `dashboard-snapshot-dlq-${config.name}`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const role = new iam.Role(this, 'SnapshotSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Lets EventBridge Scheduler invoke the dashboard snapshot endpoint',
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:InvokeApiDestination'],
        resources: [destination.attrArn],
      }),
    );
    deadLetterQueue.grantSendMessages(role);

    const schedule = new scheduler.CfnSchedule(this, 'SnapshotSchedule', {
      name: `dashboard-snapshot-${config.name}`,
      description: 'Daily portfolio snapshot after after-hours trading closes',
      flexibleTimeWindow: { mode: 'OFF' },
      // 5pm Pacific is the end of after-hours trading. Naming the zone rather than
      // fixing a UTC offset keeps it correct across daylight saving transitions.
      scheduleExpression: 'cron(0 17 ? * MON-FRI *)',
      scheduleExpressionTimezone: 'America/Los_Angeles',
      state: 'ENABLED',
      target: {
        arn: destination.attrArn,
        roleArn: role.roleArn,
        deadLetterConfig: { arn: deadLetterQueue.queueArn },
        retryPolicy: { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 3600 },
      },
    });

    new CfnOutput(this, 'ScheduleName', { value: schedule.name! });
    new CfnOutput(this, 'DeadLetterQueueUrl', { value: deadLetterQueue.queueUrl });
  }
}
