import test from "node:test";
import assert from "node:assert/strict";
import {
  submitBatch,
  reviewBatch,
  changeBatch,
  addResun,
  boxBatch,
  endBatch,
  computeStats,
  findBatch
} from "../src/domain.js";

const NOW = "2026-09-20T08:00:00.000Z";

function emptyState() {
  return { batches: [] };
}
function goodInput(over = {}) {
  return {
    chemicalBatch: "B-1",
    plateSize: "18x24cm",
    exposureMinutes: 8,
    waterSource: "井水过滤",
    operator: "甲",
    developResult: { density: "合格", edge: "均匀" },
    ...over
  };
}
function seedBatch(state, input = {}, now = NOW) {
  const r = submitBatch(state, goodInput(input), now);
  assert.ok(r.ok, r.message);
  return r.value.batch;
}

// 规则 2：缺项不可提交
test("提交批次缺少尺寸/时长/水源/显影结果返回 missing_fields，且不落库", () => {
  const state = emptyState();
  const r = submitBatch(state, { chemicalBatch: "B-1", operator: "甲" }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.code, "missing_fields");
  assert.deepEqual(r.details.missing.sort(), ["developResult", "exposureMinutes", "plateSize", "waterSource"].sort());
  assert.equal(state.batches.length, 0);
});

test("显影结果只填密度仍视为缺项", () => {
  const state = emptyState();
  const r = submitBatch(state, goodInput({ developResult: { density: "合格" } }), NOW);
  assert.equal(r.code, "missing_fields");
  assert.deepEqual(r.details.missing, ["developResult"]);
});

// 规则 1：药液批次互斥
test("同一药液批次服务未结束批次时，第二次提交冲突 409 且不落库", () => {
  const state = emptyState();
  seedBatch(state, { chemicalBatch: "B-1" });
  const before = state.batches.length;
  const r = submitBatch(state, goodInput({ chemicalBatch: "B-1", plateSize: "24x30cm" }), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.code, "chemical_batch_conflict");
  assert.equal(r.details.conflictId, state.batches[0].id);
  assert.equal(state.batches.length, before);
});

test("批次结束后药液批次释放，可再次使用", () => {
  const state = emptyState();
  const b = seedBatch(state, { chemicalBatch: "B-1" });
  reviewBatch(state, b.id, { reviewer: "乙", decision: "通过" }, NOW);
  boxBatch(state, b.id, { box: "蓝盒A-01" }, NOW);
  const end = endBatch(state, b.id, NOW);
  assert.ok(end.ok);
  const again = submitBatch(state, goodInput({ chemicalBatch: "B-1" }), NOW);
  assert.ok(again.ok, again.message);
  assert.equal(state.batches.length, 2);
});

test("药液互斥按药液编号独立，不同药液可并行", () => {
  const state = emptyState();
  seedBatch(state, { chemicalBatch: "B-1" });
  const r = submitBatch(state, goodInput({ chemicalBatch: "B-2" }), NOW);
  assert.ok(r.ok);
});

// 联审
test("显影合格批次联审通过进入待入盒", () => {
  const state = emptyState();
  const b = seedBatch(state);
  const r = reviewBatch(state, b.id, { reviewer: "乙", decision: "通过" }, NOW);
  assert.ok(r.ok);
  assert.equal(findBatch(state, b.id).status, "待入盒");
});

test("显影不合格批次联审不能通过，必须复晒", () => {
  const state = emptyState();
  const b = seedBatch(state, { developResult: { density: "不合格", edge: "边缘不均" } });
  const r = reviewBatch(state, b.id, { reviewer: "乙", decision: "通过" }, NOW);
  assert.equal(r.code, "review_rejected");
  assert.equal(findBatch(state, b.id).status, "复核中");
});

// 规则 3：结论失效
test("未入盒批次水源变化使结论失效并退回复核", () => {
  const state = emptyState();
  const b = seedBatch(state, { waterSource: "井水过滤" });
  reviewBatch(state, b.id, { reviewer: "乙", decision: "通过" }, NOW);
  const r = changeBatch(state, b.id, { waterSource: "山泉水" }, NOW);
  assert.ok(r.ok);
  assert.equal(r.value.invalidated, true);
  const after = findBatch(state, b.id);
  assert.equal(after.conclusionValid, false);
  assert.equal(after.status, "复核中");
  assert.equal(after.affected, false);
});

test("曝光补时（时长增大）使结论失效；时长不变或减小不失效", () => {
  const state = emptyState();
  const b = seedBatch(state, { exposureMinutes: 8 });
  assert.equal(changeBatch(state, b.id, { exposureMinutes: 10 }, NOW).value.invalidated, true);
  assert.equal(findBatch(state, b.id).conclusionValid, false);
  const state2 = emptyState();
  const b2 = seedBatch(state2, { exposureMinutes: 8 });
  assert.equal(changeBatch(state2, b2.id, { exposureMinutes: 8 }, NOW).value.invalidated, false);
  assert.equal(changeBatch(state2, b2.id, { exposureMinutes: 6 }, NOW).value.invalidated, false);
});

test("已入盒批次水源变化标记受影响，状态保持已入盒", () => {
  const state = emptyState();
  const b = seedBatch(state);
  reviewBatch(state, b.id, { reviewer: "乙", decision: "通过" }, NOW);
  boxBatch(state, b.id, { box: "蓝盒A-03" }, NOW);
  const r = changeBatch(state, b.id, { waterSource: "雨水沉淀", exposureMinutes: 12 }, NOW);
  assert.ok(r.ok);
  const after = findBatch(state, b.id);
  assert.equal(after.affected, true);
  assert.equal(after.status, "已入盒");
  assert.equal(after.conclusionValid, false);
  assert.equal(r.value.reasons.length, 2);
});

