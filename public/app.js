// 展示层：只负责渲染与表单提交。规则判定全部来自服务端返回的派生字段，
// 卡片与统计共用同一份 /api/state 数据，刷新后天然一致。

const STATUS_LABELS = ["复核中", "待入盒", "已入盒", "已结束"];

let state = { batches: [], stats: {} };

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", "Idempotency-Key": uid(), ...(options.headers || {}) } : options.headers
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || "请求失败");
    err.code = data.error;
    err.details = data.details;
    throw err;
  }
  return data;
}

function flash(message, kind = "success") {
  const el = $("#flash");
  el.textContent = message;
  el.className = `flash ${kind}`;
  el.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

async function load() {
  state = await api("/api/state");
  render();
}

function renderSelects() {
  $$(".batchSelect").forEach(sel => {
    const only = sel.dataset.filter;
    const list = state.batches.filter(b => (only === "unended" ? b.status !== "已结束" : true));
    const prev = sel.value;
    sel.innerHTML = list.map(b => `<option value="${b.id}">${b.id} · ${b.chemicalBatch} · ${b.status}${b.affected ? " · 受影响" : ""}</option>`).join("");
    if (list.some(b => b.id === prev)) sel.value = prev;
  });
}

function renderStats() {
  const order = ["复核中", "待入盒", "已入盒", "已结束", "受影响", "总数"];
  $("#stats").innerHTML = order
    .filter(k => state.stats[k] !== undefined)
    .map(k => `<div class="stat${k === "受影响" && state.stats[k] ? " affected" : ""}"><span>${k}</span><strong>${state.stats[k]}</strong></div>`)
    .join("");
}

function renderFilters() {
  const f = $("#statusFilter");
  const cur = f.value;
  f.innerHTML = '<option value="">全部状态</option>' + STATUS_LABELS.map(s => `<option ${s === cur ? "selected" : ""}>${s}</option>`).join("");
}

function renderCards() {
  const status = $("#statusFilter").value;
  const q = $("#search").value.trim();
  const visible = state.batches.filter(b => {
    if (status && b.status !== status) return false;
    if (!q) return true;
    const hay = [b.id, b.chemicalBatch, b.plateSize, b.waterSource, b.operator, b.box, b.developResult.note].join(" ");
    return hay.includes(q);
  });
  $("#cards").innerHTML = visible.map(cardHtml).join("") || '<p class="meta">没有符合条件的批次。</p>';
}

function resultHtml(r) {
  const bad = r.density !== "合格" || r.edge !== "均匀";
  return `<span class="${bad ? "result-bad" : ""}">密度${esc(r.density)} · ${esc(r.edge === "均匀" ? "无边缘不均" : r.edge)}</span>${r.note ? `（${esc(r.note)}）` : ""}`;
}

function cardHtml(b) {
  const resuns = b.resuns.map((r, i) =>
    `<div>复晒${i + 1}：密度${esc(r.density)} · ${r.edge === "均匀" ? "无边缘不均" : esc(r.edge)}｜${esc(r.operator)}操作 / ${esc(r.confirmer)}确认</div>`
  ).join("");
  const logs = b.logs.slice(-5).map(l =>
    `<div>${new Date(l.at).toLocaleString("zh-CN", { hour12: false })} <b>${esc(l.step)}</b> ${esc(l.note)}</div>`
  ).join("");
  const badges = [
    `<span class="pill ${esc(b.status)}">${esc(b.status)}</span>`,
    !b.conclusionValid ? '<span class="pill badge-invalid">结论已失效</span>' : "",
    b.affected ? '<span class="pill badge-affected">受影响</span>' : ""
  ].join("");
  return `<article class="card">
    <h3>${esc(b.id)} ${badges}</h3>
    <div class="kv"><b>药液批次</b><span>${esc(b.chemicalBatch)}</span></div>
    <div class="kv"><b>尺寸/时长</b><span>${esc(b.plateSize)} · ${b.exposureMinutes} 分钟</span></div>
    <div class="kv"><b>水源</b><span>${esc(b.waterSource)}</span></div>
    <div class="kv"><b>操作员</b><span>${esc(b.operator)}</span></div>
    <div class="kv"><b>显影结果</b><span>${resultHtml(b.developResult)}</span></div>
    <div class="kv"><b>盒位</b><span>${esc(b.box || "未入盒")}</span></div>
    ${resuns ? `<div class="kv"><b>复晒记录</b><div>${resuns}</div></div>` : ""}
    <div class="gate ${b.eligible ? "ok" : "no"}">入盒门槛：${esc(b.gateMessage)}
      <div class="streak">末尾连续合格复晒 ${b.tailGoodStreak} / 2 次</div>
    </div>
    <div class="logs">${logs || "<div>暂无记录</div>"}</div>
  </article>`;
}

function render() {
  renderSelects();
  renderStats();
  renderFilters();
  renderCards();
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function submitFormHandler(event) {
  event.preventDefault();
  const d = formData(event.target);
  try {
    await api("/api/batches", {
      method: "POST",
      body: JSON.stringify({
        chemicalBatch: d.chemicalBatch,
        plateSize: d.plateSize,
        exposureMinutes: d.exposureMinutes,
        waterSource: d.waterSource,
        operator: d.operator,
        developResult: { density: d.density, edge: d.edge, note: d.developNote }
      })
    });
    event.target.reset();
    flash("曝光批次已提交，进入冲洗联审。");
    await load();
  } catch (e) { flash(formatError(e), "error"); }
}

async function reviewHandler(event) {
  event.preventDefault();
  const d = formData(event.target);
  try {
    await api(`/api/batches/${encodeURIComponent(d.id)}/review`, {
      method: "POST",
      body: JSON.stringify({ reviewer: d.reviewer, decision: d.decision, reason: d.reason })
    });
    event.target.reset();
    flash("联审结论已记录。");
    await load();
  } catch (e) { flash(formatError(e), "error"); }
}

async function changeHandler(event) {
  event.preventDefault();
  const d = formData(event.target);
  const patch = {};
  if (d.chemicalBatch.trim()) patch.chemicalBatch = d.chemicalBatch.trim();
  if (d.exposureMinutes) patch.exposureMinutes = Number(d.exposureMinutes);
  if (d.waterSource.trim()) patch.waterSource = d.waterSource.trim();
  if (d.density || d.edge) {
    patch.developResult = {};
    if (d.density) patch.developResult.density = d.density;
    if (d.edge) patch.developResult.edge = d.edge;
  }
  if (!Object.keys(patch).length) return flash("请至少填写一项要变更的内容。", "error");
  try {
    const data = await api(`/api/batches/${encodeURIComponent(d.id)}/changes`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    flash(data.invalidated ? `显影结论已失效：${data.reasons.join("；")}。` : "变更已记录。");
    event.target.reset();
    await load();
  } catch (e) { flash(formatError(e), "error"); }
}

async function resunHandler(event) {
  event.preventDefault();
  const d = formData(event.target);
  try {
    const data = await api(`/api/batches/${encodeURIComponent(d.id)}/resuns`, {
      method: "POST",
      body: JSON.stringify({
        operator: d.operator,
        confirmer: d.confirmer,
        density: d.density,
        edge: d.edge,
        note: d.note,
        requestId: uid()
      })
    });
    event.target.reset();
    flash(data.reused ? "检测到重复/并发请求，已沿用首次复晒记录。" : "复晒已记录（另一人确认）。");
    await load();
  } catch (e) { flash(formatError(e), "error"); }
}

async function boxHandler(event) {
  event.preventDefault();
  const d = formData(event.target);
  try {
    await api(`/api/batches/${encodeURIComponent(d.id)}/box`, {
      method: "POST",
      body: JSON.stringify({ box: d.box })
    });
    event.target.reset();
    flash("已入盒。");
    await load();
  } catch (e) { flash(formatError(e), "error"); }
}

async function endHandler() {
  const id = $("#boxForm").elements.id.value;
  if (!id) return;
  try {
    await api(`/api/batches/${encodeURIComponent(id)}/end`, { method: "POST" });
    flash("批次已结束，药液批次已释放，可服务新曝光批次。");
    await load();
  } catch (e) { flash(formatError(e), "error"); }
}

function formatError(e) {
  if (e.code === "missing_fields" && e.details?.missing) return `${e.message}（${e.details.missing.join("、")}）`;
  if (e.code === "chemical_batch_conflict") return `409 冲突：${e.message}`;
  return e.message;
}

$("#submitForm").onsubmit = submitFormHandler;
$("#reviewForm").onsubmit = reviewHandler;
$("#changeForm").onsubmit = changeHandler;
$("#resunForm").onsubmit = resunHandler;
$("#boxForm").onsubmit = boxHandler;
$("#endBtn").onclick = endHandler;
$("#statusFilter").onchange = renderCards;
$("#search").oninput = renderCards;
$("#reload").onclick = load;

load().catch(e => flash(e.message, "error"));
