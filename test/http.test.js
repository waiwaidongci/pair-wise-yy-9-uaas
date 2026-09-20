import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

process.env.JOINT_REVIEW_DB = new URL("./tmp-http-" + process.pid + ".json", import.meta.url).pathname;
const { resetDb } = await import("../src/store.js");
const { createServer } = await import("../server.js");

const server = createServer();
server.listen();
await once(server, "listening");
const origin = "http://localhost:" + server.address().port;

before(async () => { await resetDb(); });
after(() => server.close());

async function req(method, path, body) {
  const res = await fetch(origin + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("GET / 返回联审台页面", async () => {
  const res = await fetch(origin + "/");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /曝光批次与冲洗联审台/);
});

test("种子数据：列表与统计一致", async () => {
  const { status, json } = await req("GET", "/api/batches");
  assert.equal(status, 200);
  assert.ok(Array.isArray(json));
  const stats = (await req("GET", "/api/stats")).json;
  assert.equal(stats.总计, json.length);
});

test("缺项不可提交：400 且不落库", async () => {
  const before = (await req("GET", "/api/batches")).json.length;
  const bad = { chemicalBatch: "B-NEW-1", plateSize: "10x10cm", waterSource: "井水" }; // 缺时长、显影结果
  const r = await req("POST", "/api/batches", bad);
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "missing_fields");
  assert.equal((await req("GET", "/api/batches")).json.length, before);
});

