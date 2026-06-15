# AWS Cloud WAN Service Insertion リージョン選択 検証環境

AWS Cloud WAN の Service Insertion (send-to / send-via single-hop) で、トラフィックが **どのリージョンの Inspection VPC で検査されるか** を実機で検証するための CDK プロジェクト。

「default Region priority list」の挙動、フォールバック、`with-edge-overrides` の効き方などを、ルートテーブル (FIB) と RIB の直接観測で明らかにする。背景は [`support-case.md`](../support-case.md) (リポジトリ親ディレクトリ) を参照。

## アーキテクチャ

- **Core Network** ×1 (policy version `2025.11`)。5 リージョンをエッジに持つ
- **セグメント** `workload` ×1 (全 Workload VPC を収容) / **NFG** `inspection` ×1 (Inspection VPC を収容)
- **segment-actions**: `send-to` (egress を NFG 経由) + `send-via single-hop` (east-west を NFG 経由)
- アタッチメントはタグ (`cloudwan-seg=workload` / `cloudwan-nfg=inspection`) でセグメント/NFG に自動割当

### リージョン構成

| リージョン | 優先リスト順位 | Inspection VPC (NFG) | Workload VPC |
|---|---|---|---|
| us-east-1 | 1 | ✅ | ✅ |
| us-west-2 | 4 | ❌ | ✅ |
| ap-northeast-1 | 7 | ✅ | ✅ |
| ap-northeast-3 | 9 | ✅ | ✅ |
| ap-southeast-1 | 12 | ❌ | ✅ |

### CIDR

| リージョン | Inspection VPC | Workload VPC |
|---|---|---|
| us-east-1 | 10.0.0.0/16 | 10.1.0.0/16 |
| us-west-2 | - | 10.11.0.0/16 |
| ap-northeast-1 | 10.20.0.0/16 | 10.21.0.0/16 |
| ap-northeast-3 | 10.30.0.0/16 | 10.31.0.0/16 |
| ap-southeast-1 | - | 10.41.0.0/16 |

## ディレクトリ構成

```
bin/   … CoreStack + RegionStack×5 のインスタンス化
lib/
  config.ts              … リージョン/CIDR/タグ/フェーズの一元管理 (CURRENT_PHASE で切替)
  core-network-policy.ts … フェーズ → Core Network Policy を生成する純関数
  core-stack.ts          … GlobalNetwork + CoreNetwork (ap-northeast-1 に配置)
  region-stack.ts        … リージョン汎用 Stack (inspectionCidr 有無で Inspection VPC を出し分け)
  constructs/
    workload-vpc.ts      … VPC + テストEC2 + EIC Endpoint + アタッチメント
    inspection-vpc.ts    … VPC + Network Firewall + NAT GW + 条件付き NFG アタッチメント
scripts/
  get-fib.sh             … FIB (確定ルート) をセグメント/NFG × リージョンで取得・整形
  get-rib.sh             … RIB (候補ルート + BGP 属性) を取得・整形
test/                    … config / policy / stacks (スナップショット) の単体テスト
tasks/
  todo.md                … 検証計画
  verification-steps.md  … デプロイ・検証手順
  findings.md            … 実機で確定した発見の記録 (重要)
```

## 前提ツール

- Node.js + **pnpm**
- **AWS CLI v2** + 認証 (`awsume <profile>` → `aws sts get-caller-identity`)
- **jq** (`get-fib.sh` が使用)
- AWS CDK (devDependency に含む)

## セットアップ・デプロイ

```bash
pnpm install

# 各リージョンへ Bootstrap (初回のみ・並列)
for r in us-east-1 us-west-2 ap-northeast-1 ap-northeast-3 ap-southeast-1; do
  pnpm cdk bootstrap aws://<ACCOUNT_ID>/$r &
done
wait

# 全スタック並列デプロイ (CoreStack が先に完了し RegionStack 5つが並列)
pnpm cdk deploy --all --concurrency 6 --require-approval never
```

