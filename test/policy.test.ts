import { buildCoreNetworkPolicy } from '../lib/core-network-policy';
import { CLOUDWAN, Phase, REGIONS, REGION_CONFIGS } from '../lib/config';

/** policyDocument 内の send-to / send-via アクションを取り出すヘルパー */
const segmentActions = (phase: Phase): any[] => {
  const policy = buildCoreNetworkPolicy(phase) as any;
  return policy['segment-actions'];
};

describe('buildCoreNetworkPolicy', () => {
  test('全リージョンが edge-locations に含まれる', () => {
    const policy = buildCoreNetworkPolicy('baseline') as any;
    const locations = policy['core-network-configuration']['edge-locations'].map(
      (e: any) => e.location,
    );
    expect(locations.sort()).toEqual(REGION_CONFIGS.map((r) => r.region).sort());
  });

  test('workload セグメントと inspection NFG が定義される', () => {
    const policy = buildCoreNetworkPolicy('baseline') as any;
    expect(policy.segments.map((s: any) => s.name)).toEqual([CLOUDWAN.segment]);
    expect(policy['network-function-groups'].map((n: any) => n.name)).toEqual([CLOUDWAN.nfg]);
  });

  test('send-to / send-via が NFG 経由で定義される', () => {
    const actions = segmentActions('baseline');
    const actionTypes = actions.map((a) => a.action);
    expect(actionTypes).toContain('send-to');
    expect(actionTypes).toContain('send-via');
    for (const action of actions) {
      expect(action.via['network-function-groups']).toEqual([CLOUDWAN.nfg]);
    }
  });

  test.each<Phase>(['baseline', 'detach-use1'])(
    'override しないフェーズ (%s) は with-edge-overrides を持たない',
    (phase) => {
      for (const action of segmentActions(phase)) {
        expect(action.via['with-edge-overrides']).toBeUndefined();
      }
    },
  );

  test('override-to-no-nfg は ap-northeast-1 発を us-west-2 (NFGなし) に向ける', () => {
    for (const action of segmentActions('override-to-no-nfg')) {
      const overrides = action.via['with-edge-overrides'];
      expect(overrides).toHaveLength(1);
      expect(overrides[0]['edge-sets']).toEqual([[REGIONS.apNortheast1]]);
      expect(overrides[0]['use-edge-location']).toBe(REGIONS.usWest2);
    }
  });

  test('override-to-nfg は us-west-2 発を ap-northeast-1 (NFGあり) に向ける', () => {
    for (const action of segmentActions('override-to-nfg')) {
      const overrides = action.via['with-edge-overrides'];
      expect(overrides).toHaveLength(1);
      expect(overrides[0]['edge-sets']).toEqual([[REGIONS.usWest2]]);
      expect(overrides[0]['use-edge-location']).toBe(REGIONS.apNortheast1);
    }
  });
});