test("同一药液批次冲突返回 409 且不落库；并发请求只有一个成功", async () => {
  const payload = {
    chemicalBatch: "B-CONCUR", plateSize: "9x12cm", exposureMinutes: 6,
    waterSource: "井水", developResult: "合格", operator: "甲",
  };
  const before = (await req("GET", "/api/batches")).json.length;

  const [a, b] = await Promise.all([
    req("POST", "/api/batches", payload),
    req("POST", "/api/batches", payload),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const conflict = a.status === 409 ? a.json : b.json;
  assert.equal(conflict.error, "chemical_batch_busy");
  assert.ok(conflict.occupant);

  // 冲突请求不落库：只多了一条
  const after = (await req("GET", "/api/batches")).json.length;
  assert.equal(after, before + 1);

  // 第三个同样请求仍冲突
  const c = await req("POST", "/api/batches", payload);
  assert.equal(c.status, 409);
  assert.equal((await req("GET", "/api/batches")).json.length, after);
});

test("复晒须另一人确认：同人 409", async () => {
  const code = "EB-002";
  const r = await req("POST", `/api/batches/${code}/reviews`, {
    reviewer: "同一人", confirmer: "同一人", densityOk: true, edgeEven: true, requestKey: "k-same",
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "same_person");
});

test("连续两次合格才可入盒；中途不合格被闸门拦截(409)", async () => {
  const created = await req("POST", "/api/batches", {
    chemicalBatch: "B-GATE", plateSize: "13x18cm", exposureMinutes: 9,
    waterSource: "山泉", developResult: "不合格", operator: "甲",
  });
  const code = created.json.code;

  // 尚未复晒，直接入盒 -> 409
  assert.equal((await req("POST", `/api/batches/${code}/box`, { box: "盒X" })).status, 409);

  const rev = (densityOk, edgeEven, key) => req("POST", `/api/batches/${code}/reviews`, {
    reviewer: "甲", confirmer: "乙", densityOk, edgeEven, requestKey: key,
  });

  assert.equal((await rev(true, false, "g1")).json.gate.streak, 0); // 边缘不均：0/2
  assert.equal((await req("POST", `/api/batches/${code}/box`, { box: "盒X" })).status, 409);
  assert.equal((await rev(true, true, "g2")).json.gate.streak, 1); // 1/2
  assert.equal((await req("POST", `/api/batches/${code}/box`, { box: "盒X" })).status, 409);
  const third = await rev(true, true, "g3");
  assert.equal(third.json.status, "可入盒");
  assert.equal(third.json.gate.streak, 2);

  const boxed = await req("POST", `/api/batches/${code}/box`, { box: "蓝盒G-01" });
  assert.equal(boxed.status, 200);
  assert.equal(boxed.json.status, "已入盒");

  // 入盒后药液释放：同药液可再开新批次
  const again = await req("POST", "/api/batches", {
    chemicalBatch: "B-GATE", plateSize: "13x18cm", exposureMinutes: 9,
    waterSource: "山泉", developResult: "合格", operator: "甲",
  });
  assert.equal(again.status, 201);
});

test("重复或并发复晒沿用首次：同一 requestKey 只记一次", async () => {
  const created = await req("POST", "/api/batches", {
    chemicalBatch: "B-IDEM", plateSize: "10x15cm", exposureMinutes: 7,
    waterSource: "井水", developResult: "不合格", operator: "甲",
  });
  const code = created.json.code;
  const body = { reviewer: "甲", confirmer: "乙", densityOk: true, edgeEven: true, requestKey: "DUP-KEY" };

  const [p1, p2] = await Promise.all([
    req("POST", `/api/batches/${code}/reviews`, body),
    req("POST", `/api/batches/${code}/reviews`, body),
  ]);
  assert.equal(p1.status, 200);
  assert.equal(p2.status, 200);
  const reusedFlags = [p1.json.reused, p2.json.reused];
  assert.ok(reusedFlags.includes(true));
  assert.ok(reusedFlags.includes(false));

  const detail = await req("GET", `/api/batches/${code}`);
  const realReviews = detail.json.reviews.filter((r) => !r.invalidation);
  assert.equal(realReviews.length, 1); // 并发只落一条
  assert.equal(detail.json.gate.streak, 1);

  // 顺序重复提交同样沿用首次，不新增记录
  const p3 = await req("POST", `/api/batches/${code}/reviews`, body);
  assert.equal(p3.json.reused, true);
  assert.equal((await req("GET", `/api/batches/${code}`)).json.reviews.filter((r) => !r.invalidation).length, 1);
});

test("水源变化：未入盒退回复核，复晒计数清零", async () => {
  const created = await req("POST", "/api/batches", {
    chemicalBatch: "B-WATER", plateSize: "8x10cm", exposureMinutes: 5,
    waterSource: "井水", developResult: "合格", operator: "甲",
  });
  const code = created.json.code;
  await req("POST", `/api/batches/${code}/reviews`, { reviewer: "甲", confirmer: "乙", densityOk: true, edgeEven: true, requestKey: "w1" });

  const changed = await req("POST", `/api/batches/${code}/water`, { waterSource: "河水", operator: "甲" });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.conclusionValid, false);
  assert.equal(changed.json.status, "待复核");
  assert.equal(changed.json.gate.streak, 0);
  assert.equal(changed.json.waterSource, "河水");

  // 水源相同不产生变化、不失效
  const same = await req("POST", `/api/batches/${code}/water`, { waterSource: "河水", operator: "甲" });
  assert.equal(same.json.conclusionValid, false); // 维持已失效
});

test("曝光补时：已入盒标记受影响、盒位保留，药液不重新占用", async () => {
  const created = await req("POST", "/api/batches", {
    chemicalBatch: "B-AFFECT", plateSize: "8x10cm", exposureMinutes: 5,
    waterSource: "井水", developResult: "合格", operator: "甲",
  });
  const code = created.json.code;
  await req("POST", `/api/batches/${code}/reviews`, { reviewer: "甲", confirmer: "乙", densityOk: true, edgeEven: true, requestKey: "a1" });
  await req("POST", `/api/batches/${code}/reviews`, { reviewer: "甲", confirmer: "乙", densityOk: true, edgeEven: true, requestKey: "a2" });
  await req("POST", `/api/batches/${code}/box`, { box: "蓝盒Z-9" });

  const r = await req("POST", `/api/batches/${code}/extra-exposure`, { addMinutes: 2, operator: "甲" });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "受影响");
  assert.equal(r.json.conclusionValid, false);
  assert.equal(r.json.box, "蓝盒Z-9");
  assert.equal(r.json.chemicalOccupied, false);

  // 受影响批次需重新连续两次复核才能再次入盒
  assert.equal((await req("POST", `/api/batches/${code}/box`, { box: "蓝盒Z-9" })).status, 409);
});

test("刷新后一致：统计、卡片、明细共享同一存储", async () => {
  const [list, stats] = await Promise.all([req("GET", "/api/batches"), req("GET", "/api/stats")]);
  assert.equal(list.json.length, stats.json.总计);
  const byStatus = {};
  for (const b of list.json) byStatus[b.status] = (byStatus[b.status] || 0) + 1;
  for (const s of ["待复核", "可入盒", "已入盒", "受影响"]) {
    assert.equal(stats.json[s] || 0, byStatus[s] || 0);
  }
});
