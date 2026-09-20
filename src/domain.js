// 领域层：曝光批次与冲洗联审规则。纯函数，不做任何 IO，不依赖 HTTP 或文件系统。

export const STATUSES = ["复核中", "待入盒", "已入盒", "已结束"];
export const DENSITIES = ["合格", "不合格"];
export const EDGES = ["均匀", "边缘不均"];

const GOOD_DENSITY = "合格";
const GOOD_EDGE = "均匀";
const ENDED = "已结束";

function fail(code, message, details = {}) {
  return { ok: false, code, message, details };
}
function ok(value = {}) {
  return { ok: true, value };
}
const isBlank = v => v === undefined || v === null || String(v).trim() === "";
const trim = v => String(v).trim();
const stamp = now => (now instanceof Date ? now.toISOString() : now);

export function isGoodResult(result = {}) {
  return result.density === GOOD_DENSITY && result.edge === GOOD_EDGE;
}
export function isUnfinished(batch) {
  return batch.status !== ENDED;
}
// 末尾连续合格（密度合格且边缘均匀）的复晒次数
export function tailGoodStreak(batch) {
  let n = 0;
  for (let i = batch.resuns.length - 1; i >= 0; i -= 1) {
    if (isGoodResult(batch.resuns[i])) n += 1;
    else break;
  }
  return n;
}
export function latestTwoQualified(batch) {
  return tailGoodStreak(batch) >= 2;
}
export function findBatch(state, id) {
  return state.batches.find(b => b.id === id) || null;
}
export function findChemicalConflict(batches, chemicalBatch, exceptId = null) {
  const key = chemicalBatch.trim();
  return batches.find(b => b.chemicalBatch === key && b.id !== exceptId && isUnfinished(b)) || null;
}
export function nextBatchId(batches, now) {
  const d = new Date(now);
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const n = batches.filter(b => b.id.startsWith(`EXP-${day}-`)).length + 1;
  return `EXP-${day}-${String(n).padStart(3, "0")}`;
}

// 规则 2：批次须含尺寸、时长、水源、显影结果（密度/边缘），药液批次与操作员同样必填
export function validateBatchInput(input = {}) {
  const missing = [];
  if (isBlank(input.chemicalBatch)) missing.push("chemicalBatch");
  if (isBlank(input.plateSize)) missing.push("plateSize");
  const minutes = Number(input.exposureMinutes);
  if (isBlank(input.exposureMinutes) || !Number.isFinite(minutes) || minutes <= 0) missing.push("exposureMinutes");
  if (isBlank(input.waterSource)) missing.push("waterSource");
  const result = input.developResult || {};
  if (isBlank(result.density) || isBlank(result.edge)) missing.push("developResult");
  if (isBlank(input.operator)) missing.push("operator");
  return missing;
}

// 提交曝光批次：规则 1 药液互斥（冲突 409，且在任何写入前判定，不落库）
export function submitBatch(state, input = {}, now = new Date().toISOString()) {
  const at = stamp(now);
  const missing = validateBatchInput(input);
  if (missing.length) {
    return fail("missing_fields", "批次缺少必填项：药液批次、尺寸、时长、水源、显影结果、操作员", { missing });
  }
  if (!DENSITIES.includes(input.developResult.density) || !EDGES.includes(input.developResult.edge)) {
    return fail("invalid_value", "显影结果的密度或边缘取值不合法", { density: DENSITIES, edge: EDGES });
  }
  const conflict = findChemicalConflict(state.batches, input.chemicalBatch);
  if (conflict) {
    return fail(
      "chemical_batch_conflict",
      `药液批次 ${trim(input.chemicalBatch)} 正在服务未结束曝光批次 ${conflict.id}，冲突不可提交`,
      { conflictId: conflict.id }
    );
  }
  const batch = {
    id: nextBatchId(state.batches, at),
    chemicalBatch: trim(input.chemicalBatch),
    plateSize: trim(input.plateSize),
    exposureMinutes: Number(input.exposureMinutes),
    waterSource: trim(input.waterSource),
    operator: trim(input.operator),
    developResult: {
      density: input.developResult.density,
      edge: input.developResult.edge,
      note: input.developResult.note ? trim(input.developResult.note) : ""
    },
    status: "复核中",
    boxed: false,
    box: null,
    affected: false,
    conclusionValid: true,
    reviews: [],
    resuns: [],
    createdAt: at,
    endedAt: null,
    logs: [{ at, step: "建档", note: "提交曝光批次，进入冲洗联审" }]
  };
  state.batches.unshift(batch);
  return ok({ batch });
}

