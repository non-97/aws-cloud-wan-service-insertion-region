import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import {
  CLOUDWAN,
  CORE_STACK_REGION,
  CURRENT_PHASE,
  REGION_CONFIGS,
  isInspectionAttached,
} from '../lib/config';
import { CoreStack } from '../lib/core-stack';
import { RegionStack } from '../lib/region-stack';

const ACCOUNT = '123456789012';
// RegionStack 単体テスト用のダミー Core Network 参照 (crossRegionReferences を介さない)
const CORE_NETWORK_ID = 'core-network-0123456789abcdef';
const CORE_NETWORK_ARN = `arn:aws:networkmanager::${ACCOUNT}:core-network/${CORE_NETWORK_ID}`;

/** 各スタックは独立した App で synth する (複数 synth によるツリー変更を避ける) */
const coreTemplate = (): Template => {
  const app = new cdk.App();
  const stack = new CoreStack(app, 'CoreStack', {
    env: { account: ACCOUNT, region: CORE_STACK_REGION },
  });
  return Template.fromStack(stack);
};

const regionTemplate = (region: string): Template => {
  const regionConfig = REGION_CONFIGS.find((r) => r.region === region)!;
  const app = new cdk.App();
  const stack = new RegionStack(app, `RegionStack-${region}`, {
    env: { account: ACCOUNT, region },
    regionConfig,
    coreNetworkId: CORE_NETWORK_ID,
    coreNetworkArn: CORE_NETWORK_ARN,
  });
  return Template.fromStack(stack);
};

describe('CoreStack', () => {
  const template = coreTemplate();

  test('Global Network と Core Network が作られる', () => {
    template.resourceCountIs('AWS::NetworkManager::GlobalNetwork', 1);
    template.resourceCountIs('AWS::NetworkManager::CoreNetwork', 1);
  });

  test('スナップショット', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});

describe('RegionStack', () => {
  test('全リージョンに Workload VPC アタッチメント (workload タグ) がある', () => {
    for (const { region } of REGION_CONFIGS) {
      regionTemplate(region).hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
        Tags: [{ Key: CLOUDWAN.tagKey.segment, Value: CLOUDWAN.segment }],
      });
    }
  });

  test('inspectionCidr を持つリージョンのみ Network Firewall を持つ', () => {
    for (const { region, inspectionCidr } of REGION_CONFIGS) {
      regionTemplate(region).resourceCountIs(
        'AWS::NetworkFirewall::Firewall',
        inspectionCidr ? 1 : 0,
      );
    }
  });

  test('アタッチメント総数 = workload(常時) + inspection(現フェーズでアタッチ時)', () => {
    for (const { region } of REGION_CONFIGS) {
      const expected = 1 + (isInspectionAttached(CURRENT_PHASE, region) ? 1 : 0);
      regionTemplate(region).resourceCountIs('AWS::NetworkManager::VpcAttachment', expected);
    }
  });

  test('各リージョンに EIC Endpoint がある', () => {
    for (const { region } of REGION_CONFIGS) {
      regionTemplate(region).resourceCountIs('AWS::EC2::InstanceConnectEndpoint', 1);
    }
  });

  test.each(REGION_CONFIGS.map((r) => r.region))('スナップショット (%s)', (region) => {
    expect(regionTemplate(region).toJSON()).toMatchSnapshot();
  });
});
