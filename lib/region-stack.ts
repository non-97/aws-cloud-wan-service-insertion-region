import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { CURRENT_PHASE, RegionConfig, isInspectionAttached } from './config';
import { InspectionVpc, WorkloadVpc } from './constructs';

export interface RegionStackProps extends cdk.StackProps {
  /** このリージョンのネットワーク設定 */
  readonly regionConfig: RegionConfig;
  /** Cloud WAN Core Network ID (CoreStack から) */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN (CoreStack から) */
  readonly coreNetworkArn: string;
}

/**
 * リージョン汎用 Stack。全リージョンで Workload VPC を作り、
 * inspectionCidr を持つリージョンでは Inspection VPC も作る。
 * Inspection VPC を NFG にアタッチするかは CURRENT_PHASE に従う。
 */
export class RegionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RegionStackProps) {
    super(scope, id, props);

    const { regionConfig, coreNetworkId, coreNetworkArn } = props;

    new WorkloadVpc(this, 'WorkloadVpc', {
      vpcCidr: regionConfig.workloadCidr,
      coreNetworkId,
      coreNetworkArn,
    });

    if (regionConfig.inspectionCidr) {
      new InspectionVpc(this, 'InspectionVpc', {
        vpcCidr: regionConfig.inspectionCidr,
        coreNetworkId,
        coreNetworkArn,
        regionLabel: regionConfig.region,
        attachToNfg: isInspectionAttached(CURRENT_PHASE, regionConfig.region),
      });
    }
  }
}