// 冲洗联审：通过要求原显影结论仍有效且合格，否则必须走复晒
export function reviewBatch(state, id, payload = {}, now = new Date().toISOString()) {
  const at = stamp(now);
  const batch = findBatch(state, id);
  if (!batch) return fail("not_found", `未找到批次 ${id}`);
  if (batch.status === ENDED) return fail("batch_ended", "批次已结束，不能再联审");
  if (isBlank(payload.reviewer)) return fail("missing_fields", "联审须填写复核人", { missing: ["reviewer"] });
  const decision = payload.decision === "退回" ? "退回" : "通过";
  if (decision === "通过") {
    if (!batch.conclusionValid || !isGoodResult(batch.developResult)) {
      return fail("review_rejected", "显影结论已失效或显影结果不合格，须复晒达标后方可入盒", {
        conclusionValid: batch.conclusionValid,
        developResult: batch.developResult
      });
    }
    batch.status = "待入盒";
  } else {
    batch.status = "复核中";
  }
  batch.reviews.push({ at, reviewer: trim(payload.reviewer), decision, reason: payload.reason ? trim(payload.reason) : "" });
  batch.logs.push({ at, step: "联审", note: `${trim(payload.reviewer)} ${decision}${payload.reason ? `：${trim(payload.reason)}` : ""}` });
  return ok({ batch });
}

// 规则 3：水源变化或曝光补时使显影结论失效。未入盒退回复核，已入盒标受影响
export function changeBatch(state, id, patch = {}, now = new Date().toISOString()) {
  const at = stamp(now);
  const batch = findBatch(state, id);
  if (!batch) return fail("not_found", `未找到批次 ${id}`);
  if (batch.status === ENDED) return fail("batch_ended", "批次已结束，不能再变更");

  if (patch.chemicalBatch !== undefined) {
    if (isBlank(patch.chemicalBatch)) return fail("invalid_value", "药液批次不可为空");
    const conflict = findChemicalConflict(state.batches, patch.chemicalBatch, batch.id);
    if (conflict) {
      return fail("chemical_batch_conflict", `药液批次 ${trim(patch.chemicalBatch)} 正被未结束批次 ${conflict.id} 占用`, {
        conflictId: conflict.id
      });
    }
  }
  let nextMinutes;
  if (patch.exposureMinutes !== undefined) {
    nextMinutes = Number(patch.exposureMinutes);
    if (!Number.isFinite(nextMinutes) || nextMinutes <= 0) return fail("invalid_value", "曝光时长必须是正数分钟");
  }
  if (patch.developResult) {
    const r = patch.developResult;
    if (r.density !== undefined && !DENSITIES.includes(r.density)) return fail("invalid_value", "密度取值不合法");
    if (r.edge !== undefined && !EDGES.includes(r.edge)) return fail("invalid_value", "边缘取值不合法");
  }

  const reasons = [];
  if (patch.waterSource !== undefined && trim(patch.waterSource) !== batch.waterSource) {
    reasons.push(`水源变化：${batch.waterSource} → ${trim(patch.waterSource)}`);
  }
  const supplement = nextMinutes !== undefined && nextMinutes > batch.exposureMinutes;
  if (supplement) reasons.push(`曝光补时：${batch.exposureMinutes} → ${nextMinutes} 分钟`);

  // 全部校验通过后才落变更
  if (patch.chemicalBatch !== undefined) batch.chemicalBatch = trim(patch.chemicalBatch);
  if (patch.plateSize !== undefined && !isBlank(patch.plateSize)) batch.plateSize = trim(patch.plateSize);
  if (nextMinutes !== undefined) batch.exposureMinutes = nextMinutes;
  if (patch.waterSource !== undefined && !isBlank(patch.waterSource)) batch.waterSource = trim(patch.waterSource);
  if (patch.operator !== undefined && !isBlank(patch.operator)) batch.operator = trim(patch.operator);
  if (patch.developResult) {
    batch.developResult = { ...batch.developResult, ...patch.developResult };
  }

  const invalidated = reasons.length > 0;
  if (invalidated) {
    batch.conclusionValid = false;
    const tail = reasons.join("；");
    if (batch.boxed) {
      batch.affected = true;
      batch.logs.push({ at, step: "结论失效", note: `${tail}；已入盒批次标记为受影响` });
    } else {
      batch.status = "复核中";
      batch.logs.push({ at, step: "退回复核", note: `${tail}；显影结论失效，退回复核` });
    }
  }
  return ok({ batch, invalidated, reasons });
}

