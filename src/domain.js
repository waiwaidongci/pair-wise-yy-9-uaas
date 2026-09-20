// 规则层：曝光批次与冲洗联审台的全部业务规则（纯函数，不碰存储与展示）

export const STATUSES = ["待复核", "可入盒", "已入盒", "受影响"];
export const STAT_LABELS = ["待复核", "可入盒", "已入盒", "受影响"];

// 批次提交时的必填项：尺寸、时长、水源、显影结果（缺一不可提交）
export const REQUIRED = [
  ["plateSize", "尺寸"],
  ["exposureMinutes", "曝光时长"],
  ["waterSource", "冲洗水源"],
  ["developResult", "显影结果"],
];
export const DEVELOP_RESULTS = ["合格", "不合格"];
export const NOT_CLOSED = ["待复核", "可入盒"]; // 未结束曝光批次 = 尚未入盒
export const OPEN_STATUSES = ["待复核", "可入盒", "受影响"];

export class DomainError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export function str(value) {
  return (value ?? "").toString().trim();
}

// 读取并校验「新建曝光批次」入参
export function readBatchInput(raw = {}) {
  const chemicalBatch = str(raw.chemicalBatch);
  const plateSize = str(raw.plateSize);
  const waterSource = str(raw.waterSource);
  const developResult = str(raw.developResult);
  const minutesRaw = str(raw.exposureMinutes);
  const operator = str(raw.operator) || "工位";

  const missing = [];
  if (!chemicalBatch) missing.push("药液批次");
  if (!plateSize) missing.push("尺寸");
  if (!minutesRaw) missing.push("曝光时长");
  if (!waterSource) missing.push("冲洗水源");
  if (!developResult) missing.push("显影结果");
  if (missing.length) {
    throw new DomainError(400, "missing_fields", "批次缺少必填项：" + missing.join("、"), { missing });
  }
  const exposureMinutes = Number(minutesRaw);
  if (!Number.isFinite(exposureMinutes) || exposureMinutes <= 0) {
    throw new DomainError(400, "invalid_exposure", "曝光时长必须为正数（分钟）");
  }
  if (!DEVELOP_RESULTS.includes(developResult)) {
    throw new DomainError(400, "invalid_develop_result", "显影结果只能为「合格」或「不合格」");
  }
  return { chemicalBatch, plateSize, waterSource, developResult, exposureMinutes, operator };
}

// 同一药液批次只服务一个未结束（未入盒）曝光批次
export function findActiveChemicalBatch(db, chemicalBatch) {
  return db.batches.find((b) => b.chemicalBatch === chemicalBatch && NOT_CLOSED.includes(b.statusStored));
}

// 失效后以最近一次失效为准，统计其后连续密度合格且无边缘不均的复晒复核
export function recentReviews(batch) {
  const reviews = batch.reviews || [];
  let lastInvalidation = -1;
  for (let i = 0; i < reviews.length; i += 1) {
    if (reviews[i].invalidation) lastInvalidation = i;
  }
  return lastInvalidation >= 0 ? reviews.slice(lastInvalidation + 1) : reviews;
}

export function passes(review) {
  return review.densityOk === true && review.edgeEven === true;
}

// 复晒：连续两次密度合格且无边缘不均，才可入盒
export function reexamineGate(batch) {
  const recent = recentReviews(batch);
  const streak = (() => {
    let n = 0;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (passes(recent[i])) n += 1;
      else break;
    }
    return n;
  })();
  const lastTwo = recent.slice(-2);
  const satisfied = lastTwo.length === 2 && lastTwo.every(passes);
  return { recent, streak, needed: 2, satisfied };
}

// 当前生效状态（推导值，以存储事实为准）
export function deriveStatus(batch) {
  if (batch.statusStored === "已入盒") {
    return batch.conclusionValid === false ? "受影响" : "已入盒";
  }
  const gate = reexamineGate(batch);
  return gate.satisfied ? "可入盒" : "待复核";
}

