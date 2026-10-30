// Sổ Tay Ôn Tập — API cho Cloudflare Workers + D1
// /api/login, /api/logout, /api/me, /api/data/:col[/:id], /api/ai

const COLS = new Set(["notes", "quizzes", "attempts", "decks"]);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC = 900 * 1024; // 900 KB mỗi bản ghi
const SESSION_DAYS = 30;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const enc = new TextEncoder();
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const secretOf = (env) => "so-tay::" + (env.APP_PASSWORD || "");

function cookie(value, maxAge) {
  return `st_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
async function makeToken(env) {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return exp + "." + (await hmac(secretOf(env), exp));
}
async function authed(req, env) {
  if (!env.APP_PASSWORD) return false;
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)st_session=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || +exp < Date.now()) return false;
  return safeEqual(sig, await hmac(secretOf(env), exp));
}

async function login(req, env) {
  if (!env.APP_PASSWORD) return json({ error: "Chưa đặt mật khẩu APP_PASSWORD cho web." }, 500);
  let body = {};
  try { body = await req.json(); } catch {}
  const given = String(body.password || "");
  const ok = safeEqual(await hmac(secretOf(env), "pw:" + given), await hmac(secretOf(env), "pw:" + env.APP_PASSWORD));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: "Sai mật khẩu." }, 401);
  }
  return json({ ok: true }, 200, { "set-cookie": cookie(await makeToken(env), SESSION_DAYS * 86400) });
}

async function data(req, env, col, id) {
  if (req.method === "GET" && !id) {
    const { results } = await env.DB.prepare("SELECT id, data FROM docs WHERE col = ? ORDER BY updated_at DESC").bind(col).all();
    return json({ docs: results.map((r) => ({ id: r.id, data: JSON.parse(r.data) })), at: Date.now() });
  }
  if (!id || !ID_RE.test(id)) return json({ error: "Mã bản ghi không hợp lệ." }, 400);
  if (req.method === "GET") {
    const row = await env.DB.prepare("SELECT data FROM docs WHERE col = ? AND id = ?").bind(col, id).first();
    return row ? json({ id, data: JSON.parse(row.data) }) : json({ error: "not_found" }, 404);
  }
  if (req.method === "PUT") {
    const text = await req.text();
    if (text.length > MAX_DOC) return json({ error: "Bản ghi quá lớn." }, 413);
    let doc;
    try { doc = JSON.parse(text); } catch { return json({ error: "Dữ liệu không phải JSON." }, 400); }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return json({ error: "Dữ liệu phải là một đối tượng." }, 400);
    doc.id = id;
    await env.DB.prepare(
      "INSERT INTO docs (col, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    ).bind(col, id, JSON.stringify(doc), Date.now()).run();
    return json({ ok: true });
  }
  if (req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM docs WHERE col = ? AND id = ?").bind(col, id).run();
    return json({ ok: true });
  }
  return json({ error: "method_not_allowed" }, 405);
}

async function ai(req, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Chưa cấu hình Claude.", code: "sampling_disabled" }, 501);
  let body = {};
  try { body = await req.json(); } catch {}
  const prompt = String(body.prompt || "").slice(0, 200000);
  if (!prompt.trim()) return json({ error: "Thiếu nội dung.", code: "invalid_request" }, 400);
  const sys = body.json
    ? "Câu trả lời của bạn sẽ được máy đọc tự động: chỉ trả về đúng một giá trị JSON hợp lệ, không thêm chữ nào khác, không dùng khối mã."
    : undefined;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.AI_MODEL || "claude-sonnet-5-5",
      max_tokens: 8000,
      ...(sys ? { system: sys } : {}),
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

const SEED = [["notes", "scrum-guide-2020", 1793322766849, {"content": "> Nguồn: *The Scrum Guide* (Ken Schwaber & Jeff Sutherland, 11/2020). Tóm tắt để ôn thi PMP.\n\n## 1. Scrum là gì?\nScrum là **framework gọn nhẹ** giúp con người, đội nhóm và tổ chức tạo ra giá trị thông qua giải pháp thích ứng cho **vấn đề phức tạp**.\n\nVòng lặp cốt lõi:\n1. Product Owner sắp xếp công việc vào **Product Backlog**\n2. Scrum Team biến một phần công việc thành **Increment** trong một **Sprint**\n3. Team và stakeholders kiểm tra kết quả, điều chỉnh cho Sprint sau\n4. Lặp lại\n\nScrum **cố ý không đầy đủ**: chỉ định nghĩa phần bắt buộc, kỹ thuật cụ thể do team tự áp dụng.\n\n## 2. Nền tảng lý thuyết\n- **Empiricism (thực nghiệm):** tri thức đến từ kinh nghiệm, quyết định dựa trên quan sát\n- **Lean thinking:** giảm lãng phí, tập trung vào điều cốt yếu\n- Cách tiếp cận **lặp và tăng dần** để tăng khả năng dự đoán, kiểm soát rủi ro\n\n### 3 trụ cột thực nghiệm\n| Trụ cột | Ý nghĩa | Liên kết |\n|---|---|---|\n| **Transparency** | Quy trình, công việc hiển thị cho người làm và người nhận | Minh bạch → cho phép kiểm tra |\n| **Inspection** | Thường xuyên kiểm tra artifact và tiến độ | Kiểm tra → cho phép thích ứng |\n| **Adaptation** | Lệch khỏi giới hạn thì điều chỉnh càng sớm càng tốt | Cần team được trao quyền, tự quản |\n\n## 3. Năm giá trị Scrum\n**Commitment, Focus, Openness, Respect, Courage** (Cam kết, Tập trung, Cởi mở, Tôn trọng, Dũng cảm). Khi sống đúng các giá trị này, 3 trụ cột phát huy tác dụng và tạo **niềm tin**.\n\n## 4. Scrum Team\n- **1 Scrum Master + 1 Product Owner + Developers**, thường **≤ 10 người**\n- Không có nhóm con, không phân cấp\n- **Cross-functional** (đủ kỹ năng) và **self-managing** (tự quyết ai làm gì, khi nào, thế nào)\n- Team quá lớn → tách thành nhiều team, dùng **chung Product Goal, Product Backlog, Product Owner**\n\n### Developers\n- Lập **Sprint Backlog**\n- Đảm bảo chất lượng theo **Definition of Done**\n- Điều chỉnh kế hoạch hằng ngày hướng tới Sprint Goal\n- Giữ nhau chịu trách nhiệm như người chuyên nghiệp\n\n### Product Owner\n- Chịu trách nhiệm **tối đa hoá giá trị sản phẩm**\n- Xây dựng, truyền đạt **Product Goal**; tạo và **sắp xếp thứ tự** Product Backlog\n- Có thể uỷ quyền nhưng **vẫn giữ trách nhiệm**\n- Là **một người, không phải uỷ ban**\n\n### Scrum Master\n- Chịu trách nhiệm thiết lập Scrum đúng Guide và **hiệu quả của team**\n- **Servant leader**, phục vụ 3 đối tượng: Scrum Team, Product Owner, tổ chức\n- Loại bỏ trở ngại, đảm bảo sự kiện diễn ra đúng timebox\n\n## 5. Năm sự kiện Scrum\n| Sự kiện | Mục đích | Timebox (Sprint 1 tháng) | Ai tham gia |\n|---|---|---|---|\n| **Sprint** | Container cho mọi sự kiện | **≤ 1 tháng** | Cả team |\n| **Sprint Planning** | Lập kế hoạch Sprint | **≤ 8 giờ** | Cả Scrum Team |\n| **Daily Scrum** | Kiểm tra tiến độ tới Sprint Goal | **15 phút** | **Developers** |\n| **Sprint Review** | Kiểm tra kết quả, quyết định bước tiếp | **≤ 4 giờ** | Team + stakeholders |\n| **Sprint Retrospective** | Nâng cao chất lượng, hiệu quả | **≤ 3 giờ** | Scrum Team |\n\n- **Chỉ PO mới được huỷ Sprint**, khi Sprint Goal lỗi thời\n- Sprint Planning trả lời 3 câu: **Why** (Sprint Goal), **What** (chọn item), **How** (chỉ Developers quyết định)\n- Sprint Review là **buổi làm việc**, không chỉ thuyết trình; là sự kiện áp chót\n- Retrospective **kết thúc Sprint**\n\n## 6. Ba artifact và cam kết\n| Artifact | Commitment |\n|---|---|\n| **Product Backlog** | **Product Goal** |\n| **Sprint Backlog** | **Sprint Goal** |\n| **Increment** | **Definition of Done** |\n\n- **Developers** chịu trách nhiệm ước lượng kích thước item\n- Có thể có **nhiều Increment trong một Sprint**, giao trước khi Sprint kết thúc\n- Item chưa đạt DoD → **không phát hành, không trình bày** ở Sprint Review, quay lại backlog\n\n## 7. Bẫy hay gặp khi thi PMP\n- Scrum Master **không phải** quản lý dự án hay người giao việc\n- Daily Scrum là sự kiện **của Developers**\n- Bản 2020: \"accountabilities\" thay \"roles\", \"Developers\" thay \"Development Team\", thêm **Product Goal**, nhấn mạnh **self-managing**\n- Áp dụng một phần thì **không còn là Scrum**\n", "createdAt": 1793322766849, "id": "scrum-guide-2020", "pinned": true, "reviews": 0, "subject": "PMP", "tags": ["scrum", "agile", "scrum guide"], "title": "Scrum Guide 2020 — Tóm tắt trọng tâm", "updatedAt": 1793322766849}], ["quizzes", "z-scrum-guide-2020", 1793325715316, {"createdAt": 1793325715316, "id": "z-scrum-guide-2020", "questions": [{"ans": [2], "exp": "Product Owner chịu trách nhiệm quản lý Product Backlog, bao gồm tạo, truyền đạt và **sắp xếp thứ tự** các hạng mục. PO có thể uỷ quyền công việc nhưng vẫn giữ trách nhiệm.", "id": "sg01", "opts": ["Scrum Master", "Developers", "Product Owner", "Các stakeholder chính"], "q": "Ai chịu trách nhiệm sắp xếp thứ tự (ordering) các hạng mục trong Product Backlog?"}, {"ans": [2], "exp": "Sprint Planning tối đa **8 giờ** cho Sprint 1 tháng; Sprint ngắn hơn thì thường ngắn hơn. Sprint Review tối đa 4 giờ, Retrospective tối đa 3 giờ.", "id": "sg02", "opts": ["2 giờ", "4 giờ", "8 giờ", "1 ngày làm việc trọn vẹn có thể kéo dài"], "q": "Với Sprint dài 1 tháng, Sprint Planning được timebox tối đa bao lâu?"}, {"ans": [1], "exp": "Chỉ **Product Owner** có quyền huỷ Sprint, và thường chỉ khi Sprint Goal trở nên lỗi thời.", "id": "sg03", "opts": ["Scrum Master", "Product Owner", "Developers khi đồng thuận", "Nhà tài trợ dự án (sponsor)"], "q": "Ai có thẩm quyền huỷ một Sprint?"}, {"ans": [1], "exp": "Daily Scrum là sự kiện **15 phút của Developers**, cùng giờ cùng chỗ mỗi ngày. PO hoặc SM chỉ tham gia với tư cách Developer nếu họ đang làm hạng mục trong Sprint Backlog.", "id": "sg04", "opts": ["Cả Scrum Team, 30 phút", "Developers, 15 phút", "Scrum Master và Developers, 15 phút", "Product Owner và Developers, tối đa 1 giờ"], "q": "Daily Scrum là sự kiện dành cho ai và kéo dài bao lâu?"}, {"ans": [2], "exp": "Mỗi artifact có một cam kết: Product Backlog → Product Goal, Sprint Backlog → Sprint Goal, **Increment → Definition of Done**.", "id": "sg05", "opts": ["Sprint Goal", "Product Goal", "Definition of Done", "Acceptance criteria"], "q": "Cam kết (commitment) đi kèm với Increment là gì?"}, {"ans": [2], "exp": "Hạng mục chưa đạt DoD **không được phát hành, cũng không được trình bày** ở Sprint Review; nó quay lại Product Backlog. Sprint có độ dài cố định nên không kéo dài.", "id": "sg06", "opts": ["Trình bày ở Sprint Review với ghi chú là 'gần xong'", "Kéo dài Sprint thêm vài ngày để hoàn thành", "Quay lại Product Backlog để xem xét sau", "Đánh dấu Done nhưng ghi nợ kỹ thuật"], "q": "Cuối Sprint, một hạng mục chưa đạt Definition of Done. Điều gì xảy ra với nó?"}, {"ans": [1], "exp": "Ba trụ cột là **Transparency, Inspection, Adaptation**. Minh bạch cho phép kiểm tra; kiểm tra cho phép thích ứng. Commitment, Focus, Openness thuộc 5 giá trị Scrum.", "id": "sg07", "opts": ["Commitment, Focus, Openness", "Transparency, Inspection, Adaptation", "Planning, Execution, Review", "Respect, Courage, Transparency"], "q": "Ba trụ cột của chủ nghĩa thực nghiệm (empiricism) trong Scrum là gì?"}, {"ans": [2], "exp": "**Developers** – những người sẽ làm công việc – chịu trách nhiệm sizing. Product Owner có thể tác động bằng cách giúp họ hiểu và lựa chọn các đánh đổi.", "id": "sg08", "opts": ["Product Owner", "Scrum Master", "Developers sẽ thực hiện công việc", "Quản lý cấp trên"], "q": "Ai chịu trách nhiệm ước lượng kích thước (sizing) các hạng mục Product Backlog?"}, {"ans": [1], "exp": "Scrum Team thường **10 người trở xuống**. Team quá lớn nên tách thành nhiều Scrum Team cùng tập trung vào một sản phẩm.", "id": "sg09", "opts": ["3–5 người", "10 người trở xuống", "Tối thiểu 12 người", "Không giới hạn nếu có Scrum Master"], "q": "Theo Scrum Guide, quy mô điển hình của một Scrum Team là bao nhiêu?"}, {"ans": [1], "exp": "Các team cùng sản phẩm dùng **chung Product Goal, Product Backlog và Product Owner**, và cùng tuân thủ một Definition of Done. Mỗi team có Sprint Backlog riêng.", "id": "sg10", "opts": ["Chung Scrum Master, Sprint Backlog và Daily Scrum", "Chung Product Goal, Product Backlog và Product Owner", "Mỗi team có Product Owner riêng nhưng chung Product Backlog", "Chung Sprint Goal và Sprint Backlog"], "q": "Nhiều Scrum Team cùng làm một sản phẩm thì phải dùng chung những gì?"}, {"ans": [1], "exp": "**Sprint Retrospective** kết thúc Sprint (timebox tối đa 3 giờ cho Sprint 1 tháng). Sprint Review là sự kiện áp chót.", "id": "sg11", "opts": ["Sprint Review", "Sprint Retrospective", "Lần phát hành cuối cùng", "Buổi Product Backlog refinement"], "q": "Sự kiện nào kết thúc một Sprint?"}, {"ans": [2], "exp": "Ai muốn thay đổi Product Backlog phải **thuyết phục Product Owner**. Trong Sprint, phạm vi có thể được làm rõ và đàm phán lại với PO nhưng không được làm nguy hại Sprint Goal.", "id": "sg12", "opts": ["Làm ngay vì stakeholder là người trả tiền", "Từ chối và yêu cầu chờ đến Sprint sau, không cần trao đổi thêm", "Đưa yêu cầu đến Product Owner để PO quyết định thứ tự trong Product Backlog", "Nhờ Scrum Master phê duyệt rồi thêm vào Sprint Backlog"], "q": "Giữa Sprint, một stakeholder yêu cầu Developers làm ngay một tính năng mới chưa có trong kế hoạch. Developers nên làm gì?"}, {"ans": [2], "exp": "Scrum Master phục vụ team bằng cách **khiến các trở ngại được loại bỏ** (causing the removal of impediments) và xoá rào cản giữa stakeholder với Scrum Team.", "id": "sg13", "opts": ["Tự làm thay phần việc bị chặn", "Ghi nhận và chờ Retrospective để bàn", "Giúp tác động để loại bỏ trở ngại, kể cả làm việc với phòng ban kia", "Báo cáo để quản lý cấp trên khiển trách phòng ban đó"], "q": "Developers bị một phòng ban khác chặn tiến độ (impediment) suốt nhiều ngày. Scrum Master nên làm gì?"}, {"ans": [0, 2], "exp": "5 giá trị Scrum: Commitment, **Focus**, Openness, Respect, **Courage**. Transparency là trụ cột thực nghiệm, Velocity và Predictability không phải giá trị Scrum.", "id": "sg14", "opts": ["Courage", "Velocity", "Focus", "Transparency", "Predictability"], "q": "Chọn HAI giá trị thuộc 5 giá trị Scrum."}, {"ans": [1], "exp": "Có thể tạo nhiều Increment trong một Sprint và **giao trước khi Sprint kết thúc**. Sprint Review không bao giờ được coi là cổng chặn việc phát hành.", "id": "sg15", "opts": ["Không, chỉ được giao sau Sprint Review", "Có, Sprint Review không phải là cổng để phát hành giá trị", "Chỉ khi Scrum Master đồng ý", "Chỉ khi Sprint bị huỷ"], "q": "Một Increment có thể được giao cho stakeholder trước khi Sprint kết thúc không?"}, {"ans": [1], "exp": "PO đề xuất cách tăng giá trị, rồi **cả Scrum Team cùng xác định Sprint Goal trong Sprint Planning**; Sprint Goal phải được chốt trước khi Sprint Planning kết thúc.", "id": "sg16", "opts": ["Trước khi bắt đầu Sprint Planning, do Product Owner viết sẵn", "Trong Sprint Planning, và phải chốt trước khi Planning kết thúc", "Trong Daily Scrum đầu tiên của Sprint", "Tại Sprint Review của Sprint trước"], "q": "Sprint Goal được tạo ra khi nào?"}], "sourceNoteId": "scrum-guide-2020", "subject": "PMP", "title": "Scrum Guide 2020 – 16 câu ôn nhanh", "updatedAt": 1793325715316}], ["quizzes", "zmvubu2912numc", 1793325740345, {"createdAt": 1793325726181, "id": "zmvubu2912numc", "questions": [{"ans": [1], "exp": "Scrum là framework gọn nhẹ dành cho vấn đề phức tạp và cố ý không đầy đủ, chỉ định nghĩa phần bắt buộc. Nó không quy định chi tiết kỹ thuật, không phải quy trình tuần tự và không phải bộ công cụ cho Project Manager.", "id": "qmvubu291h4pdi", "opts": ["Một phương pháp quản lý dự án quy định chi tiết kỹ thuật cho từng vai trò", "Một framework gọn nhẹ giúp tạo giá trị thông qua giải pháp thích ứng cho vấn đề phức tạp", "Một quy trình tuần tự gồm các giai đoạn phân tích, thiết kế, kiểm thử và phát hành", "Một bộ công cụ ước lượng và theo dõi tiến độ dành cho Project Manager"], "q": "Theo Scrum Guide 2020, Scrum được mô tả chính xác nhất là gì?"}, {"ans": [2], "exp": "Minh bạch (Transparency) giúp mọi người nhìn thấy công việc nên có thể kiểm tra (Inspection). Kiểm tra phát hiện lệch hướng nên cho phép điều chỉnh (Adaptation). Các lựa chọn còn lại đảo ngược hoặc phủ nhận chuỗi liên kết này.", "id": "qmvubu291oe47c", "opts": ["Inspection cho phép Transparency, Transparency cho phép Adaptation", "Adaptation cho phép Inspection, Inspection cho phép Transparency", "Transparency cho phép Inspection, Inspection cho phép Adaptation", "Transparency và Adaptation độc lập, chỉ Inspection liên kết với hai trụ cột còn lại"], "q": "Trong 3 trụ cột thực nghiệm của Scrum, mối liên hệ nào sau đây là đúng?"}, {"ans": [1], "exp": "Chỉ Product Owner mới được huỷ Sprint, và chỉ khi Sprint Goal trở nên lỗi thời. Scrum Master, Developers và stakeholders không có quyền này.", "id": "qmvubu291y0ygd", "opts": ["Scrum Master, khi Developers không thể hoàn thành hết Sprint Backlog", "Product Owner, khi Sprint Goal đã lỗi thời", "Developers, khi phát hiện item không đạt Definition of Done", "Stakeholders, khi họ không hài lòng với kết quả tại Sprint Review"], "q": "Ai là người duy nhất có quyền huỷ một Sprint, và trong trường hợp nào?"}, {"ans": [0], "exp": "Sprint Planning trả lời ba câu hỏi Why, What, How, trong đó phần How chỉ do Developers quyết định vì họ là người thực hiện công việc. Product Owner và Scrum Master không quyết định cách thực hiện.", "id": "qmvubu2915k5ia", "opts": ["Chỉ Developers", "Product Owner và Scrum Master", "Toàn bộ Scrum Team bỏ phiếu", "Product Owner cùng stakeholders"], "q": "Trong Sprint Planning, phần \"How\" (làm thế nào để thực hiện các item đã chọn) do ai quyết định?"}, {"ans": [0], "exp": "Theo Scrum Guide, Sprint 1 tháng có Sprint Planning tối đa 8 giờ, Sprint Review tối đa 4 giờ và Sprint Retrospective tối đa 3 giờ. Các lựa chọn khác hoán đổi hoặc đưa ra số giờ không có trong Guide.", "id": "qmvubu291e87gm", "opts": ["8 giờ, 4 giờ, 3 giờ", "4 giờ, 8 giờ, 3 giờ", "8 giờ, 3 giờ, 4 giờ", "6 giờ, 4 giờ, 2 giờ"], "q": "Với Sprint dài 1 tháng, timebox tối đa của Sprint Planning, Sprint Review và Sprint Retrospective lần lượt là bao nhiêu?"}, {"ans": [1], "exp": "Daily Scrum kéo dài 15 phút, là sự kiện của Developers để kiểm tra tiến độ hướng tới Sprint Goal và điều chỉnh kế hoạch. Đây không phải buổi báo cáo cho quản lý và không có stakeholders bắt buộc tham dự.", "id": "qmvubu291wso35", "opts": ["Là buổi báo cáo tiến độ hằng ngày cho Scrum Master và Product Owner", "Kéo dài 15 phút và là sự kiện của Developers nhằm kiểm tra tiến độ tới Sprint Goal", "Kéo dài tối đa 1 giờ và bắt buộc có stakeholders tham dự", "Là buổi lập kế hoạch lại toàn bộ Product Backlog mỗi ngày"], "q": "Phát biểu nào về Daily Scrum là đúng?"}, {"ans": [0, 2], "exp": "Product Owner chịu trách nhiệm tối đa hoá giá trị sản phẩm và là một người, không phải uỷ ban. Việc giao việc là do Developers tự quản, còn ước lượng kích thước item là trách nhiệm của Developers.", "id": "qmvubu2911uc9k", "opts": ["Chịu trách nhiệm tối đa hoá giá trị sản phẩm", "Giao việc cụ thể cho từng Developer trong Sprint", "Là một người, không phải uỷ ban", "Chịu trách nhiệm ước lượng kích thước các item trong Product Backlog"], "q": "Chọn HAI đáp án đúng về trách nhiệm của Product Owner theo Scrum Guide 2020."}, {"ans": [1], "exp": "Product Backlog gắn với Product Goal, Sprint Backlog gắn với Sprint Goal và Increment gắn với Definition of Done. Các lựa chọn khác ghép sai ít nhất một cặp.", "id": "qmvubu291lighm", "opts": ["Product Backlog – Sprint Goal; Sprint Backlog – Definition of Done; Increment – Product Goal", "Product Backlog – Product Goal; Sprint Backlog – Sprint Goal; Increment – Definition of Done", "Product Backlog – Definition of Done; Sprint Backlog – Product Goal; Increment – Sprint Goal", "Product Backlog – Sprint Goal; Sprint Backlog – Product Goal; Increment – Definition of Done"], "q": "Mỗi artifact trong Scrum đi kèm một commitment. Cặp ghép nào sau đây là đúng?"}, {"ans": [2], "exp": "Item chưa đạt Definition of Done thì chưa là một phần của Increment nên không được phát hành hay trình bày ở Sprint Review, và quay lại Product Backlog. Product Owner sẽ sắp xếp lại thứ tự của nó cùng các item khác.", "id": "qmvubu291zh673", "opts": ["Vẫn được phát hành nhưng đánh dấu là chưa hoàn chỉnh", "Được trình bày ở Sprint Review để stakeholders quyết định", "Không được phát hành, không được trình bày ở Sprint Review và quay lại Product Backlog", "Được chuyển thẳng sang Sprint Backlog của Sprint kế tiếp mà không cần sắp xếp lại"], "q": "Một item được làm xong trong Sprint nhưng chưa đạt Definition of Done. Điều gì xảy ra với item này?"}, {"ans": [1], "exp": "Scrum Master là servant leader, phục vụ ba đối tượng là Scrum Team, Product Owner và tổ chức. Họ không phải quản lý dự án hay người giao việc, và việc sắp xếp Product Backlog thuộc về Product Owner.", "id": "qmvubu2910zgp3", "opts": ["Là người quản lý dự án giao việc cho Developers", "Là servant leader phục vụ Scrum Team, Product Owner và tổ chức", "Là người duy nhất quyết định thứ tự Product Backlog", "Chỉ chịu trách nhiệm với Scrum Team, không làm việc với tổ chức"], "q": "Phát biểu nào sau đây về Scrum Master là đúng theo Scrum Guide 2020?"}], "sourceNoteId": "scrum-guide-2020", "subject": "PMP", "title": "Kiểm tra: Scrum Guide 2020 — Tóm tắt trọng tâm", "updatedAt": 1793325740345}], ["attempts", "amvuc1nhey9e5a", 1793326080290, {"correct": 6, "finishedAt": 1793326080290, "id": "amvuc1nhey9e5a", "items": [{"ok": true, "p": [1], "q": "qmvubu291wso35"}, {"ok": false, "p": [1], "q": "qmvubu291zh673"}, {"ok": true, "p": [1], "q": "qmvubu2910zgp3"}, {"ok": true, "p": [2], "q": "qmvubu291oe47c"}, {"ok": true, "p": [1], "q": "qmvubu291lighm"}, {"ok": false, "p": [2], "q": "qmvubu2915k5ia"}, {"ok": false, "p": [0, 3], "q": "qmvubu2911uc9k"}, {"ok": true, "p": [1], "q": "qmvubu291h4pdi"}, {"ok": false, "p": [0], "q": "qmvubu291y0ygd"}, {"ok": true, "p": [0], "q": "qmvubu291e87gm"}], "mode": "practice", "pct": 60, "quizId": "zmvubu2912numc", "quizTitle": "Kiểm tra: Scrum Guide 2020 — Tóm tắt trọng tâm", "retry": false, "secs": 336, "startedAt": 1793325744275, "total": 10}], ["decks", "d-pmp-terms", 1793326689232, {"cards": [{"d": "(n) bên liên quan", "ex": "Keep every stakeholder informed about the schedule. (Hãy cập nhật tiến độ cho mọi bên liên quan.)", "id": "c01", "ph": "/ˈsteɪkˌhoʊldər/", "t": "stakeholder"}, {"d": "(n) sản phẩm bàn giao", "ex": "The first deliverable is due on Friday. (Sản phẩm bàn giao đầu tiên phải nộp vào thứ Sáu.)", "id": "c02", "ph": "/dɪˈlɪvərəbəl/", "t": "deliverable"}, {"d": "(n) cột mốc quan trọng", "ex": "We reached a major milestone this week. (Tuần này chúng ta đã đạt một cột mốc lớn.)", "id": "c03", "ph": "/ˈmaɪlˌstoʊn/", "t": "milestone"}, {"d": "(n) phạm vi (công việc của dự án)", "ex": "This feature is outside the project scope. (Tính năng này nằm ngoài phạm vi dự án.)", "id": "c04", "ph": "/skoʊp/", "t": "scope"}, {"d": "(n) sự phình phạm vi ngoài kiểm soát", "ex": "Clear requirements help prevent scope creep. (Yêu cầu rõ ràng giúp tránh phình phạm vi.)", "id": "c05", "ph": "/ˈskoʊp ˌkrip/", "t": "scope creep"}, {"d": "(n) đường cơ sở, bản kế hoạch đã phê duyệt", "ex": "Compare actual costs with the cost baseline. (So sánh chi phí thực tế với đường cơ sở chi phí.)", "id": "c06", "ph": "/ˈbeɪsˌlaɪn/", "t": "baseline"}, {"d": "(n) ràng buộc, giới hạn", "ex": "Budget is our biggest constraint. (Ngân sách là ràng buộc lớn nhất của chúng ta.)", "id": "c07", "ph": "/kənˈstreɪnt/", "t": "constraint"}, {"d": "(n) giả định", "ex": "Write every assumption in the project charter. (Ghi mọi giả định vào điều lệ dự án.)", "id": "c08", "ph": "/əˈsʌmpʃən/", "t": "assumption"}, {"d": "(n) sổ đăng ký rủi ro", "ex": "Add the new risk to the risk register. (Thêm rủi ro mới vào sổ đăng ký rủi ro.)", "id": "c09", "ph": "/ˈrɪsk ˌrɛdʒɪstər/", "t": "risk register"}, {"d": "(v) giảm thiểu (rủi ro, tác động)", "ex": "We added extra testing to mitigate the risk. (Chúng tôi thêm kiểm thử để giảm thiểu rủi ro.)", "id": "c10", "ph": "/ˈmɪtɪˌɡeɪt/", "t": "mitigate"}, {"d": "(v) báo cáo lên cấp cao hơn để xử lý", "ex": "If the vendor is late again, escalate the issue. (Nếu nhà cung cấp lại trễ, hãy báo lên cấp trên.)", "id": "c11", "ph": "/ˈɛskəˌleɪt/", "t": "escalate"}, {"d": "(n) nhà tài trợ dự án", "ex": "The sponsor approved the extra budget. (Nhà tài trợ đã duyệt thêm ngân sách.)", "id": "c12", "ph": "/ˈspɑnsər/", "t": "sponsor"}, {"d": "(n) điều lệ dự án", "ex": "The project charter gives the manager authority. (Điều lệ dự án trao quyền cho người quản lý.)", "id": "c13", "ph": "/ˈprɑdʒɛkt ˌtʃɑrtər/", "t": "project charter"}, {"d": "(n) cấu trúc phân rã công việc (WBS)", "ex": "Break the scope into a work breakdown structure. (Chia nhỏ phạm vi thành cấu trúc phân rã công việc.)", "id": "c14", "ph": "/ˈwɜrk ˈbreɪkˌdaʊn ˈstrʌktʃər/", "t": "work breakdown structure"}, {"d": "(n) đường găng", "ex": "Any delay on the critical path delays the project. (Trễ trên đường găng sẽ làm trễ cả dự án.)", "id": "c15", "ph": "/ˈkrɪtɪkəl ˈpæθ/", "t": "critical path"}, {"d": "(n) bài học kinh nghiệm", "ex": "Share lessons learned at the end of each phase. (Chia sẻ bài học kinh nghiệm cuối mỗi giai đoạn.)", "id": "c16", "ph": "/ˈlɛsənz ˈlɜrnd/", "t": "lessons learned"}, {"d": "(n) yêu cầu thay đổi", "ex": "Submit a change request before changing the scope. (Gửi yêu cầu thay đổi trước khi đổi phạm vi.)", "id": "c17", "ph": "/ˈtʃeɪndʒ rɪˌkwɛst/", "t": "change request"}, {"d": "(n) danh sách công việc cần làm", "ex": "The product owner orders the backlog. (Product Owner sắp xếp thứ tự danh sách công việc.)", "id": "c18", "ph": "/ˈbækˌlɔɡ/", "t": "backlog"}, {"d": "(n) phần sản phẩm hoàn thành thêm", "ex": "Each sprint delivers a usable increment. (Mỗi sprint tạo ra một phần sản phẩm dùng được.)", "id": "c19", "ph": "/ˈɪŋkrəmənt/", "t": "increment"}, {"d": "(n) tốc độ hoàn thành công việc của nhóm", "ex": "Our velocity improved after the retrospective. (Tốc độ của nhóm tăng sau buổi nhìn lại.)", "id": "c20", "ph": "/vəˈlɑsəti/", "t": "velocity"}, {"d": "(n) trở ngại", "ex": "The Scrum Master removes impediments. (Scrum Master loại bỏ các trở ngại.)", "id": "c21", "ph": "/ɪmˈpɛdəmənt/", "t": "impediment"}, {"d": "(n) buổi nhìn lại, rút kinh nghiệm", "ex": "We hold a retrospective at the end of every sprint. (Chúng tôi họp nhìn lại vào cuối mỗi sprint.)", "id": "c22", "ph": "/ˌrɛtrəˈspɛktɪv/", "t": "retrospective"}, {"d": "(n) lãnh đạo phục vụ", "ex": "Servant leadership puts the team's needs first. (Lãnh đạo phục vụ đặt nhu cầu của nhóm lên trước.)", "id": "c23", "ph": "/ˈsɜrvənt ˈlidərʃɪp/", "t": "servant leadership"}, {"d": "(v) sắp xếp thứ tự ưu tiên", "ex": "We need to prioritize the most valuable features. (Chúng ta cần ưu tiên những tính năng giá trị nhất.)", "id": "c24", "ph": "/praɪˈɔrəˌtaɪz/", "t": "prioritize"}, {"d": "(n) vòng lặp, chu kỳ phát triển", "ex": "The team delivers working software every iteration. (Nhóm bàn giao phần mềm chạy được sau mỗi vòng lặp.)", "id": "c25", "ph": "/ˌɪtəˈreɪʃən/", "t": "iteration"}], "createdAt": 1793326689232, "id": "d-pmp-terms", "lang": "en-US", "subject": "Tiếng Anh", "title": "PMP – thuật ngữ tiếng Anh cốt lõi", "updatedAt": 1793326689232}]];

// Tự tạo bảng (và nạp dữ liệu ban đầu một lần) khi Worker chạy lần đầu
let dbReady=null;
function ensureDb(env){
  if(!dbReady)dbReady=(async()=>{
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (col, id))"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_docs_col_updated ON docs (col, updated_at)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)"),
    ]);
    const done=await env.DB.prepare("SELECT v FROM meta WHERE k = 'seeded'").first();
    if(!done){
      const st=SEED.map(([col,id,ts,doc])=>env.DB.prepare("INSERT OR IGNORE INTO docs (col, id, data, updated_at) VALUES (?, ?, ?, ?)").bind(col,id,JSON.stringify(doc),ts));
      st.push(env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('seeded', ?)").bind(String(Date.now())));
      await env.DB.batch(st);
    }
  })().catch(e=>{dbReady=null;throw e});
  return dbReady;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (url.pathname === "/api/login" && req.method === "POST") return await login(req, env);
      if (url.pathname === "/api/logout" && req.method === "POST") return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
      if (!(await authed(req, env))) return json({ error: "unauthorized" }, 401);
      if (!env.DB) return json({ error: "Chưa nối database: thêm binding D1 tên DB trong Settings → Bindings." }, 500);
      await ensureDb(env);
      if (url.pathname === "/api/me") return json({ ok: true, ai: !!env.ANTHROPIC_API_KEY });
      if (url.pathname === "/api/ai" && req.method === "POST") return await ai(req, env);
      const m = url.pathname.match(/^\/api\/data\/([a-z]+)(?:\/([^/]+))?$/);
      if (m && COLS.has(m[1])) return await data(req, env, m[1], m[2] ? decodeURIComponent(m[2]) : null);
      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "Lỗi máy chủ: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
};