// 规则 4：复晒须另一人确认；重复或并发请求凭 requestId 沿用首次记录
export function addResun(state, id, payload = {}, now = new Date().toISOString()) {
  const at = stamp(now);
  const batch = findBatch(state, id);
  if (!batch) return fail("not_found", `未找到批次 ${id}`);
  if (batch.status === ENDED) return fail("batch_ended", "批次已结束，不能再复晒");
  if (isBlank(payload.operator)) return fail("missing_fields", "须填写复晒操作人", { missing: ["operator"] });
  if (isBlank(payload.confirmer)) return fail("confirm_required", "复晒须另一人确认，请填写确认人", { missing: ["confirmer"] });
  if (trim(payload.operator) === trim(payload.confirmer)) {
    return fail("confirm_required", "复晒确认人必须是操作人之外的另一人", { operator: trim(payload.operator) });
  }
  const density = payload.density || GOOD_DENSITY;
  const edge = payload.edge || GOOD_EDGE;
  if (!DENSITIES.includes(density)) return fail("invalid_value", "密度取值不合法");
  if (!EDGES.includes(edge)) return fail("invalid_value", "边缘取值不合法");

  const requestId = isBlank(payload.requestId) ? `RS-${batch.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : trim(payload.requestId);
  const existing = batch.resuns.find(r => r.requestId === requestId);
  if (existing) return ok({ batch, reused: true, resun: existing });

  const resun = {
    id: `RS-${batch.id}-${batch.resuns.length + 1}`,
    requestId,
    at,
    operator: trim(payload.operator),
    confirmer: trim(payload.confirmer),
    density,
    edge,
    note: payload.note ? trim(payload.note) : ""
  };
  batch.resuns.push(resun);
  batch.logs.push({
    at,
    step: "复晒",
    note: `${resun.operator} 操作、${resun.confirmer} 另一人确认；密度${density}，${edge === GOOD_EDGE ? "无边缘不均" : edge}`
  });

  // 连续两次密度合格且无边缘不均才可入盒：达标回到待入盒，新增不合格记录则打回复核
  if (!batch.boxed) {
    const gate = canBox(batch);
    if (gate.ok) batch.status = "待入盒";
    else if (batch.status === "待入盒") batch.status = "复核中";
  }
  return ok({ batch, reused: false, resun });
}

// 入盒门槛：原结论有效且合格，或末尾连续两次复晒合格
export function canBox(batch) {
  if (batch.boxed) return fail("already_boxed", "批次已入盒，不能重复入盒");
  if (batch.status === ENDED) return fail("batch_ended", "批次已结束");
  if (batch.conclusionValid && isGoodResult(batch.developResult)) {
    return ok({ via: "original", message: "显影结论有效且密度合格、无边缘不均" });
  }
  if (latestTwoQualified(batch)) {
    return ok({ via: "resun", message: "连续两次复晒密度合格且无边缘不均" });
  }
  const have = tailGoodStreak(batch);
  const why = !batch.conclusionValid ? "显影结论已失效" : "显影结果密度不合格或存在边缘不均";
  return fail(
    "box_gate_failed",
    `${why}；须连续两次复晒密度合格且无边缘不均才可入盒（当前末尾连续合格 ${have} 次）`,
    { tailGoodStreak: have, need: 2 }
  );
}

export function boxBatch(state, id, payload = {}, now = new Date().toISOString()) {
  const at = stamp(now);
  const batch = findBatch(state, id);
  if (!batch) return fail("not_found", `未找到批次 ${id}`);
  if (isBlank(payload.box)) return fail("missing_fields", "入盒须填写盒位", { missing: ["box"] });
  const gate = canBox(batch);
  if (!gate.ok) return gate;
  batch.boxed = true;
  batch.box = trim(payload.box);
  batch.status = "已入盒";
  batch.affected = false;
  batch.logs.push({ at, step: "入盒", note: `入盒 ${batch.box}（依据：${gate.value.message}）` });
  return ok({ batch, via: gate.value.via });
}

// 结束后药液批次才被释放，可服务新的未结束曝光批次
export function endBatch(state, id, now = new Date().toISOString()) {
  const at = stamp(now);
  const batch = findBatch(state, id);
  if (!batch) return fail("not_found", `未找到批次 ${id}`);
  if (batch.status === ENDED) return fail("batch_ended", "批次已结束");
  if (!batch.boxed) return fail("not_boxed", "批次尚未入盒，不能结束");
  batch.status = ENDED;
  batch.endedAt = at;
  batch.logs.push({ at, step: "结束", note: "批次结束，药液批次释放" });
  return ok({ batch });
}

export function computeStats(batches) {
  const stats = { 总数: batches.length, 受影响: 0 };
  for (const s of STATUSES) stats[s] = 0;
  for (const b of batches) {
    if (stats[b.status] !== undefined) stats[b.status] += 1;
    if (b.affected) stats["受影响"] += 1;
  }
  return stats;
}

// 给展示层附加派生字段：规则只在此处计算一次，卡片与统计共用同一份结果
export function decorate(batch) {
  const gate = canBox(batch);
  return {
    ...batch,
    eligible: gate.ok,
    gateMessage: gate.ok ? gate.value.message : gate.message,
    tailGoodStreak: tailGoodStreak(batch)
  };
}
