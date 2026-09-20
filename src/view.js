// 展示层：曝光批次与冲洗联审台页面（只负责渲染，业务判定全部来自接口返回）

import { STATUSES } from "./domain.js";

export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>曝光批次与冲洗联审台</title>
  <style>
    :root { --bg:#eef1ea; --panel:#fff; --ink:#1f241d; --muted:#667060; --line:#d2dccb; --accent:#4c6b3d; --warn:#9b4937; --hold:#8a6d1f; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:25px; } h2 { margin:0 0 12px; font-size:17px; }
    main { display:grid; grid-template-columns:370px 1fr; gap:20px; padding:20px 28px; align-items:start; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:15px; }
    form + form { margin-top:14px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .checks { display:flex; gap:14px; align-items:center; margin-top:8px; }
    .checks label { display:flex; gap:5px; align-items:center; margin:0; }
    .checks input { width:auto; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; margin-top:12px; }
    button.secondary { background:#69736a; margin-top:0; }
    button.warn { background:var(--warn); margin-top:0; }
    button.hold { background:var(--hold); margin-top:0; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; }
    .stat strong { display:block; font-size:23px; } .stat span { color:var(--muted); font-size:13px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
    .toolbar select,.toolbar input { width:auto; min-width:150px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
    .card { display:grid; gap:7px; }
    .card h3 { margin:0; display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 9px; font-size:12px; white-space:nowrap; }
    .pill.待复核 { background:#f3f1e6; } .pill.可入盒 { background:#e4f0dd; color:var(--accent); }
    .pill.已入盒 { background:#e7edf3; } .pill.受影响 { background:#f6e1dc; color:var(--warn); }
    .kv b { color:var(--muted); font-weight:400; margin-right:4px; }
    .badges { display:flex; gap:6px; flex-wrap:wrap; }
    .badge { font-size:12px; border-radius:5px; padding:2px 7px; border:1px solid var(--line); }
    .badge.bad { background:#f6e1dc; color:var(--warn); border-color:#e3bcb3; }
    .badge.good { background:#e4f0dd; color:var(--accent); border-color:#c3d8b6; }
    .badge.hold { background:#f6efd9; color:var(--hold); border-color:#e0cf9c; }
    .progress { height:7px; background:#edf0e9; border-radius:99px; overflow:hidden; }
    .progress i { display:block; height:100%; background:var(--accent); }
    .reviews { border-top:1px solid var(--line); padding-top:7px; max-height:96px; overflow:auto; display:grid; gap:3px; }
    .logs { border-top:1px dashed var(--line); padding-top:7px; max-height:110px; overflow:auto; display:grid; gap:3px; }
    .actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }
    .toast { position:fixed; right:20px; bottom:20px; max-width:380px; background:#2a2f27; color:#fff; padding:12px 15px; border-radius:8px; box-shadow:0 6px 24px rgba(0,0,0,.25); white-space:pre-wrap; opacity:0; transform:translateY(8px); transition:.2s; pointer-events:none; z-index:10; }
    .toast.show { opacity:1; transform:none; } .toast.error { background:var(--warn); }
    .empty { color:var(--muted); padding:24px; text-align:center; }
    @media (max-width:920px){ header{display:block;padding:16px} main{grid-template-columns:1fr;padding:14px} }
  </style>
</head>
<body>
  <header>
    <div><h1>曝光批次与冲洗联审台</h1><div class="meta">药液批次占用 · 显影联审 · 复晒双人确认 · 入盒交付</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section>
      <form id="createForm">
        <h2>登记曝光批次</h2>
        <label>药液批次（同一药液批次只服务一个未结束曝光批次）</label>
        <input name="chemicalBatch" required placeholder="如 B-0622">
        <div class="row">
          <div><label>玻璃板尺寸 *</label><input name="plateSize" required placeholder="如 18x24cm"></div>
          <div><label>曝光时长(分钟) *</label><input name="exposureMinutes" type="number" step="0.1" min="0.1" required></div>
        </div>
        <label>冲洗水源 *</label><input name="waterSource" required placeholder="如 井水过滤">
        <label>显影结果 *</label>
        <select name="developResult"><option value="合格">合格</option><option value="不合格">不合格</option></select>
        <label>操作人</label><input name="operator" placeholder="如 周师傅">
        <button>提交批次</button>
      </form>
      <form id="reviewForm">
        <h2>复晒复核（须另一人确认）</h2>
        <label>曝光批次</label><select name="code" id="reviewBatch"></select>
        <div class="row">
          <div><label>复核人</label><input name="reviewer" required placeholder="本人"></div>
          <div><label>另一人确认</label><input name="confirmer" required placeholder="不能与复核人相同"></div>
        </div>
        <div class="checks">
          <label><input type="checkbox" name="densityOk" checked> 密度合格</label>
          <label><input type="checkbox" name="edgeEven" checked> 边缘均匀</label>
        </div>
        <label>备注</label><input name="note" placeholder="如 复晒第1次">
        <button>提交复晒复核</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部状态</option>${STATUSES.map((s) => "<option>" + s + "</option>").join("")}</select>
        <select id="chemicalFilter"><option value="">全部药液批次</option></select>
        <input id="search" placeholder="搜索编号 / 盒位 / 水源">
      </div>
      <div class="panel">
        <h2>规则：尺寸·时长·水源·显影结果缺项不可提交；水源变化或曝光补时使结论失效；连续两次密度合格且无边缘不均才可入盒。</h2>
        <div class="grid" id="cards"></div>
      </div>
    </section>
  </main>
  <div class="toast" id="toast"></div>
  <script>
    const STATUSES = ${JSON.stringify(STATUSES)};
    let batches = [];
    let reviewKey = sessionStorage.getItem("reviewKey") || ("K-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    sessionStorage.setItem("reviewKey", reviewKey);

    const $ = (s) => document.querySelector(s);
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.error || data.message || "请求失败"); err.payload = data; throw err; }
      return data;
    }
    function toast(message, isError) {
      const el = $("#toast");
      el.textContent = message;
      el.className = "toast show" + (isError ? " error" : "");
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => { el.className = "toast"; }, 4200);
    }
    function esc(v) { return String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

    async function load() {
      batches = await api("/api/batches");
      render();
    }
    // 统计与卡片同源：都从同一份 batches 推导，刷新后一致
    function renderStats() {
      const stats = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      let occupied = 0;
      for (const b of batches) { stats[b.status] += 1; if (b.chemicalOccupied) occupied += 1; }
      const cards = STATUSES.map((s) => '<div class="stat"><span>' + s + '</span><strong>' + stats[s] + '</strong></div>')
        .concat(['<div class="stat"><span>药液占用中</span><strong>' + occupied + '</strong></div>',
                 '<div class="stat"><span>总批次</span><strong>' + batches.length + '</strong></div>']);
      $("#stats").innerHTML = cards.join("");
    }
    function renderForms() {
      $("#reviewBatch").innerHTML = batches.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.code) + " · " + esc(b.chemicalBatch) + " · " + b.status + "</option>").join("");
      const chemicals = [...new Set(batches.map((b) => b.chemicalBatch))].sort();
      $("#chemicalFilter").innerHTML = '<option value="">全部药液批次</option>' + chemicals.map((c) => '<option>' + esc(c) + '</option>').join("");
    }
    function reviewHtml(b) {
      const list = b.reviews.filter((r) => !r.invalidation).slice(-4);
      if (!list.length) return '<div class="meta">暂无复晒复核</div>';
      return list.map((r) => '<div class="meta">' + esc(r.id) + " 密度" + (r.densityOk ? "合格" : "不合格") + " · 边缘" + (r.edgeEven ? "均匀" : "不均") + " · " + esc(r.reviewer) + "／确认 " + esc(r.confirmer) + "</div>").join("");
    }
    function cardHtml(b) {
      const badges = [];
      badges.push(b.conclusionValid ? '<span class="badge good">显影结论有效</span>' : '<span class="badge bad">结论失效' + (b.invalidReason ? "：" + esc(b.invalidReason) : "") + "</span>");
      badges.push(b.chemicalOccupied ? '<span class="badge hold">药液占用中</span>' : '<span class="badge">药液已释放</span>');
      const gateText = "复晒 " + b.gate.streak + "/" + b.gate.needed;
      const boxed = b.status === "已入盒" || b.status === "受影响";
      const reviewBtn = boxed && b.conclusionValid ? "" : '<button class="secondary" data-review="' + esc(b.code) + '">复晒复核</button>';
      const boxBtn = b.status === "可入盒" ? '<button data-box="' + esc(b.code) + '">入盒</button>' : "";
      return '<article class="card">'
        + '<h3><span>' + esc(b.code) + '</span><span class="pill ' + b.status + '">' + b.status + "</span></h3>"
        + '<div class="badges">' + badges.join("") + "</div>"
        + '<div class="kv"><b>药液批次</b>' + esc(b.chemicalBatch) + "</div>"
        + '<div class="row"><div class="kv"><b>尺寸</b>' + esc(b.plateSize) + '</div><div class="kv"><b>时长</b>' + esc(b.exposureMinutes) + " 分钟</div></div>"
        + '<div class="row"><div class="kv"><b>水源</b>' + esc(b.waterSource) + '</div><div class="kv"><b>显影</b>' + esc(b.developResult) + "</div></div>"
        + '<div class="kv"><b>盒位</b>' + (b.box ? esc(b.box) : "未入盒") + "</div>"
        + '<div><div class="meta" style="display:flex;justify-content:space-between"><span>' + gateText + (b.gate.satisfied ? " · 可入盒" : "") + '</span><span>' + (b.conclusionValid ? "" : "失效后重新计数") + "</span></div>"
        + '<div class="progress"><i style="width:' + Math.min(100, b.gate.streak / b.gate.needed * 100) + '%"></i></div></div>'
        + '<div class="reviews">' + reviewHtml(b) + "</div>"
        + '<div class="actions">'
        + '<button class="hold" data-water="' + esc(b.code) + '">改水源</button>'
        + '<button class="hold" data-extra="' + esc(b.code) + '">曝光补时</button>'
        + reviewBtn + boxBtn
        + "</div>"
        + '<div class="logs meta">' + b.logs.slice(-4).map((l) => "<div>" + esc(l.step) + "：" + esc(l.note) + "</div>").join("") + "</div>"
        + "</article>";
    }
    function render() {
      renderForms();
      renderStats();
      const status = $("#statusFilter").value;
      const chem = $("#chemicalFilter").value;
      const q = $("#search").value.trim();
      const visible = batches.filter((b) =>
        (!status || b.status === status)
        && (!chem || b.chemicalBatch === chem)
        && (!q || JSON.stringify(b).includes(q)));
      $("#cards").innerHTML = visible.length ? visible.map(cardHtml).join("") : '<div class="empty">没有符合条件的曝光批次</div>';
      bindCardActions();
    }
    function bindCardActions() {
      document.querySelectorAll("[data-water]").forEach((btn) => btn.onclick = async () => {
        const code = btn.dataset.water;
        const waterSource = prompt("新的冲洗水源（水源变化将使显影结论失效）");
        if (waterSource === null) return;
        const operator = prompt("操作人") || "工位";
        try { const r = await api("/api/batches/" + code + "/water", { method: "POST", body: JSON.stringify({ waterSource, operator }) });
          toast(r.changed ? "已变更：未入盒退回复核 / 已入盒标记受影响" : "水源未变化"); await load(); }
        catch (e) { toast(e.message, true); }
      });
      document.querySelectorAll("[data-extra]").forEach((btn) => btn.onclick = async () => {
        const code = btn.dataset.extra;
        const addMinutes = prompt("补时分钟数（补时将使显影结论失效）");
        if (addMinutes === null) return;
        const operator = prompt("操作人") || "工位";
        try { await api("/api/batches/" + code + "/extra-exposure", { method: "POST", body: JSON.stringify({ addMinutes, operator }) });
          toast("已补时：未入盒退回复核 / 已入盒标记受影响"); await load(); }
        catch (e) { toast(e.message, true); }
      });
      document.querySelectorAll("[data-review]").forEach((btn) => btn.onclick = () => {
        $("#reviewBatch").value = btn.dataset.review; $("#reviewForm").scrollIntoView({ behavior: "smooth" });
      });
      document.querySelectorAll("[data-box]").forEach((btn) => btn.onclick = async () => {
        const code = btn.dataset.box;
        const box = prompt("存放盒位");
        if (!box) return;
        try { await api("/api/batches/" + code + "/box", { method: "POST", body: JSON.stringify({ box }) });
          toast("已入盒 " + box); await load(); }
        catch (e) { toast(e.message, true); }
      });
    }

    $("#createForm").onsubmit = async (event) => {
      event.preventDefault();
      const form = $("#createForm");
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const b = await api("/api/batches", { method: "POST", body: JSON.stringify(data) });
        toast("批次 " + b.code + " 已登记"); form.reset(); await load();
      } catch (e) { toast(e.message, true); }
    };
    $("#reviewForm").onsubmit = async (event) => {
      event.preventDefault();
      const form = $("#reviewForm");
      const fd = new FormData(form);
      const data = Object.fromEntries(fd.entries());
      data.densityOk = fd.get("densityOk") !== null;
      data.edgeEven = fd.get("edgeEven") !== null;
      data.requestKey = reviewKey; // 重复或并发沿用首次
      try {
        const r = await api("/api/batches/" + data.code + "/reviews", { method: "POST", body: JSON.stringify(data) });
        toast((r.reused ? "重复提交，沿用首次复核结果。" : "复晒复核已记录。") + "当前连续 " + r.batch.gate.streak + "/2");
        reviewKey = "K-" + Date.now() + "-" + Math.random().toString(16).slice(2);
        sessionStorage.setItem("reviewKey", reviewKey);
        form.reset(); await load();
      } catch (e) { toast(e.message, true); }
    };
    $("#statusFilter").onchange = render;
    $("#chemicalFilter").onchange = render;
    $("#search").oninput = render;
    $("#reload").onclick = () => load().then(() => toast("已刷新")).catch((e) => toast(e.message, true));
    load().catch((e) => toast(e.message, true));
  </script>
</body>
</html>`;
}
