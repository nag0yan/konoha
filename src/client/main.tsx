import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { AppSpec, Entity } from "../shared/spec.ts";
import { VmHome } from "./vm-home.tsx";
import "./style.css";

type AppInfo = { id: string; spec: AppSpec; version: number; role: "owner" | "member"; default_visibility: "shared" | "private" };
type Member = { id: string; email: string; role: "owner" | "member" };
type RecordData = { id: string; visibility: "shared" | "private"; created_by: string; [key: string]: unknown };
type UserInfo = { email: string; codeEnabled: boolean };
type CodeRevision = { revision: number; source: string; sample_input: Record<string, unknown> };
type CodeState = { canEdit: boolean; active: number | null; draft: CodeRevision | null; previous: CodeRevision | null };

async function api<T>(url: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(`/api${url}`, {
    method,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message = typeof result === "object" && result !== null && "error" in result ? String(result.error) : "通信エラー";
    throw new ApiError(message, response.status);
  }
  return result as T;
}

class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<UserInfo | null>(null);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [createType, setCreateType] = useState<"code" | "definition">("code");
  const [createSample, setCreateSample] = useState("{}");
  const [changePrompt, setChangePrompt] = useState("");
  const [visibility, setVisibility] = useState<"shared" | "private">("private");
  const [memberEmail, setMemberEmail] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = apps.find((item) => item.id === selectedId);
  const codeCreation = user?.codeEnabled && createType === "code";

  async function loadApps() {
    setApps(await api<AppInfo[]>("/apps"));
  }
  async function refreshUser() {
    setUser(await api<UserInfo>("/me"));
    await loadApps();
  }
  useEffect(() => {
    api<UserInfo>("/me").then((me) => { setUser(me); return loadApps(); }).catch((e: unknown) => {
      if (!(e instanceof ApiError && e.status === 401)) setError(e instanceof Error ? e.message : "通信エラー");
    });
  }, []);
  useEffect(() => {
    if (selected?.role === "owner") {
      api<Member[]>(`/apps/${selected.id}/members`).then(setMembers).catch((e: Error) => setError(e.message));
    } else setMembers([]);
  }, [selected?.id, selected?.role]);

  async function run(action: () => Promise<void>) {
    setError("");
    setBusy(true);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "エラーが発生しました"); }
    finally { setBusy(false); }
  }
  function auth(register: boolean) {
    return run(async () => {
      if (register) await api("/register", "POST", { email, password });
      await api("/login", "POST", { email, password });
      await refreshUser();
      setPassword("");
    });
  }

  if (!user) return <main className="narrow">
    <h1>Konoha</h1>
    <p>ローカル開発用アプリ生成プロトタイプ</p>
    <form onSubmit={(event) => { event.preventDefault(); void auth(false); }}>
      <label>メール<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>パスワード（12文字以上）<input type="password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <div className="actions"><button disabled={busy}>ログイン</button><button type="button" disabled={busy || !email || password.length < 12} onClick={() => void auth(true)}>登録してログイン</button></div>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
  </main>;

  return <main>
    <header><h1>Konoha</h1><span>{user.email}</span><button onClick={() => void run(async () => { await api("/logout", "POST"); setUser(null); setApps([]); setSelectedId(null); setCreateType("code"); setCreateSample("{}"); })}>ログアウト</button></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section>
      <h2>アプリを作成</h2>
      <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
        const created = codeCreation
          ? await api<{ id: string }>("/code-apps", "POST", { prompt, sample: createSample })
          : await api<{ id: string }>("/apps", "POST", { prompt, defaultVisibility: visibility });
        await loadApps(); setSelectedId(created.id); setPrompt("");
      }); }}>
        {user.codeEnabled && <label>作成方法<select value={createType} onChange={(event) => setCreateType(event.target.value === "definition" ? "definition" : "code")}><option value="code">コード版</option><option value="definition">定義ベース</option></select></label>}
        <label>要望<textarea required maxLength={codeCreation ? 1000 : 4000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={codeCreation ? "在庫を一覧表示し、数量の合計を確認できるアプリを作って" : "予約管理システムを作って"} /></label>
        {codeCreation ? <>
          <p>コード版はサンプルデータで動くプレビューを作ります。機密情報は入力しないでください。</p>
          <details><summary>サンプル入力を設定（任意）</summary>
            <label>サンプル入力（JSONオブジェクト）<textarea maxLength={4000} value={createSample} onChange={(event) => setCreateSample(event.target.value)} /></label>
          </details>
        </> : <label>デフォルトの公開範囲<select value={visibility} onChange={(event) => setVisibility(event.target.value as "shared" | "private")}><option value="private">非公開</option><option value="shared">共有</option></select></label>}
        <button disabled={busy}>{codeCreation ? "生成してプレビュー" : "生成"}</button>
      </form>
    </section>
    <section><h2>アプリ</h2>
      {apps.length === 0 && <p>アプリはまだありません。</p>}
      <div className="actions">{apps.map((item) => <button key={item.id} onClick={() => setSelectedId(item.id)}>{item.spec.title}（{item.role}）</button>)}</div>
    </section>
    {selected && <section>
      <h2>{selected.spec.title} <small>{selected.spec.entities.length ? `v${selected.version}` : "コード版"}</small></h2>
      {selected.role === "owner" && <>
        {selected.spec.entities.length > 0 && <>
        <label>新規データのデフォルト公開範囲
          <select value={selected.default_visibility} onChange={(event) => void run(async () => {
            await api(`/apps/${selected.id}/settings`, "PATCH", { defaultVisibility: event.target.value });
            await loadApps();
          })}><option value="private">非公開</option><option value="shared">共有</option></select>
        </label>
        <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api(`/apps/${selected.id}/change`, "POST", { prompt: changePrompt }); setChangePrompt(""); await loadApps(); }); }}>
          <label>機能追加<textarea required value={changePrompt} onChange={(event) => setChangePrompt(event.target.value)} placeholder="予約にメモを追加" /></label>
          <button disabled={busy}>変更を適用</button>
        </form>
        </>}
        <h3>メンバー</h3>
        <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
          await api(`/apps/${selected.id}/members`, "POST", { email: memberEmail });
          setMemberEmail(""); setMembers(await api<Member[]>(`/apps/${selected.id}/members`));
        }); }}>
          <label>登録済みユーザーのメール<input type="email" required value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} /></label>
          <button disabled={busy}>追加</button>
        </form>
        <ul>{members.map((member) => <li key={member.id}>{member.email} ({member.role}) {member.role === "member" && <button onClick={() => void run(async () => {
          await api(`/apps/${selected.id}/members/${member.id}`, "DELETE");
          setMembers(await api<Member[]>(`/apps/${selected.id}/members`));
        })}>削除</button>}</li>)}</ul>
      </>}
      {selected.spec.entities.map((entity) => <EntityView key={`${selected.id}-${selected.version}-${entity.name}`} app={selected} entity={entity} onError={setError} />)}
      {user.codeEnabled && <CodeView key={selected.id} appId={selected.id} />}
    </section>}
  </main>;
}

