import { useEffect, useState, type FormEvent } from "react";

type VmApp = {
  id: string;
  title: string;
  status: "generating" | "checking" | "repairing" | "starting" | "ready" | "failed" | "stopped";
  error: string | null;
  saved: boolean;
  revision: number;
  revisionError: string | null;
  revisionStatus: VmApp["status"] | null;
};
const labels = {
  generating: "コードを生成中", checking: "コードを検査中", repairing: "コードを自動修正中",
  starting: "VMを起動中", ready: "実行中", failed: "失敗", stopped: "停止中",
};

function RevisionForm({ disabled, submit }: { disabled: boolean; submit: (prompt: string) => Promise<boolean> }) {
  const [prompt, setPrompt] = useState("");
  return <details>
    <summary>アプリを修正</summary>
    <form onSubmit={(event) => {
      event.preventDefault();
      void submit(prompt).then((accepted) => { if (accepted) setPrompt(""); });
    }}>
      <label>修正要望<textarea required maxLength={2000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="消しゴムを追加して" /></label>
      <p>修正要望と現在の生成コードをBedrockに送信します。機密情報は含めないでください。</p>
      <button disabled={disabled || !prompt.trim()}>修正を依頼</button>
    </form>
  </details>;
}

async function call<T>(path: string, payload?: object): Promise<T> {
  const response = await fetch(`/api/${path}`, payload && {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error ?? "通信に失敗しました"), { status: response.status });
  return body;
}

export function VmHome() {
  const [user, setUser] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [prompt, setPrompt] = useState("");
  const [apps, setApps] = useState<VmApp[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : "処理に失敗しました");
  }
  async function refresh() {
    setApps(await call<VmApp[]>("vm-apps"));
  }
  useEffect(() => {
    let active = true;
    call<{ email: string }>("me").then((me) => { if (active) setUser(me.email); })
      .catch((reason) => { if (active && reason.status !== 401) showError(reason); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await call<VmApp[]>("vm-apps");
        if (active) setApps(next);
      } catch (reason) { if (active) showError(reason); }
      if (active) timer = setTimeout(poll, 1800);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [user]);

  async function run(action: () => Promise<void>): Promise<boolean> {
    setError("");
    setBusy(true);
    try { await action(); return true; } catch (reason) { showError(reason); return false; }
    finally { setBusy(false); }
  }
  function auth(register: boolean) {
    void run(async () => {
      if (register) await call("register", { email, password });
      await call("login", { email, password });
      setUser((await call<{ email: string }>("me")).email);
      setPassword("");
    });
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await call("vm-apps", { prompt });
      await refresh();
      setPrompt("");
    });
  }

  if (loading) return <main className="narrow"><h1>Konoha</h1><p>読み込み中…</p></main>;
  if (!user) return <main className="narrow">
    <h1>Konoha🍂</h1>
    <p>変幻自在。</p>
    <form onSubmit={(event) => { event.preventDefault(); auth(false); }}>
      <label>メール<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>パスワード（12文字以上）<input type="password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <div className="actions">
        <button disabled={busy}>ログイン</button>
        <button type="button" disabled={busy || !email || password.length < 12} onClick={() => auth(true)}>登録してログイン</button>
      </div>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
  </main>;

  return <main>
    <header>
      <h1>Konoha</h1><span>{user}</span>
      <button disabled={busy} onClick={() => void run(async () => { await call("logout", {}); setUser(null); setApps([]); setPrompt(""); })}>ログアウト</button>
    </header>
    {error && <p className="error" role="alert">{error}</p>}
    <section>
      <h2>どんなアプリを作りますか？</h2>
      <form onSubmit={create}>
        <label>要望<textarea required maxLength={2000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="ブラウザで線を描いて、色を変えられるお絵描きアプリを作って" /></label>
        <p>要望はAIに送信されます。機密情報は入力しないでください。</p>
        <button disabled={busy || !prompt.trim()}>アプリを作る</button>
      </form>
    </section>
    <section>
      <h2>作成したアプリ</h2>
      {apps.length === 0 && <p>まだアプリはありません。</p>}
      {apps.map((app) => <article key={app.id}>
        <h3>{app.title} {app.saved && <small>v{app.revision}</small>}</h3>
        <p role="status">{labels[app.status]}</p>
        {app.error && <p className="error">{app.error}</p>}
        {app.revisionStatus && <p role="status">修正版：{labels[app.revisionStatus]}</p>}
        {app.revisionError && <p className="error" role="alert">修正に失敗しました。元のコードは変更していません。{app.revisionError}</p>}
        <div className="actions">
          {app.status === "ready" && <>
            <a href={`/api/vm-apps/${app.id}/open`} target="_blank" rel="noopener noreferrer">アプリを開く</a>
            <button disabled={busy || !!app.revisionStatus} onClick={() => void run(async () => { await call(`vm-apps/${app.id}/stop`, {}); await refresh(); })}>停止</button>
          </>}
          {app.saved && (app.status === "stopped" || app.status === "failed") && <button disabled={busy || !!app.revisionStatus} onClick={() => void run(async () => {
            await call(`vm-apps/${app.id}/start`, {});
            await refresh();
          })}>再起動</button>}
        </div>
        {app.saved && <RevisionForm disabled={busy || !!app.revisionStatus || !["ready", "stopped", "failed"].includes(app.status)} submit={(prompt) =>
          run(async () => {
            await call(`vm-apps/${app.id}/revise`, { prompt });
            await refresh();
          })} />}
      </article>)}
    </section>
  </main>;
}
