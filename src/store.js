// 存储层：只管 JSON 文件的读写与种子，不包含任何业务规则。
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "cyanotype-joint-review.json");

const seed = {
  batches: [
    {
      id: "EXP-20260919-001",
      chemicalBatch: "B-0919-A",
      plateSize: "18x24cm",
      exposureMinutes: 8,
      waterSource: "井水过滤",
      operator: "阿雯",
      developResult: { density: "合格", edge: "均匀", note: "首次冲洗即达标" },
      status: "待入盒",
      boxed: false,
      box: null,
      affected: false,
      conclusionValid: true,
      reviews: [{ at: "2026-09-19T09:40:00.000Z", reviewer: "老周", decision: "通过", reason: "密度与边缘均合格" }],
      resuns: [],
      createdAt: "2026-09-19T09:10:00.000Z",
      endedAt: null,
      logs: [
        { at: "2026-09-19T09:10:00.000Z", step: "建档", note: "提交曝光批次，进入冲洗联审" },
        { at: "2026-09-19T09:40:00.000Z", step: "联审", note: "老周 通过：密度与边缘均合格" }
      ]
    },
    {
      id: "EXP-20260918-002",
      chemicalBatch: "B-0918-C",
      plateSize: "24x30cm",
      exposureMinutes: 10,
      waterSource: "雨水沉淀",
      operator: "阿海",
      developResult: { density: "不合格", edge: "边缘不均", note: "首晒偏淡，左缘发虚" },
      status: "复核中",
      boxed: false,
      box: null,
      affected: false,
      conclusionValid: true,
      reviews: [],
      resuns: [
        {
          id: "RS-EXP-20260918-002-1",
          requestId: "seed-rs-002-1",
          at: "2026-09-18T15:20:00.000Z",
          operator: "阿海",
          confirmer: "阿雯",
          density: "合格",
          edge: "边缘不均",
          note: "第一次复晒密度上来了，左缘仍发虚"
        }
      ],
      createdAt: "2026-09-18T14:00:00.000Z",
      endedAt: null,
      logs: [
        { at: "2026-09-18T14:00:00.000Z", step: "建档", note: "提交曝光批次，进入冲洗联审" },
        { at: "2026-09-18T15:20:00.000Z", step: "复晒", note: "阿海 操作、阿雯 另一人确认；密度合格，边缘不均" }
      ]
    },
    {
      id: "EXP-20260915-003",
      chemicalBatch: "B-0915-B",
      plateSize: "20x25cm",
      exposureMinutes: 12,
      waterSource: "山泉水",
      operator: "老周",
      developResult: { density: "合格", edge: "均匀", note: "" },
      status: "已入盒",
      boxed: true,
      box: "蓝盒A-03",
      affected: true,
      conclusionValid: false,
      reviews: [{ at: "2026-09-15T11:00:00.000Z", reviewer: "阿海", decision: "通过", reason: "" }],
      resuns: [],
      createdAt: "2026-09-15T10:00:00.000Z",
      endedAt: null,
      logs: [
        { at: "2026-09-15T10:00:00.000Z", step: "建档", note: "提交曝光批次，进入冲洗联审" },
        { at: "2026-09-15T11:00:00.000Z", step: "联审", note: "阿海 通过" },
        { at: "2026-09-15T11:30:00.000Z", step: "入盒", note: "入盒 蓝盒A-03（依据：显影结论有效且密度合格、无边缘不均）" },
        { at: "2026-09-16T08:30:00.000Z", step: "结论失效", note: "水源变化：井水过滤 → 山泉水；曝光补时：8 → 12 分钟；已入盒批次标记为受影响" }
      ]
    },
    {
      id: "EXP-20260910-004",
      chemicalBatch: "B-0910-A",
      plateSize: "18x24cm",
      exposureMinutes: 9,
      waterSource: "井水过滤",
      operator: "阿雯",
      developResult: { density: "合格", edge: "均匀", note: "" },
      status: "已结束",
      boxed: true,
      box: "蓝盒A-01",
      affected: false,
      conclusionValid: true,
      reviews: [{ at: "2026-09-10T10:00:00.000Z", reviewer: "老周", decision: "通过", reason: "" }],
      resuns: [],
      createdAt: "2026-09-10T09:00:00.000Z",
      endedAt: "2026-09-10T16:00:00.000Z",
      logs: [
        { at: "2026-09-10T09:00:00.000Z", step: "建档", note: "提交曝光批次，进入冲洗联审" },
        { at: "2026-09-10T10:00:00.000Z", step: "联审", note: "老周 通过" },
        { at: "2026-09-10T10:30:00.000Z", step: "入盒", note: "入盒 蓝盒A-01（依据：显影结论有效且密度合格、无边缘不均）" },
        { at: "2026-09-10T16:00:00.000Z", step: "结束", note: "批次结束，药液批次释放" }
      ]
    }
  ]
};

export async function loadState() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return structuredClone(seed);
  }
  const data = JSON.parse(await readFile(dbPath, "utf8"));
  if (!Array.isArray(data.batches)) data.batches = [];
  return data;
}

// 原子落库：先写临时文件再 rename，避免刷新时读到半截 JSON
export async function saveState(state) {
  const tmp = `${dbPath}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, dbPath);
}
