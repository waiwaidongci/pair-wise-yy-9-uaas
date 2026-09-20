// 存储层：JSON 落库、旧底片数据迁移、写操作串行化与复晒幂等（不含业务判定规则）

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DomainError,
  canBox,
  computeStats,
  findActiveChemicalBatch,
  invalidateConclusion,
  nextBatchCode,
  presentBatch,
  readBatchInput,
  readReviewInput,
  reexamineGate,
  str,
} from "./domain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
export const dbPath = process.env.JOINT_REVIEW_DB || join(dataDir, "joint-review-station.json");
// 旧版「底片整理室」存储：新库不存在时自动迁移
const legacyDbPath = join(dataDir, "cyanotype-negative-room.json");

const seed = {
  batches: [
    {
      code: "EB-001",
      chemicalBatch: "B-0620",
      plateSize: "18x24cm",
      exposureMinutes: 8,
      waterSource: "井水过滤",
      developResult: "合格",
      operator: "周师傅",
      box: "蓝盒A-03",
      statusStored: "已入盒",
      conclusionValid: true,
      invalidReason: "",
      reviews: [
        { id: "R-1", at: "2026-06-20T02:10:00.000Z", densityOk: true, edgeEven: true, confirmer: "林复核", reviewer: "周师傅", note: "复晒第1次" },
        { id: "R-2", at: "2026-06-20T02:30:00.000Z", densityOk: true, edgeEven: true, confirmer: "林复核", reviewer: "周师傅", note: "复晒第2次，连续合格，入盒" },
      ],
      logs: [
        { at: "2026-06-19T08:00:00.000Z", step: "建档", note: "药液 B-0620 建档" },
        { at: "2026-06-20T02:35:00.000Z", step: "入盒", note: "入盒 蓝盒A-03" },
      ],
    },
    {
      code: "EB-002",
      chemicalBatch: "B-0621",
      plateSize: "20x30cm",
      exposureMinutes: 10,
      waterSource: "雨水沉淀",
      developResult: "不合格",
      operator: "陈晒工",
      box: "",
      statusStored: "待复核",
      conclusionValid: true,
      invalidReason: "",
      reviews: [],
      logs: [{ at: "2026-06-21T01:00:00.000Z", step: "建档", note: "药液 B-0621 建档，等待复晒复核" }],
    },
    {
      code: "EB-003",
      chemicalBatch: "B-0598",
      plateSize: "13x18cm",
      exposureMinutes: 12,
      waterSource: "山泉水",
      developResult: "合格",
      operator: "周师傅",
      box: "蓝盒B-11",
      statusStored: "已入盒",
      conclusionValid: false,
      invalidReason: "冲洗水源由「山泉水」改为「井水过滤」",
      reviews: [
        { id: "R-1", at: "2026-06-18T05:00:00.000Z", densityOk: true, edgeEven: true, confirmer: "林复核", reviewer: "周师傅", note: "复晒第1次" },
        { id: "R-2", at: "2026-06-18T05:20:00.000Z", densityOk: true, edgeEven: true, confirmer: "林复核", reviewer: "周师傅", note: "复晒第2次，入盒" },
        { id: "R-3", at: "2026-06-22T01:00:00.000Z", invalidation: true, densityOk: null, edgeEven: null, confirmer: "", reviewer: "周师傅", note: "水源变化，结论失效" },
      ],
      logs: [
        { at: "2026-06-18T05:25:00.000Z", step: "入盒", note: "入盒 蓝盒B-11" },
        { at: "2026-06-22T01:00:00.000Z", step: "显影失效", note: "已入盒，标记受影响：冲洗水源由「山泉水」改为「井水过滤」（操作人：周师傅）" },
      ],
      affectedAt: "2026-06-22T01:00:00.000Z",
    },
  ],
};