// 水源变化或曝光补时 -> 显影结论失效
export function invalidateConclusion(db, batch, reason, operator = "工位") {
  const wasBoxed = batch.statusStored === "已入盒";
  batch.conclusionValid = false;
  batch.invalidReason = reason;
  batch.logs ||= [];
  batch.logs.push({
    at: new Date().toISOString(),
    step: "显影失效",
    note: (wasBoxed ? "已入盒，标记受影响：" : "未入盒，退回复核：") + reason + "（操作人：" + operator + "）",
  });
  // 失效标记同时作为复晒计数的新起点
  (batch.reviews || (batch.reviews = [])).push({
    id: "R-" + ((batch.reviews || []).length + 1),
    at: new Date().toISOString(),
    invalidation: true,
    densityOk: null,
    edgeEven: null,
    confirmer: "",
    reviewer: operator,
    note: reason,
  });
  if (wasBoxed) {
    // 已入盒：锁定盒位、标记受影响，等待复晒复核
    batch.affectedAt = new Date().toISOString();
  } else {
    // 未入盒：退回「待复核」
    batch.statusStored = "待复核";
  }
  return batch;
}

// 读取并校验复晒复核入参（须另一人确认）
export function readReviewInput(raw = {}) {
  const confirmer = str(raw.confirmer);
  const reviewer = str(raw.reviewer);
  const densityOk = raw.densityOk === true || raw.densityOk === "true";
  const edgeEven = raw.edgeEven === true || raw.edgeEven === "true";
  const requestKey = str(raw.requestKey);
  if (!confirmer) throw new DomainError(400, "missing_confirmer", "复晒须另一人确认，请填写确认人");
  if (!reviewer) throw new DomainError(400, "missing_reviewer", "请填写复核人");
  if (confirmer === reviewer) {
    throw new DomainError(409, "same_person", "复晒须另一人确认，确认人与复核人不能为同一人");
  }
  return { confirmer, reviewer, densityOk, edgeEven, requestKey, note: str(raw.note) };
}

function gateReason(gate) {
  return "复晒复核未通过：需连续两次「密度合格且无边缘不均」（当前 " + gate.streak + "/2）";
}

// 入盒判定
export function canBox(batch) {
  if (batch.statusStored === "已入盒" && batch.conclusionValid !== false) {
    return { ok: false, reason: "批次已入盒，无需重复操作" };
  }
  if (batch.conclusionValid === false && batch.statusStored !== "已入盒") {
    return { ok: false, reason: "显影结论已失效，请先完成复晒复核" };
  }
  const gate = reexamineGate(batch);
  if (!gate.satisfied) return { ok: false, reason: gateReason(gate) };
  return { ok: true, reason: "" };
}

// 视图/接口用的富对象（卡片、统计与刷新后的唯一数据源）
export function presentBatch(batch) {
  const status = deriveStatus(batch);
  const gate = reexamineGate(batch);
  const chemicalOccupied = NOT_CLOSED.includes(status);
  return {
    code: batch.code,
    chemicalBatch: batch.chemicalBatch,
    plateSize: batch.plateSize,
    exposureMinutes: batch.exposureMinutes,
    waterSource: batch.waterSource,
    developResult: batch.developResult,
    operator: batch.operator,
    box: batch.box || "",
    status,
    conclusionValid: batch.conclusionValid !== false,
    invalidReason: batch.invalidReason || "",
    gate: { streak: gate.streak, needed: gate.needed, satisfied: gate.satisfied },
    reviews: batch.reviews || [],
    logs: batch.logs || [],
    chemicalOccupied,
  };
}

export function computeStats(batches) {
  const stats = Object.fromEntries(STAT_LABELS.map((label) => [label, 0]));
  stats.药液占用中 = 0;
  for (const batch of batches) {
    const view = presentBatch(batch);
    stats[view.status] = (stats[view.status] || 0) + 1;
    if (view.chemicalOccupied) stats.药液占用中 += 1;
  }
  stats.总计 = batches.length;
  return stats;
}

export function nextBatchCode(db) {
  let max = 0;
  for (const batch of db.batches) {
    const m = /^EB-(\d+)$/.exec(batch.code || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "EB-" + String(max + 1).padStart(3, "0");
}