function CodeView({ appId }: { appId: string }) {
  const [state, setState] = useState<CodeState | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sample, setSample] = useState('{\n  "items": [{"name": "サンプル", "quantity": 3}]\n}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/apps/${appId}/code`;

  useEffect(() => {
    api<CodeState>(endpoint).then((value) => {
      setState(value);
      if (value.draft) setSample(JSON.stringify(value.draft.sample_input, null, 2));
    }).catch((e: Error) => setError(e.message));
  }, [endpoint]);

  async function change(path: string, value: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(`${endpoint}${path}`, "POST", value);
      setState(await api<CodeState>(endpoint));
      if (path === "") setPrompt("");
    } catch (e) { setError(e instanceof Error ? e.message : "エラーが発生しました"); }
    finally { setBusy(false); }
  }

  const releaseUrl = `/api${endpoint}/release?format=html`;
  const draft = state?.draft;
  const previewUrl = draft && `/api${endpoint}/preview/${draft.revision}`;
  return <article>
    <h3>コード版（ローカル実験）</h3>
    <p>サンプルJSONで動作します。保存済みデータは使用しません。入力や変更依頼には機密情報を含めないでください。</p>
    {error && <p className="error" role="alert">{error}</p>}
    {state && !state.canEdit && !state.active && <p>公開版はありません。</p>}
    {state?.canEdit && <form onSubmit={(event) => { event.preventDefault(); void change("", { prompt, sample }); }}>
      <label>コードの変更依頼<textarea required maxLength={1000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="品目を表にして、数量の合計を表示して" /></label>
      <label>サンプル入力（JSONオブジェクト）<textarea required maxLength={4000} value={sample} onChange={(event) => setSample(event.target.value)} /></label>
      <button disabled={busy}>コード生成・検証</button>
    </form>}
    {previewUrl && draft && <div>
      <h4>検証済み v{draft.revision}</h4>
      <details><summary>新しいコード</summary><pre style={{ overflowX: "auto" }}>{draft.source}</pre></details>
      {state?.previous && <details><summary>前のコード（v{state.previous.revision}）</summary><pre style={{ overflowX: "auto" }}>{state.previous.source}</pre></details>}
      {draft.revision !== state?.active && <>
        <p><a href={previewUrl} target="_blank" rel="noopener noreferrer">別タブでプレビュー</a></p>
        <iframe title="コード版プレビュー" sandbox="" src={previewUrl} width="100%" />
        <button disabled={busy} onClick={() => void change(`/${draft.revision}/approve`, {})}>承認して公開版に切り替え</button>
      </>}
    </div>}
    {state?.active && <div>
      <h4>公開版 v{state.active}（アプリメンバー限定）</h4>
      <p><a href={releaseUrl} target="_blank" rel="noopener noreferrer">別タブで公開版を表示</a></p>
      <iframe key={state.active} title="コード公開版" sandbox="" src={releaseUrl} width="100%" />
    </div>}
  </article>;
}

