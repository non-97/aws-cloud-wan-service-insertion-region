/**
 * 検証環境の設定を一元管理する。
 * リージョン / CIDR / ASN / タグ / セグメント名、および検証フェーズをここで定義し、
 * Stack / Construct には Props 経由で注入する。
 *
 * 検証操作 (アタッチメントのデタッチ / with-edge-overrides の変更) は手動操作ではなく、
 * 本ファイルの CURRENT_PHASE を書き換えて `cdk deploy --all` することで synth 時に解決する
 * (Everything as Code)。
 */

/** 使用する 5 リージョン */
export const REGIONS = {
  usEast1: "us-east-1",
  usWest2: "us-west-2",
  apNortheast1: "ap-northeast-1",
  apNortheast3: "ap-northeast-3",
  apSoutheast1: "ap-southeast-1",
} as const;

/** Core Network / アタッチメントで使う固定値 */
export const CLOUDWAN = {
  /** Core Network のエッジに割り当てる ASN レンジ */
  asnRange: "64512-64555",
  /** Workload VPC を収容する単一セグメント */
  segment: "workload",
  /** Inspection VPC を収容する単一 Network Function Group */
  nfg: "inspection",
  /** アタッチメントのセグメント / NFG 自動割当に使うタグキー */
  tagKey: {
    segment: "cloudwan-seg",
    nfg: "cloudwan-nfg",
  },
} as const;

/** EC2 セキュリティグループの ingress 許可に使う RFC1918 帯 */
export const RFC1918_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;

/** リージョンごとのネットワーク設定 */
export interface RegionConfig {
  /** リージョンコード */
  readonly region: string;
  /** Core Network エッジに割り当てる ASN (asnRange 内で一意) */
  readonly asn: number;
  /** Workload VPC の CIDR (全リージョンに存在) */
  readonly workloadCidr: string;
  /** Inspection VPC の CIDR。未指定なら当該リージョンに NFG アタッチメントを作らない */
  readonly inspectionCidr?: string;
}

/**
 * リージョン構成。
 * NFG (Inspection VPC) を持つのは us-east-1 / ap-northeast-1 / ap-northeast-3 の 3 つ。
 * us-west-2 / ap-southeast-1 は Workload のみ (NFG なし) で、フォールバック / 地理検証の送信元/先。
 */
export const REGION_CONFIGS: readonly RegionConfig[] = [
  {
    region: REGIONS.usEast1,
    asn: 64512,
    workloadCidr: "10.1.0.0/16",
    inspectionCidr: "10.0.0.0/16",
  },
  {
    region: REGIONS.usWest2,
    asn: 64513,
    workloadCidr: "10.11.0.0/16",
  },
  {
    region: REGIONS.apNortheast1,
    asn: 64514,
    workloadCidr: "10.21.0.0/16",
    inspectionCidr: "10.20.0.0/16",
  },
  {
    region: REGIONS.apNortheast3,
    asn: 64515,
    workloadCidr: "10.31.0.0/16",
    inspectionCidr: "10.30.0.0/16",
  },
  {
    region: REGIONS.apSoutheast1,
    asn: 64516,
    workloadCidr: "10.41.0.0/16",
  },
] as const;

/** Core Network 本体 (GlobalNetwork / CoreNetwork) を配置するリージョン */
export const CORE_STACK_REGION = REGIONS.apNortheast1;

/**
 * 検証フェーズ。CURRENT_PHASE を書き換えて再デプロイすることで構成を遷移させる。
 *
 * - baseline           : 全 Inspection アタッチメントあり / override なし (シナリオ 1, 2前半, 追加検証)
 * - detach-use1        : us-east-1 の Inspection をデタッチ (シナリオ 2後半 / 切替時間計測)
 * - override-to-no-nfg : ap-northeast-1 発を use-edge-location: us-west-2 (NFGなし) に強制 → タイムアウト (シナリオ 3)
 * - override-to-nfg    : us-west-2 発を use-edge-location: ap-northeast-1 (NFGあり) に強制 (シナリオ 4)
 */
export type Phase =
  | "baseline"
  | "detach-use1"
  | "override-to-no-nfg"
  | "override-to-nfg";

/** ▼▼▼ ここを書き換えてフェーズを遷移させる ▼▼▼ */
export const CURRENT_PHASE: Phase = "baseline";
/** ▲▲▲ ここを書き換えてフェーズを遷移させる ▲▲▲ */

/**
 * 指定フェーズ・リージョンで Inspection VPC を NFG にアタッチするかどうか。
 * inspectionCidr を持たないリージョンは常に false。
 */
export const isInspectionAttached = (phase: Phase, region: string): boolean => {
  const config = REGION_CONFIGS.find((r) => r.region === region);
  if (!config?.inspectionCidr) {
    return false;
  }
  if (phase === "detach-use1" && region === REGIONS.usEast1) {
    return false;
  }
  return true;
};

/** with-edge-overrides の 1 エントリ */
export interface EdgeOverride {
  readonly "edge-sets": string[][];
  readonly "use-edge-location": string;
}

/**
 * 指定フェーズの with-edge-overrides を返す。override しないフェーズは undefined。
 * send-to / send-via の via ブロックに付与する。
 */
export const edgeOverrides = (phase: Phase): EdgeOverride[] | undefined => {
  switch (phase) {
    case "override-to-no-nfg":
      // ap-northeast-1 発の通信を、NFG が存在しない us-west-2 に強制 → タイムアウトを観測
      return [
        {
          "edge-sets": [[REGIONS.apNortheast1]],
          "use-edge-location": REGIONS.usWest2,
        },
      ];
    case "override-to-nfg":
      // us-west-2 発の通信を、NFG が存在する ap-northeast-1 に強制
      return [
        {
          "edge-sets": [[REGIONS.usWest2]],
          "use-edge-location": REGIONS.apNortheast1,
        },
      ];
    default:
      return undefined;
  }
};
