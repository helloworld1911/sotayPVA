// Sổ Tay Ôn Tập — API cho Cloudflare Workers + D1, có tài khoản người dùng
// Công khai: /api/config, /api/register, /api/login, /api/logout
// Cần đăng nhập: /api/me, /api/password, /api/data/:col[/:id], /api/ai

import { SEED } from "./seed.js";

const COLS = new Set(["notes", "quizzes", "attempts", "decks"]);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const USER_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MAX_DOC = 900 * 1024;
const SESSION_DAYS = 30;
const PBKDF2_ITER = 20000;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const randId = (n = 16) => b64url(crypto.getRandomValues(new Uint8Array(n)));
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
async function hashPassword(pw, saltB64, iter = PBKDF2_ITER) {
  const salt = saltB64 ? fromB64url(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64url(salt)}$${b64url(bits)}`;
}
async function verifyPassword(pw, stored) {
  const [, iter, salt] = String(stored).split("$");
  if (!iter || !salt) return false;
  return safeEqual(await hashPassword(pw, salt, +iter), stored);
}

/* ---------- database setup (runs once per Worker instance) ---------- */
let dbReady = null;
function ensureDb(env) {
  if (!dbReady)
    dbReady = (async () => {
      await env.DB.batch([
        env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT, pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS udocs (uid TEXT NOT NULL, col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (uid, col, id))"),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_udocs ON udocs (uid, col, updated_at)"),
      ]);
      if (!(await env.DB.prepare("SELECT v FROM meta WHERE k = 'secret'").first()))
        await env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('secret', ?)").bind(randId(32)).run();
      if (!(await env.DB.prepare("SELECT v FROM meta WHERE k = 'seeded2'").first())) {
        const st = SEED.map(([col, id, ts, doc]) =>
          env.DB.prepare("INSERT OR IGNORE INTO udocs (uid, col, id, data, updated_at) VALUES ('__seed__', ?, ?, ?, ?)").bind(col, id, JSON.stringify(doc), ts)
        );
        st.push(env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('seeded2', ?)").bind(String(Date.now())));
        await env.DB.batch(st);
        // dữ liệu từ phiên bản cũ (bảng docs, nếu có) cũng được giữ lại
        try { await env.DB.prepare("INSERT OR IGNORE INTO udocs (uid, col, id, data, updated_at) SELECT '__seed__', col, id, data, updated_at FROM docs").run(); } catch {}
      }
    })().catch((e) => { dbReady = null; throw e; });
  return dbReady;
}
let secretCache = null;
async function secretOf(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (!secretCache) secretCache = (await env.DB.prepare("SELECT v FROM meta WHERE k = 'secret'").first()).v;
  return secretCache;
}

/* ---------- sessions ---------- */
const cookie = (v, maxAge) => `st_session=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
async function makeToken(env, user) {
  // phiên gắn với 8 ký tự cuối của mã băm mật khẩu: đổi mật khẩu thì phiên cũ hết hiệu lực
  const body = `${user.id}.${Date.now() + SESSION_DAYS * 864e5}.${String(user.pass).slice(-8)}`;
  return b64url(enc.encode(body)) + "." + (await hmac(await secretOf(env), body));
}
async function currentUser(req, env) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)st_session=([^;]+)/);
  if (!m) return null;
  const [p, sig] = m[1].split(".");
  if (!p || !sig) return null;
  let body;
  try { body = new TextDecoder().decode(fromB64url(p)); } catch { return null; }
  if (!safeEqual(sig, await hmac(await secretOf(env), body))) return null;
  const [uid, exp, tail] = body.split(".");
  if (+exp < Date.now()) return null;
  const u = await env.DB.prepare("SELECT id, username, name, pass, role FROM users WHERE id = ?").bind(uid).first();
  if (!u || !safeEqual(String(u.pass).slice(-8), tail)) return null;
  return u;
}
const pub = (u) => ({ username: u.username, name: u.name || u.username, role: u.role });

