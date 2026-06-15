/**
 * Core Network Policy ドキュメントをフェーズから生成する純関数。
 *
 * Service Insertion の挙動を検証するための最小ポリシー:
 * - segment   : workload (全 Workload VPC を収容)
 * - NFG       : inspection (Inspection VPC を収容)
 * - send-to   : workload からインターネット向け (0.0.0.0/0) を NFG 経由に
 * - send-via  : workload 同士の east-west を single-hop で NFG 経由に
 * - with-edge-overrides : フェーズに応じて send-to / send-via に付与
 */

import { CLOUDWAN, Phase, REGION_CONFIGS, edgeOverrides } from './config';

/**
 * フェーズに対応する Core Network Policy ドキュメントを返す。
 * CfnCoreNetwork の policyDocument にそのまま渡す。
 */
export const buildCoreNetworkPolicy = (phase: Phase): Record<string, unknown> => {
  const overrides = edgeOverrides(phase);

  // send-to / send-via 共通の via ブロック。override フェーズのみ with-edge-overrides を含める。
  const via = {
    'network-function-groups': [CLOUDWAN.nfg],
    ...(overrides ? { 'with-edge-overrides': overrides } : {}),
  };

  return {
    // 2025.11: 最新版。route policies / BGP community サポートを含むが、
    // 本検証は VPC アタッチメントのみで BGP 非使用のため Service Insertion 部分に差はない。
    version: '2025.11',
    'core-network-configuration': {
      'asn-ranges': [CLOUDWAN.asnRange],
      'edge-locations': REGION_CONFIGS.map((r) => ({ location: r.region, asn: r.asn })),
    },
    segments: [
      {
        name: CLOUDWAN.segment,
        'require-attachment-acceptance': false,
        // send-via (east-west 検査) はセグメント内アタッチメント同士の通信が前提のため、
        // 隔離しない (isolate-attachments: false) を明示する必要がある (2025.11 のバリデーション要件)。
        'isolate-attachments': false,
        'edge-locations': REGION_CONFIGS.map((r) => r.region),
      },
    ],
    'network-function-groups': [
      {
        name: CLOUDWAN.nfg,
        'require-attachment-acceptance': false,
      },
    ],
    'segment-actions': [
      {
        action: 'send-to',
        segment: CLOUDWAN.segment,
        via,
      },
      {
        action: 'send-via',
        segment: CLOUDWAN.segment,
        mode: 'single-hop',
        'when-sent-to': { segments: [CLOUDWAN.segment] },
        via,
      },
    ],
    'attachment-policies': [
      {
        'rule-number': 100,
        description: 'attach workload segment by tag',
        'condition-logic': 'or',
        conditions: [
          {
            type: 'tag-value',
            operator: 'equals',
            key: CLOUDWAN.tagKey.segment,
            value: CLOUDWAN.segment,
          },
        ],
        action: { 'association-method': 'constant', segment: CLOUDWAN.segment },
      },
      {
        'rule-number': 200,
        description: 'add to inspection NFG by tag',
        'condition-logic': 'or',
        conditions: [
          {
            type: 'tag-value',
            operator: 'equals',
            key: CLOUDWAN.tagKey.nfg,
            value: CLOUDWAN.nfg,
          },
        ],
        action: { 'add-to-network-function-group': CLOUDWAN.nfg },
      },
    ],
  };
};
