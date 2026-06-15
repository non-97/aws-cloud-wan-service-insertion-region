import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as networkfirewall from 'aws-cdk-lib/aws-networkfirewall';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { CLOUDWAN } from '../config';

export interface InspectionVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
  /** どのリージョンで検査されたかをログで判別するためのラベル (例: us-east-1) */
  readonly regionLabel: string;
  /**
   * この Inspection VPC を NFG にアタッチするか。
   * false のときはデタッチ状態 (VPC / NFW は維持し、Core Network への参加のみ外す)。
   * 検証フェーズのデタッチシナリオで切り替える。
   */
  readonly attachToNfg: boolean;
}

/**
 * Inspection VPC - Network Firewall による検査 + インターネット出口。
 * send-to (egress) と send-via single-hop (east-west) の両方の検査先となる。
 *
 * Appliance Mode を有効化し、Cloud WAN からの往復トラフィックの対称性を保つ。
 * どのリージョンで検査されたかは、リージョン別の NFW ALERT/FLOW ログ (CloudWatch Logs) で判別する。
 */
export class InspectionVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: InspectionVpcProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 1,
      natGateways: 1,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'Firewall', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'CloudWanAttachment', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });
    this.vpc = vpc;

    const publicSubnet = vpc.selectSubnets({ subnetGroupName: 'Public' }).subnets[0];
    const fwSubnet = vpc.selectSubnets({ subnetGroupName: 'Firewall' }).subnets[0];
    const cloudWanSubnet = vpc.selectSubnets({ subnetGroupName: 'CloudWanAttachment' }).subnets[0];

    // Network Firewall Rule Group: pass-all + ICMP/TLS を alert (検査リージョン判別用)。
    // alert msg にリージョンラベルを埋め込み、ログだけで検査リージョンを一意に特定できるようにする。
    const nfwRuleGroup = new networkfirewall.CfnRuleGroup(this, 'NfwRuleGroup', {
      ruleGroupName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-RuleGroup',
      capacity: 100,
      type: 'STATEFUL',
      ruleGroup: {
        statefulRuleOptions: { ruleOrder: 'STRICT_ORDER' },
        rulesSource: {
          rulesString:
            [
              `pass icmp any any -> any any (alert; sid:2000001; rev:1; msg:"INSPECTED at ${props.regionLabel} - ICMP";)`,
              `pass tls any any -> any any (ssl_state:client_hello; flow:to_server,established; alert; sid:2000002; rev:1; msg:"INSPECTED at ${props.regionLabel} - TLS";)`,
              'pass tcp any any -> any any (flow:not_established; sid:3000001; rev:1;)',
              'pass tcp any any -> any any (flow:established; sid:3000002; rev:1;)',
              'pass udp any any -> any any (sid:3000003; rev:1;)',
            ].join('\n') + '\n',
        },
      },
    });

    const nfwPolicy = new networkfirewall.CfnFirewallPolicy(this, 'NfwPolicy', {
      firewallPolicyName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-Policy',
      firewallPolicy: {
        statelessDefaultActions: ['aws:forward_to_sfe'],
        statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
        statefulDefaultActions: ['aws:drop_established'],
        statefulEngineOptions: { ruleOrder: 'STRICT_ORDER' },
        statefulRuleGroupReferences: [{ priority: 1, resourceArn: nfwRuleGroup.attrRuleGroupArn }],
      },
    });

    const nfw = new networkfirewall.CfnFirewall(this, 'Nfw', {
      firewallName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-Nfw',
      firewallPolicyArn: nfwPolicy.attrFirewallPolicyArn,
      subnetMappings: [{ subnetId: fwSubnet.subnetId }],
      vpcId: vpc.vpcId,
    });

    // ALERT (検査リージョン判別) + FLOW (往復経路の対称性確認) を CloudWatch Logs へ
    const alertLogGroup = new logs.LogGroup(this, 'NfwAlertLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const flowLogGroup = new logs.LogGroup(this, 'NfwFlowLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new networkfirewall.CfnLoggingConfiguration(this, 'NfwLogging', {
      firewallArn: nfw.ref,
      loggingConfiguration: {
        logDestinationConfigs: [
          {
            logDestination: { logGroup: alertLogGroup.logGroupName },
            logDestinationType: 'CloudWatchLogs',
            logType: 'ALERT',
          },
          {
            logDestination: { logGroup: flowLogGroup.logGroupName },
            logDestinationType: 'CloudWatchLogs',
            logType: 'FLOW',
          },
        ],
      },
    });

    // NFW VPC Endpoint ID を抽出 ("az:vpce-xxx" から vpce-xxx を取り出す)
    const fwEndpointId = cdk.Fn.select(1, cdk.Fn.split(':', cdk.Fn.join(',', nfw.attrEndpointIds)));

    // Cloud WAN Attachment Subnet: Core Network からの流入を NFW へ
    new ec2.CfnRoute(this, 'CloudWanSubnetDefaultRoute', {
      routeTableId: cloudWanSubnet.routeTable.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      vpcEndpointId: fwEndpointId,
    });

    // Public Subnet: NAT GW からのリターン (RFC1918) を NFW へ戻す
    new ec2.CfnRoute(this, 'PublicSubnetInternalRoute', {
      routeTableId: publicSubnet.routeTable.routeTableId,
      destinationCidrBlock: '10.0.0.0/8',
      vpcEndpointId: fwEndpointId,
    });

    if (!props.attachToNfg) {
      // デタッチ状態: NFG アタッチメントと Core Network 向けルートを作らない。
      // VPC / NFW / NAT GW は維持されるため、再アタッチ時の差分は最小。
      return;
    }

    // Cloud WAN VPC Attachment (inspection NFG へタグで自動割当 / Appliance Mode 有効)
    const attachment = new networkmanager.CfnVpcAttachment(this, 'CloudWanAttachment', {
      coreNetworkId: props.coreNetworkId,
      vpcArn: vpc.vpcArn,
      subnetArns: [
        cdk.Arn.format(
          { service: 'ec2', resource: 'subnet', resourceName: cloudWanSubnet.subnetId },
          cdk.Stack.of(this),
        ),
      ],
      options: { applianceModeSupport: true },
      tags: [{ key: CLOUDWAN.tagKey.nfg, value: CLOUDWAN.nfg }],
    });

    // Firewall Subnet: 検査後の内部宛 (RFC1918) を Core Network へ
    // (インターネット宛 0.0.0.0/0 → NAT GW は L2 が自動設定)
    const fwInternalRoute = new ec2.CfnRoute(this, 'FwSubnetInternalRoute', {
      routeTableId: fwSubnet.routeTable.routeTableId,
      destinationCidrBlock: '10.0.0.0/8',
      coreNetworkArn: props.coreNetworkArn,
    });
    fwInternalRoute.addDependency(attachment);
  }
}