/* ---------- account routes ---------- */
async function readBody(req) { try { return await req.json(); } catch { return {}; } }
async function register(req, env) {
  const b = await readBody(req);
  const username = String(b.username || "").trim(), password = String(b.password || ""), name = String(b.name || "").trim().slice(0, 60);
  if (env.INVITE_CODE && String(b.invite || "").trim() !== env.INVITE_CODE) return json({ error: "Mã mời không đúng." }, 403);
  if (!USER_RE.test(username)) return json({ error: "Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới, gạch ngang." }, 400);
  if (password.length < 8) return json({ error: "Mật khẩu cần ít nhất 8 ký tự." }, 400);
  if (await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first()) return json({ error: "Tên đăng nhập này đã có người dùng." }, 409);
  const first = !(await env.DB.prepare("SELECT 1 FROM users LIMIT 1").first());
  const user = { id: "u" + randId(12), username, name: name || username, pass: await hashPassword(password), role: first ? "admin" : "user" };
  await env.DB.prepare("INSERT INTO users (id, username, name, pass, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(user.id, user.username, user.name, user.pass, user.role, Date.now()).run();
  // tài khoản đầu tiên nhận toàn bộ dữ liệu có sẵn
  if (first) await env.DB.prepare("UPDATE udocs SET uid = ? WHERE uid = '__seed__'").bind(user.id).run();
  return json({ ok: true, user: pub(user), claimed: first }, 200, { "set-cookie": cookie(await makeToken(env, user), SESSION_DAYS * 86400) });
}
async function login(req, env) {
  const b = await readBody(req);
  const u = await env.DB.prepare("SELECT id, username, name, pass, role FROM users WHERE username = ?").bind(String(b.username || "").trim()).first();
  const ok = u ? await verifyPassword(String(b.password || ""), u.pass) : (await hashPassword("x"), false);
  if (!ok) { await new Promise((r) => setTimeout(r, 500)); return json({ error: "Sai tên đăng nhập hoặc mật khẩu." }, 401); }
  return json({ ok: true, user: pub(u) }, 200, { "set-cookie": cookie(await makeToken(env, u), SESSION_DAYS * 86400) });
}
async function changePassword(req, env, u) {
  const b = await readBody(req);
  if (!(await verifyPassword(String(b.old || ""), u.pass))) return json({ error: "Mật khẩu hiện tại không đúng." }, 403);
  if (String(b.new || "").length < 8) return json({ error: "Mật khẩu mới cần ít nhất 8 ký tự." }, 400);
  const pass = await hashPassword(String(b.new));
  await env.DB.prepare("UPDATE users SET pass = ? WHERE id = ?").bind(pass, u.id).run();
  return json({ ok: true }, 200, { "set-cookie": cookie(await makeToken(env, { ...u, pass }), SESSION_DAYS * 86400) });
}

/* ---------- data (mỗi người chỉ thấy dữ liệu của mình) ---------- */
async function data(req, env, u, col, id) {
  if (req.method === "GET" && !id) {
    const { results } = await env.DB.prepare("SELECT id, data FROM udocs WHERE uid = ? AND col = ? ORDER BY updated_at DESC").bind(u.id, col).all();
    return json({ docs: results.map((r) => ({ id: r.id, data: JSON.parse(r.data) })), at: Date.now() });
  }
  if (!id || !ID_RE.test(id)) return json({ error: "Mã bản ghi không hợp lệ." }, 400);
  if (req.method === "PUT") {
    const text = await req.text();
    if (text.length > MAX_DOC) return json({ error: "Bản ghi quá lớn." }, 413);
    let doc;
    try { doc = JSON.parse(text); } catch { return json({ error: "Dữ liệu không phải JSON." }, 400); }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return json({ error: "Dữ liệu phải là một đối tượng." }, 400);
    doc.id = id;
    await env.DB.prepare(
      "INSERT INTO udocs (uid, col, id, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(uid, col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    ).bind(u.id, col, id, JSON.stringify(doc), Date.now()).run();
    return json({ ok: true });
  }
  if (req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM udocs WHERE uid = ? AND col = ? AND id = ?").bind(u.id, col, id).run();
    return json({ ok: true });
  }
  return json({ error: "method_not_allowed" }, 405);
}

/* ---------- Claude (tuỳ chọn) ---------- */
async function ai(req, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Chưa cấu hình Claude.", code: "sampling_disabled" }, 501);
  const body = await readBody(req);
  const prompt = String(body.prompt || "").slice(0, 200000);
  if (!prompt.trim()) return json({ error: "Thiếu nội dung.", code: "invalid_request" }, 400);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env.AI_MODEL || "claude-sonnet-5-5",
      max_tokens: 8000,
      ...(body.json ? { system: "Câu trả lời sẽ được máy đọc tự động: chỉ trả về đúng một giá trị JSON hợp lệ, không thêm chữ nào khác, không dùng khối mã." } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = r.status === 429 || r.status === 529 ? "rate_limited" : r.status === 401 ? "sampling_disabled" : "upstream_error";
    return json({ error: out?.error?.message || "Lỗi khi gọi Claude.", code }, r.status === 429 ? 429 : 502);
  }
  const text = (out.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return json({ text, truncated: out.stop_reason === "max_tokens" });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", { status: 404 });
    try {
      if (!env.DB) return json({ error: "Chưa nối database: thêm binding D1 tên DB." }, 500);
      await ensureDb(env);
      if (p === "/api/config") return json({ inviteRequired: !!env.INVITE_CODE });
      if (p === "/api/register" && req.method === "POST") return await register(req, env);
      if (p === "/api/login" && req.method === "POST") return await login(req, env);
      if (p === "/api/logout" && req.method === "POST") return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
      const u = await currentUser(req, env);
      if (!u) return json({ error: "unauthorized" }, 401);
      if (p === "/api/me") return json({ ok: true, user: pub(u), ai: !!env.ANTHROPIC_API_KEY });
      if (p === "/api/password" && req.method === "POST") return await changePassword(req, env, u);
      if (p === "/api/ai" && req.method === "POST") return await ai(req, env);
      const m = p.match(/^\/api\/data\/([a-z]+)(?:\/([^/]+))?$/);
      if (m && COLS.has(m[1])) return await data(req, env, u, m[1], m[2] ? decodeURIComponent(m[2]) : null);
      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "Lỗi máy chủ: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
};