// 旧版「底片整理室」数据 -> 联审台批次（内部迁移，不经过外部必填校验）
function freshSeed() {
  return {
    batches: seed.batches.map((b) => ({
      ...b,
      reviews: b.reviews.map((r) => ({ ...r })),
      logs: b.logs.map((l) => ({ ...l })),
    })),
  };
}
function migrate(old) {
  if (old && Array.isArray(old.batches)) return { batches: old.batches };
  if (!old || !Array.isArray(old.items)) return freshSeed();
  const batches = old.items.map((item, index) => {
    const minutes = Number(str(item.exposure).replace(/[^\d.]/g, "")) || 0;
    const wasBoxed = item.status === "已交付" || (item.status === "待入盒" && !!item.box);
    const developResult = item.developResult === "不合格" ? "不合格" : "合格";
    return {
      code: item.code || "EB-" + String(index + 1).padStart(3, "0"),
      chemicalBatch: item.chemicalBatch || "B-UNKNOWN",
      plateSize: item.plateSize || "",
      exposureMinutes: minutes,
      waterSource: item.waterSource || "",
      developResult,
      operator: "迁移",
      box: item.box || "",
      statusStored: wasBoxed ? "已入盒" : "待复核",
      conclusionValid: true,
      invalidReason: "",
      reviews: [],
      logs: (item.logs || []).map((l) => ({ at: l.at, step: l.step, note: l.note })),
    };
  });
  return { batches };
}

