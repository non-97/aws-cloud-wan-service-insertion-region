import { REGIONS, REGION_CONFIGS, isInspectionAttached } from '../lib/config';

describe('REGION_CONFIGS', () => {
  test('NFG ありは us-east-1 / ap-northeast-1 / ap-northeast-3 の 3 つ', () => {
    const withNfg = REGION_CONFIGS.filter((r) => r.inspectionCidr).map((r) => r.region);
    expect(withNfg.sort()).toEqual(
      [REGIONS.usEast1, REGIONS.apNortheast1, REGIONS.apNortheast3].sort(),
    );
  });

  test('全 VPC CIDR が一意', () => {
    const cidrs = REGION_CONFIGS.flatMap((r) =>
      r.inspectionCidr ? [r.workloadCidr, r.inspectionCidr] : [r.workloadCidr],
    );
    expect(new Set(cidrs).size).toBe(cidrs.length);
  });

  test('ASN が一意かつ asnRange (64512-64555) 内', () => {
    const asns = REGION_CONFIGS.map((r) => r.asn);
    expect(new Set(asns).size).toBe(asns.length);
    for (const asn of asns) {
      expect(asn).toBeGreaterThanOrEqual(64512);
      expect(asn).toBeLessThanOrEqual(64555);
    }
  });
});

describe('isInspectionAttached', () => {
  test('baseline は NFG あり 3 リージョン全てアタッチ', () => {
    expect(isInspectionAttached('baseline', REGIONS.usEast1)).toBe(true);
    expect(isInspectionAttached('baseline', REGIONS.apNortheast1)).toBe(true);
    expect(isInspectionAttached('baseline', REGIONS.apNortheast3)).toBe(true);
  });

  test('NFG を持たないリージョンは常に false', () => {
    for (const phase of ['baseline', 'detach-use1', 'override-to-nfg'] as const) {
      expect(isInspectionAttached(phase, REGIONS.usWest2)).toBe(false);
      expect(isInspectionAttached(phase, REGIONS.apSoutheast1)).toBe(false);
    }
  });

  test('detach-use1 は us-east-1 のみデタッチ', () => {
    expect(isInspectionAttached('detach-use1', REGIONS.usEast1)).toBe(false);
    expect(isInspectionAttached('detach-use1', REGIONS.apNortheast1)).toBe(true);
    expect(isInspectionAttached('detach-use1', REGIONS.apNortheast3)).toBe(true);
  });

  test('override フェーズではデタッチしない (NFGあり3リージョン全てアタッチ)', () => {
    for (const phase of ['override-to-no-nfg', 'override-to-nfg'] as const) {
      expect(isInspectionAttached(phase, REGIONS.usEast1)).toBe(true);
      expect(isInspectionAttached(phase, REGIONS.apNortheast1)).toBe(true);
      expect(isInspectionAttached(phase, REGIONS.apNortheast3)).toBe(true);
    }
  });
});
