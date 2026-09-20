import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbFile = join(__dirname, "..", "data", "cyanotype-joint-review.json");
const base = `http://127.0.0.1:${process.env.TEST_PORT || 3091}`;

let child;

test.before(async () => {
  await rm(dbFile, { force: true });
  child = spawn(process.execPath, [join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: process.env.TEST_PORT || "3091" },
    stdio: "ignore"
  });
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(base + "/api/state");
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});

test.after(async () => {
  child.kill();
  await new Promise(r => setTimeout(r, 200));
  await rm(dbFile, { force: true });
});

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: path.endsWith("/changes") ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
const state = async () => (await fetch(base + "/api/state")).json();

const goodBatch = (chem, over = {}) => ({
  chemicalBatch: chem,
  plateSize: "18x24cm",
  exposureMinutes: 8,
  waterSource: "井水过滤",
  operator: "甲",
  developResult: { density: "合格", edge: "均匀" },
  ...over
});

test("页面与静态资源可访问", async () => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("曝光批次与冲洗联审台"));
  const js = await fetch(base + "/public/app.js");
  assert.equal(js.status, 200);
});

test("缺项提交返回 400，且批次数量不变", async () => {
  const before = (await state()).stats["总数"];
  const r = await post("/api/batches", { chemicalBatch: "B-X" });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "missing_fields");
  assert.ok(r.json.details.missing.includes("plateSize"));
  assert.equal((await state()).stats["总数"], before);
});

test("并发提交同一药液批次：一个 201、一个 409，且只落库一条", async () => {
  const chem = `B-CONC-${Date.now()}`;
  const before = (await state()).stats["总数"];
  const [a, b] = await Promise.all([
    post("/api/batches", goodBatch(chem, { operator: "甲" })),
    post("/api/batches", goodBatch(chem, { operator: "乙" }))
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  assert.equal(b.status === 409 ? b.json.error : a.json.error, "chemical_batch_conflict");
  const after = await state();
  assert.equal(after.stats["总数"], before + 1);
  assert.equal(after.batches.filter(x => x.chemicalBatch === chem).length, 1);
});

test("占用未结束批次的药液批次直接提交即 409（种子数据）", async () => {
  const r = await post("/api/batches", goodBatch("B-0919-A"));
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "chemical_batch_conflict");
});

test("联审-入盒-结束完整流程，结束后药液释放可复用", async () => {
  const chem = `B-FLOW-${Date.now()}`;
  const created = await post("/api/batches", goodBatch(chem));
  assert.equal(created.status, 201);
  const id = created.json.batch.id;
  assert.equal(created.json.batch.status, "复核中");

  const review = await post(`/api/batches/${id}/review`, { reviewer: "复核员乙", decision: "通过" });
  assert.equal(review.status, 200);
  assert.equal(review.json.batch.status, "待入盒");

  const boxed = await post(`/api/batches/${id}/box`, { box: "蓝盒T-01" });
  assert.equal(boxed.status, 200);
  assert.equal(boxed.json.batch.status, "已入盒");

  const endedRes = await post(`/api/batches/${id}/end`, {});
  assert.equal(endedRes.status, 200);
  assert.equal(endedRes.json.batch.status, "已结束");

  const reuse = await post("/api/batches", goodBatch(chem));
  assert.equal(reuse.status, 201);
});

test("未入盒批次换水源使结论失效并退回复核", async () => {
  const chem = `B-WATER-${Date.now()}`;
  const id = (await post("/api/batches", goodBatch(chem))).json.batch.id;
  await post(`/api/batches/${id}/review`, { reviewer: "乙", decision: "通过" });
  const r = await fetch(base + `/api/batches/${id}/changes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ waterSource: "山泉水" })
  });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.invalidated, true);
  assert.equal(j.batch.conclusionValid, false);
  assert.equal(j.batch.status, "复核中");
});

test("复晒须另一人确认（同人 400），门槛不足入盒 409", async () => {
  const chem = `B-RS-${Date.now()}`;
  const id = (await post("/api/batches", goodBatch(chem, {
    developResult: { density: "不合格", edge: "边缘不均" }
  }))).json.batch.id;
  const same = await post(`/api/batches/${id}/resuns`, {
    operator: "甲", confirmer: "甲", density: "合格", edge: "均匀", requestId: "x1"
  });
  assert.equal(same.status, 400);
  assert.equal(same.json.error, "confirm_required");

  const one = await post(`/api/batches/${id}/resuns`, {
    operator: "甲", confirmer: "乙", density: "合格", edge: "均匀", requestId: "x2"
  });
  assert.equal(one.status, 200);
  const gate = await post(`/api/batches/${id}/box`, { box: "盒" });
  assert.equal(gate.status, 409);
  assert.equal(gate.json.error, "box_gate_failed");
});

test("并发复晒携带相同 requestId 只沿用首次一条记录", async () => {
  const chem = `B-IDEM-${Date.now()}`;
  const id = (await post("/api/batches", goodBatch(chem, {
    developResult: { density: "不合格", edge: "边缘不均" }
  }))).json.batch.id;
  const payload = { operator: "甲", confirmer: "乙", density: "合格", edge: "均匀", requestId: "fixed-key" };
  const [r1, r2, r3] = await Promise.all([
    post(`/api/batches/${id}/resuns`, payload, { "Idempotency-Key": "fixed-key" }),
    post(`/api/batches/${id}/resuns`, payload, { "Idempotency-Key": "fixed-key" }),
    post(`/api/batches/${id}/resuns`, { ...payload, density: "不合格", edge: "边缘不均" }, { "Idempotency-Key": "fixed-key" })
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 200);
  const batch = (await state()).batches.find(x => x.id === id);
  assert.equal(batch.resuns.length, 1);
  assert.equal(batch.resuns[0].density, "合格");
});

test("刷新后卡片与统计一致：状态来自同一份落库数据", async () => {
  const s1 = await state();
  const s2 = await state();
  assert.deepEqual(s1.stats, s2.stats);
  assert.deepEqual(s1.batches.map(b => b.id), s2.batches.map(b => b.id));
  // 卡片派生字段与统计口径一致：受影响卡片数 == 受影响统计数
  assert.equal(s1.batches.filter(b => b.affected).length, s1.stats["受影响"]);
});