let cache;
async function readRaw() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    // 旧版「底片整理室」数据存在时先迁移，否则写入初始种子
    if (existsSync(legacyDbPath)) {
      const legacy = JSON.parse(await readFile(legacyDbPath, "utf8"));
      const migrated = migrate(legacy);
      await writeFile(dbPath, JSON.stringify(migrated, null, 2));
      return migrated;
    }
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return freshSeed();
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function loadDb() {
  if (!cache) cache = migrate(await readRaw());
  return cache;
}
async function persist(db) {
  cache = db;
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

// 测试辅助：重置为只含初始种子的库
export async function resetDb() {
  cache = undefined;
  const fresh = freshSeed();
  await persist(fresh);
  return fresh;
}

// 写操作全局串行：加载与校验/冲突在同一段临界区完成，409 时绝不落库
let chain = Promise.resolve();
function mutate(work) {
  const run = chain.then(async () => {
    const db = await loadDb();
    return work(db);
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export async function listBatches() {
  const db = await loadDb();
  return db.batches.map(presentBatch);
}
// 统计与列表、卡片同源：都从同一份存储批次推导，刷新后一致
export async function stats() {
  const db = await loadDb();
  return computeStats(db.batches);
}
export async function getBatch(code) {
  const db = await loadDb();
  const batch = db.batches.find((b) => b.code === code);
  if (!batch) throw new DomainError(404, "not_found", "未找到曝光批次 " + code);
  return presentBatch(batch);
}
function findBatch(db, code) {
  const batch = db.batches.find((b) => b.code === code);
  if (!batch) throw new DomainError(404, "not_found", "未找到曝光批次 " + code);
  return batch;
}

// 新建曝光批次：同一药液批次只服务一个未结束曝光批次，冲突 409 且不落库
export function createBatch(raw) {
  return mutate(async (db) => {
    const input = readBatchInput(raw);
    const occupant = findActiveChemicalBatch(db, input.chemicalBatch);
    if (occupant) {
      throw new DomainError(409, "chemical_batch_busy",
        "药液批次 " + input.chemicalBatch + " 正服务于未结束曝光批次 " + occupant.code + "，本次提交已拒绝且未保存",
        { occupant: occupant.code });
    }
    const at = new Date().toISOString();
    const batch = {
      code: nextBatchCode(db),
      ...input,
      box: "",
      statusStored: "待复核",
      conclusionValid: true,
      invalidReason: "",
      reviews: [],
      logs: [{ at, step: "建档", note: "药液 " + input.chemicalBatch + " 建档（操作人：" + input.operator + "）" }],
    };
    db.batches.unshift(batch);
    await persist(db);
    return presentBatch(batch);
  });
}

// 复晒复核：须另一人确认；重复或并发沿用首次（requestKey 幂等）
export function addReview(code, raw) {
  return mutate(async (db) => {
    const batch = findBatch(db, code);
    const input = readReviewInput(raw);
    const reviews = batch.reviews || (batch.reviews = []);

    if (input.requestKey) {
      const existing = reviews.find((r) => r.requestKey === input.requestKey && !r.invalidation);
      if (existing) {
        return { reused: true, review: existing, batch: presentBatch(batch) };
      }
    }

    const review = {
      id: "R-" + (reviews.filter((r) => !r.invalidation).length + 1),
      at: new Date().toISOString(),
      densityOk: input.densityOk,
      edgeEven: input.edgeEven,
      confirmer: input.confirmer,
      reviewer: input.reviewer,
      note: input.note || "复晒复核",
    };
    if (input.requestKey) review.requestKey = input.requestKey;
    reviews.push(review);

    const gate = reexamineGate(batch);
    batch.logs ||= [];
    batch.logs.push({
      at: review.at,
      step: "复晒复核",
      note: "密度" + (input.densityOk ? "合格" : "不合格") + "、边缘" + (input.edgeEven ? "均匀" : "不均")
        + "（复核人：" + input.reviewer + "，另一人确认：" + input.confirmer + "，连续 " + gate.streak + "/2）",
    });

    await persist(db);
    return { reused: false, review, batch: presentBatch(batch) };
  });
}

// 水源变化 -> 显影结论失效（未入盒退回；已入盒标受影响）
export function changeWater(code, raw) {
  return mutate(async (db) => {
    const batch = findBatch(db, code);
    const waterSource = str(raw.waterSource);
    const operator = str(raw.operator) || "工位";
    if (!waterSource) throw new DomainError(400, "missing_water_source", "请填写新的冲洗水源");
    if (waterSource === batch.waterSource) {
      return { changed: false, batch: presentBatch(batch) };
    }
    const reason = "冲洗水源由「" + batch.waterSource + "」改为「" + waterSource + "」";
    batch.waterSource = waterSource;
    invalidateConclusion(db, batch, reason, operator);
    await persist(db);
    return { changed: true, batch: presentBatch(batch) };
  });
}

// 曝光补时 -> 显影结论失效（未入盒退回；已入盒标受影响）
export function extendExposure(code, raw) {
  return mutate(async (db) => {
    const batch = findBatch(db, code);
    const add = Number(str(raw.addMinutes));
    const operator = str(raw.operator) || "工位";
    if (!Number.isFinite(add) || add <= 0) throw new DomainError(400, "invalid_add_minutes", "补时时长必须为正数（分钟）");
    const rounded = Math.round(add * 10) / 10;
    const reason = "曝光补时 +" + rounded + " 分钟（" + batch.exposureMinutes + " → " + (Math.round((batch.exposureMinutes + rounded) * 10) / 10) + " 分钟）";
    batch.exposureMinutes = Math.round((batch.exposureMinutes + rounded) * 10) / 10;
    invalidateConclusion(db, batch, reason, operator);
    await persist(db);
    return { changed: true, batch: presentBatch(batch) };
  });
}

// 入盒：复晒须连续两次密度合格且无边缘不均
export function boxBatch(code, raw) {
  return mutate(async (db) => {
    const batch = findBatch(db, code);
    const box = str(raw.box);
    if (!box) throw new DomainError(400, "missing_box", "请填写存放盒位");
    const check = canBox(batch);
    if (!check.ok) throw new DomainError(409, "cannot_box", check.reason);
    batch.box = box;
    batch.statusStored = "已入盒";
    batch.conclusionValid = true;
    batch.invalidReason = "";
    batch.boxedAt = new Date().toISOString();
    batch.logs ||= [];
    batch.logs.push({ at: batch.boxedAt, step: "入盒", note: "入盒 " + box + "（复晒复核连续两次合格）" });
    await persist(db);
    return presentBatch(batch);
  });
}
