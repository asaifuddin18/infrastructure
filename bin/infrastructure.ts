#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EnvironmentName, loadConfig, stackName } from '../common/config';
import { SharedAccountStack } from '../common/lib/shared-account-stack';
import { DataStack } from '../investment-dashboard/lib/data-stack';
import { VercelOidcStack } from '../investment-dashboard/lib/vercel-oidc-stack';
import { SnapshotScheduleStack } from '../investment-dashboard/lib/snapshot-schedule-stack';
import { ArenaDataStack } from '../lol-arena-analyzer/lib/data-stack';
import { ArenaComputeStack } from '../lol-arena-analyzer/lib/compute-stack';

const app = new cdk.App();

const envName = (app.node.tryGetContext('env') ?? process.env.DEPLOY_ENV ?? 'dev') as EnvironmentName;
if (envName !== 'dev' && envName !== 'prod') {
  throw new Error(`Unknown environment "${envName}". Expected "dev" or "prod".`);
}

const config = loadConfig(envName);
const env = { account: config.account, region: config.region };

const shared = new SharedAccountStack(app, 'common-account', {
  env,
  config,
  description: 'Account-wide shared resources: Vercel and GitHub OIDC providers, CDK deploy role',
});

const data = new DataStack(app, stackName('dashboard', 'data', envName), {
  env,
  config,
  description: 'Investment dashboard persistence: auth store, app data, KMS key, SnapTrade credentials',
});

const vercelOidc = new VercelOidcStack(app, stackName('dashboard', 'vercel-oidc', envName), {
  env,
  config,
  data,
  oidcProvider: shared.vercelOidcProvider,
  issuerHost: shared.vercelIssuerHost,
  audience: shared.vercelAudience,
  description: 'IAM roles assumed by Vercel deployments via OIDC federation',
});

const scheduleStack = config.appUrl
  ? new SnapshotScheduleStack(app, stackName('dashboard', 'snapshot-schedule', envName), {
      env,
      config,
      data,
      appUrl: config.appUrl,
      description: 'Daily schedule invoking the dashboard snapshot endpoint',
    })
  : undefined;

const arenaData = new ArenaDataStack(app, stackName('arena', 'data', envName), {
  env,
  config,
  description: 'Arena analyser persistence: single table and the raw match archive',
});

const arenaCompute = new ArenaComputeStack(app, stackName('arena', 'compute', envName), {
  env,
  config,
  data: arenaData,
  description: 'Arena match ingestion: queue, starter and rate-limited worker',
});

cdk.Tags.of(app).add('ManagedBy', 'cdk');

cdk.Tags.of(shared).add('Project', 'shared');
cdk.Tags.of(shared).add('Environment', 'shared');

for (const stack of [data, vercelOidc, scheduleStack].filter((s) => s !== undefined)) {
  cdk.Tags.of(stack).add('Project', 'investment-dashboard');
  cdk.Tags.of(stack).add('Environment', envName);
}

for (const stack of [arenaData, arenaCompute]) {
  cdk.Tags.of(stack).add('Project', 'lol-arena-analyzer');
  cdk.Tags.of(stack).add('Environment', envName);
}