test("变更药液批次撞车返回 409 且不改动原批次", () => {
  const state = emptyState();
  seedBatch(state, { chemicalBatch: "B-1" });
  const b2 = seedBatch(state, { chemicalBatch: "B-2" });
  const r = changeBatch(state, b2.id, { chemicalBatch: "B-1" }, NOW);
  assert.equal(r.code, "chemical_batch_conflict");
  assert.equal(findBatch(state, b2.id).chemicalBatch, "B-2");
});

// 规则 4：复晒
test("复晒缺少另一人确认不可提交", () => {
  const state = emptyState();
  const b = seedBatch(state, { developResult: { density: "不合格", edge: "边缘不均" } });
  assert.equal(addResun(state, b.id, { operator: "甲" }, NOW).code, "confirm_required");
});

test("复晒确认人不能与操作人相同", () => {
  const state = emptyState();
  const b = seedBatch(state);
  const r = addResun(state, b.id, { operator: "甲", confirmer: "甲" }, NOW);
  assert.equal(r.code, "confirm_required");
});

test("连续两次复晒密度合格且无边缘不均才可入盒", () => {
  const state = emptyState();
  const b = seedBatch(state, { developResult: { density: "不合格", edge: "边缘不均" } });
  addResun(state, b.id, { operator: "甲", confirmer: "乙", density: "合格", edge: "边缘不均", requestId: "r1" }, NOW);
  assert.equal(boxBatch(state, b.id, { box: "盒1" }, NOW).code, "box_gate_failed");
  addResun(state, b.id, { operator: "甲", confirmer: "乙", density: "合格", edge: "均匀", requestId: "r2" }, NOW);
  // 末尾是 [边缘不均, 均匀]，连续合格只有 1 次
  assert.equal(boxBatch(state, b.id, { box: "盒1" }, NOW).code, "box_gate_failed");
  addResun(state, b.id, { operator: "丙", confirmer: "丁", density: "合格", edge: "均匀", requestId: "r3" }, NOW);
  const boxed = boxBatch(state, b.id, { box: "盒1" }, NOW);
  assert.ok(boxed.ok, boxed.message);
  assert.equal(findBatch(state, b.id).status, "已入盒");
});

test("中途出现不合格会打断连续计数", () => {
  const state = emptyState();
  const b = seedBatch(state, { developResult: { density: "不合格", edge: "边缘不均" } });
  addResun(state, b.id, { operator: "甲", confirmer: "乙", density: "合格", edge: "均匀", requestId: "r1" }, NOW);
  addResun(state, b.id, { operator: "甲", confirmer: "乙", density: "不合格", edge: "均匀", requestId: "r2" }, NOW);
  addResun(state, b.id, { operator: "甲", confirmer: "乙", density: "合格", edge: "均匀", requestId: "r3" }, NOW);
  assert.equal(boxBatch(state, b.id, { box: "盒1" }, NOW).code, "box_gate_failed");
});

test("相同 requestId 的重复/并发复晒沿用首次记录", () => {
  const state = emptyState();
  const b = seedBatch(state, { developResult: { density: "不合格", edge: "边缘不均" } });
  const first = addResun(state, b.id, { operator: "甲", confirmer: "乙", density: "合格", edge: "均匀", requestId: "dup" }, NOW);
  assert.equal(first.value.reused, false);
  const second = addResun(state, b.id, { operator: "X", confirmer: "Y", density: "不合格", edge: "边缘不均", requestId: "dup" }, NOW);
  assert.equal(second.ok, true);
  assert.equal(second.value.reused, true);
  assert.equal(findBatch(state, b.id).resuns.length, 1);
  assert.equal(findBatch(state, b.id).resuns[0].operator, "甲");
});

test("原结论失效后，两次合格复晒达标可回到待入盒并入盒", () => {
  const state = emptyState();
  const b = seedBatch(state);
  reviewBatch(state, b.id, { reviewer: "乙", decision: "通过" }, NOW);
  changeBatch(state, b.id, { waterSource: "山泉水" }, NOW);
  assert.equal(boxBatch(state, b.id, { box: "盒" }, NOW).code, "box_gate_failed");
  addResun(state, b.id, { operator: "甲", confirmer: "乙", density: "合格", edge: "均匀", requestId: "r1" }, NOW);
  addResun(state, b.id, { operator: "甲", confirmer: "丙", density: "合格", edge: "均匀", requestId: "r2" }, NOW);
  assert.equal(findBatch(state, b.id).status, "待入盒");
  assert.ok(boxBatch(state, b.id, { box: "盒" }, NOW).ok);
});

test("未入盒不能结束批次", () => {
  const state = emptyState();
  const b = seedBatch(state);
  assert.equal(endBatch(state, b.id, NOW).code, "not_boxed");
});

test("统计与卡片同源：computeStats 覆盖各状态与受影响数", () => {
  const state = emptyState();
  const b1 = seedBatch(state, { chemicalBatch: "B-1" });
  const b2 = seedBatch(state, { chemicalBatch: "B-2", developResult: { density: "不合格", edge: "边缘不均" } });
  reviewBatch(state, b1.id, { reviewer: "乙", decision: "通过" }, NOW);
  boxBatch(state, b1.id, { box: "盒" }, NOW);
  changeBatch(state, b1.id, { waterSource: "山泉水" }, NOW);
  const stats = computeStats(state.batches);
  assert.equal(stats["总数"], 2);
  assert.equal(stats["已入盒"], 1);
  assert.equal(stats["复核中"], 1);
  assert.equal(stats["受影响"], 1);
  assert.equal(stats["待入盒"], 0);
  assert.equal(stats["已结束"], 0);
});
