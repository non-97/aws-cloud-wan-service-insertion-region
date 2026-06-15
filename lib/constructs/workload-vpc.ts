import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { CLOUDWAN, RFC1918_CIDRS } from '../config';

export interface WorkloadVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
}

/**
 * Workload VPC - 検証トラフィックの送信元 / 送信先。
 * テスト用 EC2 (ping / curl 実行) と EC2 Instance Connect Endpoint を持つ。
 * 0.0.0.0/0 を Core Network へ向け、東西通信 (send-via) もインターネット (send-to) も
 * Service Insertion の判断に委ねる。
 *
 * EIC Endpoint を使うのは、override による通信断 (タイムアウト) のフェーズでも
 * Core Network 経路に依存せず EC2 を操作できるようにするため。
 */
export class WorkloadVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: WorkloadVpcProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'Workload', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
        { name: 'CloudWanAttachment', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    this.vpc = vpc;

    const workloadSubnet = vpc.selectSubnets({ subnetGroupName: 'Workload' }).subnets[0];
    const cloudWanSubnet = vpc.selectSubnets({ subnetGroupName: 'CloudWanAttachment' }).subnets[0];

    // テスト用 EC2 の SG: 他 VPC からの ICMP/任意トラフィックを受けるため RFC1918 を許可
    const ec2Sg = new ec2.SecurityGroup(this, 'Ec2Sg', {
      vpc,
      description: 'for workload test EC2',
    });
    for (const cidr of RFC1918_CIDRS) {
      ec2Sg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.allTraffic());
    }

    new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnets: [workloadSubnet] },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
      ),
      securityGroup: ec2Sg,
    });

    // EC2 Instance Connect Endpoint (Core Network 経路に依存しないアクセス手段)
    const eicSg = new ec2.SecurityGroup(this, 'EicSg', {
      vpc,
      description: 'for EIC Endpoint',
      allowAllOutbound: false,
    });
    eicSg.addEgressRule(ec2.Peer.ipv4(props.vpcCidr), ec2.Port.tcp(22));

    new ec2.CfnInstanceConnectEndpoint(this, 'EicEndpoint', {
      subnetId: workloadSubnet.subnetId,
      securityGroupIds: [eicSg.securityGroupId],
    });

    // Cloud WAN VPC Attachment (workload セグメントへタグで自動割当)
    const attachment = new networkmanager.CfnVpcAttachment(this, 'CloudWanAttachment', {
      coreNetworkId: props.coreNetworkId,
      vpcArn: vpc.vpcArn,
      subnetArns: [
        cdk.Arn.format(
          { service: 'ec2', resource: 'subnet', resourceName: cloudWanSubnet.subnetId },
          cdk.Stack.of(this),
        ),
      ],
      tags: [{ key: CLOUDWAN.tagKey.segment, value: CLOUDWAN.segment }],
    });

    // Workload Subnet: 全トラフィックを Core Network へ (east-west も internet も)
    const defaultRoute = new ec2.CfnRoute(this, 'WorkloadSubnetDefaultRoute', {
      routeTableId: workloadSubnet.routeTable.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      coreNetworkArn: props.coreNetworkArn,
    });
    defaultRoute.addDependency(attachment);
  }
}
