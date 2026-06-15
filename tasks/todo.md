# Cloud WAN Service Insertion リージョン選択検証環境 構築計画

## 目的

Service Insertion (send-to / send-via single-hop) で検査先リージョンがどう選択されるかを実証する。
詳細な背景は `../support-case.md` を参照。

検証シナリオ:

1. **優先リスト順の確認**: NFGありリージョン同士のペア入替えで常にリスト上位が選ばれるか
2. **フォールバック**: 送信元/先ともNFGなしの場合にリスト順でフォールバックするか、us-east-1 デタッチで ap-northeast-1 に切り替わるか
3. **override → NFGなしリージョン**: use-edge-location に NFGアタッチメントが無いリージョンを指定 → タイムアウト (フォールバックしない) の確認
4. **override → NFGありリージョン**: use-edge-location 指定先に正しくルーティングされるか
5. (追加) override 先を後からデタッチ → フォールバック無効の確認
6. (追加) 切替時間計測、アタッチメント作成順の交絡排除、戻り経路の対称性確認

## アーキテクチャ

### リージョン構成 (5リージョン)

| リージョン | 優先リスト順位 | Inspection VPC (NFG) | Workload VPC | 役割 |
|---|---|---|---|---|
| us-east-1 | #1 | ✅ | ✅ | リスト最上位の検査先 |
| us-west-2 | #4 | ❌ | ✅ | NFGなし送信元/先、シナリオ3のoverride先 |
| ap-northeast-1 | #7 | ✅ | ✅ | 2番目の検査先、シナリオ4のoverride先 |
| ap-northeast-3 | #9 | ✅ | ✅ | 非USリージョン同士の順位確認用 |
| ap-southeast-1 | - | ❌ | ✅ | NFGなし送信元/先 (地理的反証: 最遠のus-east-1が選ばれるか) |

### CIDR設計 (全VPC一意)

| リージョン | Inspection VPC | Workload VPC |
|---|---|---|
| us-east-1 | 10.0.0.0/16 | 10.1.0.0/16 |
| us-west-2 | - | 10.11.0.0/16 |
| ap-northeast-1 | 10.20.0.0/16 | 10.21.0.0/16 |
| ap-northeast-3 | 10.30.0.0/16 | 10.31.0.0/16 |
| ap-southeast-1 | - | 10.41.0.0/16 |

### Cloud WAN 設計

- Global Network + Core Network ×1。edge-locations は5リージョンすべて
- セグメント: `workload` ×1 (全Workload VPCを収容)
- NFG: `inspection` ×1 (Inspection VPC ×3を収容)
- segment-actions:
  - `send-to` : workload → 0.0.0.0/0 (インターネット) を NFG 経由に
  - `send-via single-hop` : workload 同士の east-west を NFG 経由に
- attachment-policies: タグベース (`cloudwan-seg=workload` / `cloudwan-nfg=inspection`) で自動割当 (参考プロジェクトと同パターン)
- with-edge-overrides: 検証フェーズに応じて切替 (後述)

### VPC構成

**Inspection VPC (×3)** — egress検査も担うため3層サブネット (各1AZ):

- Public subnet: IGW + NAT Gateway
- Firewall subnet: NFW エンドポイント。0.0.0.0/0 → NAT GW
- Attachment subnet: Cloud WAN VPC Attachment (`applianceModeSupport: true`)。0.0.0.0/0 → NFWエンドポイント
- 戻りルート: Firewall/Public subnet から 10.0.0.0/8 → Core Network ARN
- Network Firewall: STATEFUL pass-all + alert ルール (どのリージョンで検査されたかログで判別するため、ICMP / HTTP / TLS SNI に alert)。ALERT + FLOW ログを CloudWatch Logs へ (戻り経路の対称性確認に FLOW ログ必須)

**Workload VPC (×5)** — 各1AZ:

- Private subnet (ISOLATED): テスト用 EC2 (t3.micro / AL2023) + Cloud WAN VPC Attachment。0.0.0.0/0 → Core Network ARN
- EC2 Instance Connect Endpoint でアクセス (無料・Core Network経路に非依存。シナリオ3のタイムアウト中でも操作可能にするため SSM 経由にしない)

