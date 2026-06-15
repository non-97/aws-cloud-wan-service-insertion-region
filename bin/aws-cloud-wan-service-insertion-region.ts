#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CORE_STACK_REGION, REGION_CONFIGS } from '../lib/config';
import { CoreStack } from '../lib/core-stack';
import { RegionStack } from '../lib/region-stack';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

// Cloud WAN の中核 (Global Network / Core Network / Policy)
const coreStack = new CoreStack(app, 'ServiceInsertionCoreStack', {
  env: { account, region: CORE_STACK_REGION },
  crossRegionReferences: true,
});

// 各リージョンの Workload / Inspection VPC
for (const regionConfig of REGION_CONFIGS) {
  const regionStack = new RegionStack(app, `ServiceInsertionRegionStack-${regionConfig.region}`, {
    env: { account, region: regionConfig.region },
    regionConfig,
    coreNetworkId: coreStack.coreNetworkId,
    coreNetworkArn: coreStack.coreNetworkArn,
    crossRegionReferences: true,
  });
  // Core Network / Policy が先に存在している必要がある
  regionStack.addDependency(coreStack);
}