> Core Network / Inspection VPC は時間課金 (概算 約$4/h)。検証が終わったら `pnpm cdk destroy --all` で必ず削除する。

## 検証フェーズの切替

`lib/config.ts` の `CURRENT_PHASE` を書き換えて再デプロイすると構成が遷移する (Everything as Code)。

| フェーズ | 内容 |
|---|---|
| `baseline` | 全 Inspection アタッチメントあり / override なし |
| `detach-use1` | us-east-1 の Inspection をデタッチ |
| `override-to-no-nfg` | ap-northeast-1 発を `use-edge-location: us-west-2` (NFGなし) に強制 |
| `override-to-nfg` | us-west-2 発を `use-edge-location: ap-northeast-1` に強制 |

```bash
# CURRENT_PHASE を書き換えてから
pnpm cdk deploy --all --concurrency 6 --require-approval never
```

> **重要**: Inspection VPC を着脱/差し替えした場合は、必ず Core Network ポリシーを再適用すること。さもないとルート束縛が古いまま blackhole 固着・非対称になる (詳細は `tasks/findings.md`)。

## ルートの観測

```bash
# FIB (確定ルート) — NEXT-HOP 列で「どのリージョンの Inspection VPC か」が分かる
./scripts/get-fib.sh

# RIB (候補ルート + BGP 属性: AS Path / MED / Local Preference)
./scripts/get-rib.sh

# Core Network が us-west-2 で見つからない場合は作成リージョンを指定
NM_REGION=ap-northeast-1 ./scripts/get-fib.sh
```

診断時は **policy (get-core-network-policy) / FIB / RIB を同時点で突き合わせる**こと (FIB がポリシーと乖離=stale するケースがある)。

## 検証結果

実機で確定した発見 (リージョン選択ルール、デタッチ非フォールバック、ポリシー再適用の必要性、コンソール JSON のバグ、2025.11 スキーマ差分など) は **[`tasks/findings.md`](tasks/findings.md)** に記録。

### 証拠ログ (`evidence/`)

各シナリオで取得した実機の Core Network Policy / ルート / イベントの生ログ。シナリオ番号は検証シナリオに対応する。

| ファイル | 内容 |
|---|---|
| `scenario1_core-network-policy.json` / `_routes.log` | シナリオ1 (優先リスト順 = baseline) のポリシーとルート |
| `scenario2_core-network-policy.json` / `_routes.log` | シナリオ2 (フォールバック) のポリシーとルート |
| `scenario2_core-network-events_after_dettach_us-east-1_inspection-vpc.json` | us-east-1 Inspection VPC デタッチ後のイベント |
| `scenario2_core-network-routes_after-apply-new-policy.log` | デタッチ後にポリシー再適用した後のルート |
| `scenario3_core-network-policy.json` / `_routes.log` | シナリオ3 (override → NFGなしリージョン) のポリシーとルート |
| `scenario3_core-network-routes_after-apply-new-policy.log` | シナリオ3でポリシー再適用後のルート |
| `scenario4_core-network-policy.json` / `_routes.log` | シナリオ4 (override → NFGありリージョン) のポリシーとルート |

> `scenario2` / `scenario3` の `after-apply-new-policy` は、「Inspection VPC 着脱後はポリシー再適用が必要」という発見の前後比較になっている。

## よく使うコマンド

| コマンド | 説明 |
|---|---|
| `pnpm run type-check` | TypeScript 型チェック (`tsc --noEmit`) |
| `pnpm test` | Jest 単体テスト |
| `pnpm cdk synth` | CloudFormation テンプレート生成 |
| `pnpm cdk diff` | デプロイ済みとの差分 |
| `pnpm cdk deploy --all --concurrency 6 --require-approval never` | 全スタック並列デプロイ |
| `pnpm cdk destroy --all` | 全スタック削除 (検証後は必ず実行) |