function EntityView({ app, entity, onError }: { app: AppInfo; entity: Entity; onError: (message: string) => void }) {
  const [records, setRecords] = useState<RecordData[]>([]);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [visibility, setVisibility] = useState(app.default_visibility);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const endpoint = `/apps/${app.id}/records/${entity.name}`;
  async function load() { setRecords(await api<RecordData[]>(endpoint)); }
  useEffect(() => { load().catch((e: Error) => onError(e.message)); }, [endpoint, onError]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); onError("");
    try {
      const data: Record<string, string | number | boolean> = {};
      for (const field of entity.fields) {
        const value = values[field.name];
        if (value !== undefined && value !== "") data[field.name] = field.type === "number" ? Number(value) : value;
      }
      await api(editing ? `${endpoint}/${editing}` : endpoint, editing ? "PATCH" : "POST", { values: data, visibility });
      setValues({}); setEditing(null); await load();
    } catch (e) { onError(e instanceof Error ? e.message : "エラーが発生しました"); }
    finally { setBusy(false); }
  }
  return <article>
    <h3>{entity.label}</h3>
    <form onSubmit={(event) => void submit(event)}>
      {entity.fields.map((field) => {
        const value = String(values[field.name] ?? "");
        // Keep legacy free-form dates visible and editable instead of letting the browser blank them.
        const useDate = field.widget === "date" && (!value || (
          !value.startsWith("0000") && new Date(`${value}T00:00:00Z`).toJSON()?.slice(0, 10) === value
        ));
        return <label key={field.name}>{field.label}
          {field.type === "boolean"
            ? <input type="checkbox" checked={values[field.name] === true} onChange={(event) => setValues({ ...values, [field.name]: event.target.checked })} />
            : <input type={useDate ? "date" : field.type === "number" ? "number" : "text"} value={value} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} />}
        </label>;
      })}
      <label>公開範囲<select value={visibility} onChange={(event) => setVisibility(event.target.value as "shared" | "private")}><option value="private">非公開（作成者・オーナー）</option><option value="shared">メンバーに共有</option></select></label>
      <div className="actions"><button disabled={busy}>{editing ? "保存" : "登録"}</button>
        {editing && <button type="button" onClick={() => { setEditing(null); setValues({}); }}>キャンセル</button>}</div>
    </form>
    {records.length === 0 ? <p>データはありません。</p> : <ul>{records.map((record) => <li key={record.id}>
      {entity.fields.map((field) => `${field.label}: ${String(record[field.name] ?? "—")}`).join(" / ")} （{record.visibility === "private" ? "非公開" : "共有"}）
      <button onClick={() => {
        const next: Record<string, string | boolean> = {};
        for (const field of entity.fields) {
          const value = record[field.name];
          if (value !== null && value !== undefined) next[field.name] = field.type === "boolean" ? value === true : String(value);
        }
        setEditing(record.id); setValues(next); setVisibility(record.visibility);
      }}>編集</button>
      <button onClick={() => { void api(`${endpoint}/${record.id}`, "DELETE").then(load).catch((e: Error) => onError(e.message)); }}>削除</button>
    </li>)}</ul>}
  </article>;
}

const root = createRoot(document.getElementById("root")!);
root.render(import.meta.env.VITE_KONOHA_LEGACY_UI === "1" ? <App /> : <VmHome />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
