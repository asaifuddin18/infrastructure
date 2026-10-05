import { Stack, StackProps, CfnOutput, Duration, TimeZone } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../common/config';
import { DataStack } from './data-stack';

export interface SnapshotScheduleStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly data: DataStack;
  /** Public base URL of the deployed dashboard. */
  readonly appUrl: string;
  /** Topic that emails the account owner when the daily snapshot fails. */
  readonly alertTopic: sns.ITopic;
}

/** Source and detail type of the event the schedule emits and the rule forwards. */
const EVENT_SOURCE = 'investment-dashboard.scheduler';
const EVENT_DETAIL_TYPE = 'DailySnapshotDue';

/**
 * Invokes the dashboard's snapshot endpoint every weekday after after-hours trading
 * closes, without a Lambda, so the fetching and ranking logic lives in exactly one
 * place: the application repository, where it is tested.
 *
 * It takes two hops because neither service does both jobs. EventBridge Scheduler
 * understands time zones but cannot target an API destination; an EventBridge rule can
 * target an API destination but only schedules in UTC, which would drift an hour across
 * every daylight saving change. So the schedule puts an event on a dedicated bus, and a
 * rule on that bus forwards it to the endpoint.
 */
export class SnapshotScheduleStack extends Stack {
  constructor(scope: Construct, id: string, props: SnapshotScheduleStackProps) {
    super(scope, id, props);

    const { config, data, appUrl } = props;

    const deadLetterQueue = new sqs.Queue(this, 'SnapshotDlq', {
      queueName: `dashboard-snapshot-dlq-${config.name}`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const bus = new events.EventBus(this, 'SnapshotBus', {
      eventBusName: `dashboard-snapshot-${config.name}`,
    });

    const connection = new events.Connection(this, 'SnapshotConnection', {
      connectionName: `dashboard-snapshot-${config.name}`,
      description: 'Shared secret header for the dashboard snapshot endpoint',
      authorization: events.Authorization.apiKey('x-cron-secret', data.cronSecret.secretValue),
    });

    const destination = new events.ApiDestination(this, 'SnapshotDestination', {
      apiDestinationName: `dashboard-snapshot-${config.name}`,
      connection,
      endpoint: `${appUrl}/api/cron/snapshot`,
      httpMethod: events.HttpMethod.POST,
      rateLimitPerSecond: 1,
    });

    new events.Rule(this, 'SnapshotRule', {
      ruleName: `dashboard-snapshot-${config.name}`,
      description: 'Forwards the daily snapshot event to the dashboard endpoint',
      eventBus: bus,
      eventPattern: { source: [EVENT_SOURCE], detailType: [EVENT_DETAIL_TYPE] },
      targets: [
        new eventsTargets.ApiDestination(destination, {
          deadLetterQueue,
          retryAttempts: 3,
          maxEventAge: Duration.hours(1),
        }),
      ],
    });

    const schedule = new scheduler.Schedule(this, 'SnapshotSchedule', {
      scheduleName: `dashboard-snapshot-${config.name}`,
      description: 'Daily portfolio snapshot after after-hours trading closes',
      schedule: scheduler.ScheduleExpression.cron({
        minute: '0',
        hour: '17',
        weekDay: 'MON-FRI',
        timeZone: TimeZone.AMERICA_LOS_ANGELES,
      }),
      target: new schedulerTargets.EventBridgePutEvents(
        {
          eventBus: bus,
          source: EVENT_SOURCE,
          detailType: EVENT_DETAIL_TYPE,
          detail: scheduler.ScheduleTargetInput.fromObject({ job: 'daily-snapshot' }),
        },
        { deadLetterQueue, retryAttempts: 3, maxEventAge: Duration.hours(1) },
      ),
    });

    // A message here means a snapshot failed every retry, and that day's report cannot be
    // recreated later. The alarm stays in ALARM while the message remains, so purge the
    // queue once handled or a later failure will not email again.
    const failedSnapshots = new cloudwatch.Alarm(this, 'SnapshotDlqNotEmpty', {
      alarmName: `dashboard-snapshot-dlq-${config.name}`,
      alarmDescription:
        'The daily dashboard snapshot failed after all retries. Inspect the event in ' +
        `dashboard-snapshot-dlq-${config.name} and the Vercel logs for /api/cron/snapshot, ` +
        'then purge the queue so the next failure alerts again.',
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    failedSnapshots.addAlarmAction(new cloudwatchActions.SnsAction(props.alertTopic));

    new CfnOutput(this, 'ScheduleName', { value: schedule.scheduleName });
    new CfnOutput(this, 'EventBusName', { value: bus.eventBusName });
    new CfnOutput(this, 'DeadLetterQueueUrl', { value: deadLetterQueue.queueUrl });
  }
}
