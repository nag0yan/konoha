# Konoha

ブラウザで要望を伝えると、AIがWebアプリのコードを生成し、専用のLinux VMで起動します。**ローカル開発用のプロトタイプです。インターネットに公開しないでください。**

## 起動

mise、Dockerデーモン、Amazon Bedrockを利用できるAWS認証が必要です。

```sh
mise trust
mise install node aws-cli docker-cli docker-compose
mise exec -- npm ci
mise exec -- docker-compose -p konoha-local up -d --wait
mise exec -- docker build --tag konoha-qemu:local infra/vm
```

別々のターミナルで `mise exec -- npm run dev:server` と `mise exec -- npm run dev` を実行し、[Konoha](http://127.0.0.1:5173/) を開きます。リモート開発では、画面用の5173番に加えてプレビュー用の3002番も、同じポート番号で非公開転送してください。

## 使い方

1. 登録・ログインし、「色を変えながら線を描けるお絵描きアプリを作って」などと入力します。
2. 「実行中」になったら **アプリを開く** を押します。
3. **アプリを修正** から変更を依頼できます。検査と起動確認に成功したときだけ同じURLが新版に切り替わります。開いている画面は再読み込みしてください。

要望と修正対象のコードはBedrockに送信され、利用料金が発生します。機密情報は含めないでください。停止後もソースは残りますが、VM内の実行データは停止や更新で失われます。

## 検証・終了

DBとVMイメージを用意した状態で `mise exec -- npm run build` と `KONOHA_TEST_VM=1 mise exec -- npm test` を実行します。テストはBedrockを呼び出しません。

終了時は開発サーバーを停止し、`mise exec -- docker-compose -p konoha-local down` を実行します。DBのボリュームは削除されません。

設計理由、運用上の制約、旧プロトタイプの扱いは [アーキテクチャ](./docs/architecture.md) を参照してください。
