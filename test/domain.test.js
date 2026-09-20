import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canBox,
  computeStats,
  deriveStatus,
  findActiveChemicalBatch,
  invalidateConclusion,
  presentBatch,
  readBatchInput,
  readReviewInput,
  recentReviews,
  reexamineGate,
} from "../src/domain.js";

const validBatchInput = {
  chemicalBatch: "B-100",
  plateSize: "18x24cm",
  exposureMinutes: 8,
  waterSource: "井水过滤",
  developResult: "合格",
};

function makeBatch(overrides = {}) {
  return {
    code: "EB-900",
    chemicalBatch: "B-100",
    plateSize: "18x24cm",
    exposureMinutes: 8,
    waterSource: "井水过滤",
    developResult: "合格",
    operator: "周师傅",
    box: "",
    statusStored: "待复核",
    conclusionValid: true,
    invalidReason: "",
    reviews: [],
    logs: [],
    ...overrides,
  };
}
const pass = (n, extra = {}) => ({
  id: "R-" + n, densityOk: true, edgeEven: true, confirmer: "林复核", reviewer: "周师傅", ...extra,
});

test("缺项不可提交：尺寸/时长/水源/显影结果缺一即 400", () => {
  for (const key of ["plateSize", "exposureMinutes", "waterSource", "developResult"]) {
    const raw = { ...validBatchInput, chemicalBatch: "B-10" + key };
    delete raw[key];
    assert.throws(() => readBatchInput(raw), (e) => e.status === 400 && e.code === "missing_fields");
  }
  assert.throws(() => readBatchInput({ ...validBatchInput, exposureMinutes: -3 }), (e) => e.code === "invalid_exposure");
  assert.throws(() => readBatchInput({ ...validBatchInput, developResult: "马马虎虎" }), (e) => e.code === "invalid_develop_result");
  assert.doesNotThrow(() => readBatchInput(validBatchInput));
});

test("同一药液批次只服务一个未结束曝光批次", () => {
  const db = { batches: [makeBatch({ code: "EB-001", statusStored: "待复核" })] };
  assert.equal(findActiveChemicalBatch(db, "B-100").code, "EB-001");
  // 已入盒批次不再占用药液
  db.batches[0].statusStored = "已入盒";
  assert.equal(findActiveChemicalBatch(db, "B-100"), undefined);
  // 受影响（已入盒）也不占用
  db.batches[0].statusStored = "已入盒";
  db.batches[0].conclusionValid = false;
  assert.equal(findActiveChemicalBatch(db, "B-100"), undefined);
});

test("复晒须另一人确认：同人复核返回冲突", () => {
  assert.throws(() => readReviewInput({ confirmer: "周", reviewer: "周", densityOk: true }), (e) => e.status === 409 && e.code === "same_person");
  assert.throws(() => readReviewInput({ confirmer: "", reviewer: "周" }), (e) => e.code === "missing_confirmer");
  const input = readReviewInput({ confirmer: "林", reviewer: "周", densityOk: true, edgeEven: true });
  assert.equal(input.densityOk, true);
});

test("连续两次密度合格且无边缘不均才可入盒", () => {
  const b = makeBatch();
  assert.equal(reexamineGate(b).satisfied, false);
  b.reviews.push(pass(1));
  assert.equal(reexamineGate(b).satisfied, false);
  b.reviews.push(pass(2));
  assert.equal(reexamineGate(b).satisfied, true);
  // 任一次边缘不均则打断
  b.reviews.push({ id: "R-3", densityOk: true, edgeEven: false, confirmer: "林", reviewer: "周" });
  assert.equal(reexamineGate(b).satisfied, false);
  // 密度不合格同样不可
  b.reviews[2] = { id: "R-3", densityOk: false, edgeEven: true, confirmer: "林", reviewer: "周" };
  assert.equal(reexamineGate(b).satisfied, false);
});

test("失效后重新计数：只有最近一次失效之后的复晒才有效", () => {
  const b = makeBatch({
    reviews: [
      pass(1), pass(2),
      { id: "R-3", invalidation: true, densityOk: null, edgeEven: null, confirmer: "", reviewer: "周" },
      pass(4),
    ],
  });
  assert.equal(recentReviews(b).length, 1);
  assert.equal(reexamineGate(b).streak, 1);
  assert.equal(reexamineGate(b).satisfied, false);
});

test("未入盒失效 -> 退回复核；已入盒失效 -> 标记受影响", () => {
  const open = makeBatch({ statusStored: "可入盒" });
  invalidateConclusion({ batches: [open] }, open, "水源变化", "周");
  assert.equal(open.conclusionValid, false);
  assert.equal(open.statusStored, "待复核");
  assert.equal(deriveStatus(open), "待复核");

  const boxed = makeBatch({ statusStored: "已入盒", box: "蓝盒A-01" });
  invalidateConclusion({ batches: [boxed] }, boxed, "曝光补时 +2 分钟", "周");
  assert.equal(boxed.statusStored, "已入盒"); // 盒位保留
  assert.equal(deriveStatus(boxed), "受影响");
  assert.ok(boxed.affectedAt);
});

test("入盒闸门：失效结论或复晒不足均不可入盒", () => {
  const b = makeBatch();
  assert.equal(canBox(b).ok, false);
  b.reviews.push(pass(1), pass(2));
  assert.equal(canBox(b).ok, true);
  invalidateConclusion({ batches: [b] }, b, "改水源", "周");
  assert.equal(canBox(b).ok, false);
  // 已入盒且有效 -> 拒绝重复入盒
  const done = makeBatch({ statusStored: "已入盒", box: "盒", reviews: [pass(1), pass(2)] });
  assert.equal(canBox(done).ok, false);
});

test("统计与卡片同源：受影响批次计入「受影响」，且不释放为占用中", () => {
  const ready = makeBatch({ code: "EB-1", reviews: [pass(1), pass(2)] });
  const boxed = makeBatch({ code: "EB-2", statusStored: "已入盒", box: "盒", reviews: [pass(1), pass(2)] });
  const affected = makeBatch({ code: "EB-3", statusStored: "已入盒", box: "盒", reviews: [pass(1), pass(2)] });
  invalidateConclusion({ batches: [affected] }, affected, "补时", "周");

  assert.equal(deriveStatus(ready), "可入盒");
  assert.equal(deriveStatus(boxed), "已入盒");
  assert.equal(deriveStatus(affected), "受影响");

  const stats = computeStats([ready, boxed, affected]);
  assert.equal(stats["可入盒"], 1);
  assert.equal(stats["已入盒"], 1);
  assert.equal(stats["受影响"], 1);
  assert.equal(stats["药液占用中"], 1); // 仅可入盒(未入盒)占用；受影响已入盒不占用
  assert.equal(presentBatch(affected).chemicalOccupied, false);
});