## CDKプロジェクト構成

既存の `cdk init` 雛形 (pnpm) をベースに以下へ再構成する。

```
bin/
  aws-cloud-wan-service-insertion-region.ts  # 6 Stack のインスタンス化
lib/
  config.ts                                  # リージョン/CIDR/タグ/フェーズ定義の一元管理 (フェーズはここで切替)
  core-network-policy.ts                     # フェーズ → Core Network Policy ドキュメント生成 (純関数)
  core-stack.ts                              # GlobalNetwork + CoreNetwork (ap-northeast-1 に配置)
  region-stack.ts                            # リージョン汎用 Stack (Inspection有無をpropsで制御)
  constructs/
    inspection-vpc.ts                        # NFW + NAT GW + NFGアタッチメント
    workload-vpc.ts                          # テストEC2 + EICエンドポイント + セグメントアタッチメント
test/
  snapshot.test.ts                           # 全Stackスナップショット
  policy.test.ts                             # フェーズごとのポリシー生成の fine-grained テスト
tasks/
  todo.md (本ファイル)
```

### Stack 分割と依存

- `CoreStack` (ap-northeast-1): GlobalNetwork / CoreNetwork / Policy。coreNetworkId / Arn を公開
- `RegionStack` ×5: props で `hasInspection` と CIDR を受け取る汎用 Stack
- `crossRegionReferences: true` で CoreStack → 各 RegionStack へ ID/ARN を受け渡し (参考プロジェクトと同パターン)
- ルート (CfnRoute → coreNetworkArn) は Attachment に `addDependency`

### フェーズ切替設計 (Everything as Code)

検証操作 (デタッチ / override変更) は手動操作ではなく **`lib/config.ts` 内のフェーズパラメーターで synth 時に解決**し、値を書き換えて `cdk deploy --all` で遷移する。

```ts
// lib/config.ts のイメージ
export type Phase =
  | 'baseline'
  | 'detach-use1'
  | 'override-to-no-nfg'
  | 'override-to-nfg'
  | 'override-then-detach';

export const CURRENT_PHASE: Phase = 'baseline'; // ← ここを書き換えてフェーズ遷移
```

| phase | 構成 | 対象シナリオ |
|---|---|---|
| `baseline` | 全アタッチメントあり / overrideなし | 1, 2前半, 追加(順序/対称性) |
| `detach-use1` | us-east-1 の Inspection アタッチメントを削除 | 2後半 + 切替時間計測 |
| `override-to-no-nfg` | edge-sets [[ap-northeast-1]] → use-edge-location: us-west-2 | 3 (タイムアウト確認) |
| `override-to-nfg` | edge-sets [[us-west-2]] → use-edge-location: ap-northeast-1 | 4 |
| `override-then-detach` | 上記 + ap-northeast-1 Inspection デタッチ | 5 (override時フォールバック無効) |

`core-network-policy.ts` がフェーズから policyDocument を、`region-stack.ts` が Inspection アタッチメントの有無を決定する。フェーズごとの構成差分はすべて config + 純関数に閉じ、Stack / Construct 側に if 分岐を散らさない。

## 実装ステップ

- [x] 1. プロジェクト基盤整備: `tsconfig` noEmit/isolatedModules、`package.json` scripts 整理、雛形削除 (ts-node は既存設定を踏襲)
- [x] 2. `lib/config.ts`: リージョン/CIDR/タグキー/フェーズ型の定義
- [x] 3. `lib/core-network-policy.ts`: フェーズ → ポリシードキュメント生成関数 (segments / NFG / segment-actions / attachment-policies / with-edge-overrides)
- [x] 4. `lib/core-stack.ts`: GlobalNetwork + CfnCoreNetwork
- [x] 5. `lib/constructs/workload-vpc.ts`: VPC + EC2 + EIC Endpoint + Attachment + ルート
- [x] 6. `lib/constructs/inspection-vpc.ts`: VPC + NFW (alert/flowログ) + NAT GW + 条件付き NFG Attachment + ルート
- [x] 7. `lib/region-stack.ts` + `bin/`: 6 Stack 構成と依存関係
- [x] 8. テスト: スナップショット + ポリシー/config fine-grained (26 テスト)
- [x] 9. `cdk synth` 全6スタック生成確認 (AZ context は要認証=デプロイ時自動解決)、cdk-nag は今回見送り
- [x] 10. デプロイ手順書を `tasks/verification-steps.md` に作成

