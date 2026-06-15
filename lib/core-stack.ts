import * as cdk from 'aws-cdk-lib/core';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { CURRENT_PHASE } from './config';
import { buildCoreNetworkPolicy } from './core-network-policy';

/**
 * Cloud WAN の中核 (Global Network / Core Network + Policy) を定義する Stack。
 * Core Network Policy は CURRENT_PHASE から生成するため、フェーズ遷移時の
 * with-edge-overrides の変更は本 Stack の更新に閉じる。
 *
 * coreNetworkId / coreNetworkArn を公開し、各 RegionStack が
 * crossRegionReferences 経由で参照する。
 */
export class CoreStack extends cdk.Stack {
  public readonly coreNetworkId: string;
  public readonly coreNetworkArn: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const globalNetwork = new networkmanager.CfnGlobalNetwork(this, 'GlobalNetwork', {
      description: 'Service Insertion verification global network',
    });

    const coreNetwork = new networkmanager.CfnCoreNetwork(this, 'CoreNetwork', {
      description: 'Service Insertion verification core network',
      globalNetworkId: globalNetwork.attrId,
      policyDocument: buildCoreNetworkPolicy(CURRENT_PHASE),
    });

    this.coreNetworkId = coreNetwork.attrCoreNetworkId;
    this.coreNetworkArn = coreNetwork.attrCoreNetworkArn;
  }
}