## デプロイ / 検証の進め方 (要点)

1. **デプロイは並列**: `cdk deploy --all --concurrency 6 --require-approval never` (CoreStack が先に完了し RegionStack 5つが並列。作成順統制は行わない)
2. 各フェーズで `aws networkmanager get-network-routes` により**静的にルーティング先を判定** → EC2 から ping / curl で実証 → NFW alert/flow ログで検査リージョンと対称性を確認
3. フェーズ遷移時 (config 書き換え → deploy) は ping を流しっぱなしにして**切替時間を計測**
4. 検証完了後 `cdk destroy --all`

## コスト概算 (検証中のみ)

CNE ×5 ($2.50/h) + NFW ×3 (約$1.19/h) + NAT GW ×3 (約$0.14/h) + アタッチメント ×8 ($0.40/h) + EC2 t3.micro ×5 (約$0.07/h) ≒ **約$4.3/h (約700円/h)**。検証は1〜2日で完了させ即時 destroy する。

## レビュー

### 成果物

- `lib/config.ts` : リージョン/CIDR/ASN/タグ/フェーズの一元管理。`CURRENT_PHASE` 書換でフェーズ遷移
- `lib/core-network-policy.ts` : フェーズ → Core Network Policy を生成する純関数
- `lib/core-stack.ts` : GlobalNetwork + CoreNetwork (ap-northeast-1)
- `lib/region-stack.ts` : リージョン汎用 Stack (inspectionCidr 有無で Inspection VPC を出し分け)
- `lib/constructs/workload-vpc.ts` / `inspection-vpc.ts` : VPC 群
- `bin/` : CoreStack + RegionStack×5、crossRegionReferences + addDependency
- `test/` : config / policy / stacks (スナップショット) の 26 テスト全通過
- `tasks/verification-steps.md` : フェーズ別の検証コマンド集

### 検証ポイント (動作の証明)

- `pnpm run type-check` : 通過
- `pnpm test` (jest 26 件) : 全通過。生成ポリシー JSON が send-to/send-via/NFG/attachment-policies/with-edge-overrides まで意図通り
- `cdk synth` : 全6スタックのテンプレート生成を確認。us-east-1 は workload+inspection(ApplianceMode) の2アタッチメント+NFW1台、us-west-2 は workload のみ+NFW0台を確認
- AZ の context lookup のみ認証必須 (lookup なし、デプロイ時に awsume 認証で自動解決)

### 設計判断のメモ

- フェーズ切替を context ではなく config パラメーター (`CURRENT_PHASE`) に集約 (のんピの指示)。差分は config + 純関数に閉じ、Stack/Construct に if を散らさない
- デタッチは「Inspection VPC ごと削除」ではなく `attachToNfg` で **NFG アタッチメント + Core Network 向けルートのみ条件付き化**。VPC/NFW/NAT GW は維持し再アタッチ差分を最小化
- 検査リージョンの判別を確実にするため NFW alert msg にリージョンラベルを埋込み、FLOW ログで往復対称性も取得
- ts-node は既存雛形の設定を踏襲 (skill は tsx 推奨だが、依存追加を避け影響最小化)

### 残課題 / 申し送り

- 初回 `cdk synth`/`deploy` で `cdk.context.json` に AZ がキャッシュされる → コミット推奨
- `pnpm-workspace.yaml` の `allowBuilds.unrs-resolver` をプレースホルダから `false` に修正済み
- デプロイは未実施 (時間課金のため)。`verification-steps.md` の順序 (NFG を優先リスト逆順で作成) に従うこと
