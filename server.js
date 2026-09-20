// 入口：仅负责 HTTP 路由编排。规则在 src/domain.js，存储在 src/store.js，展示在 src/view.js。

import http from "node:http";
import {
  addReview,
  boxBatch,
  changeWater,
  createBatch,
  extendExposure,
  getBatch,
  listBatches,
  stats,
} from "./src/store.js";
import { DomainError } from "./src/domain.js";
import { renderPage } from "./src/view.js";

const port = Number(process.env.PORT || 3040);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError(400, "bad_json", "请求体不是合法 JSON");
  }
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function sendHtml(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const { pathname } = url;

      if (req.method === "GET" && pathname === "/") return sendHtml(res, renderPage());
      if (req.method === "GET" && pathname === "/api/batches") {
        return sendJson(res, 200, await listBatches());
      }
      if (req.method === "GET" && pathname === "/api/stats") {
        return sendJson(res, 200, await stats());
      }

      if (req.method === "POST" && pathname === "/api/batches") {
        const batch = await createBatch(await readBody(req));
        return sendJson(res, 201, batch);
      }

      const detail = pathname.match(/^\/api\/batches\/([^/]+)$/);
      if (detail && req.method === "GET") return sendJson(res, 200, await getBatch(decodeURIComponent(detail[1])));

      const reviews = pathname.match(/^\/api\/batches\/([^/]+)\/reviews$/);
      if (reviews && req.method === "POST") {
        const result = await addReview(decodeURIComponent(reviews[1]), await readBody(req));
        // 重复或并发沿用首次：返回同一份批次数据，并以 reused 标注命中首次
        return sendJson(res, 200, { ...result.batch, reused: result.reused });
      }

      const water = pathname.match(/^\/api\/batches\/([^/]+)\/water$/);
      if (water && req.method === "POST") {
        const result = await changeWater(decodeURIComponent(water[1]), await readBody(req));
        return sendJson(res, 200, result.batch);
      }

      const extra = pathname.match(/^\/api\/batches\/([^/]+)\/extra-exposure$/);
      if (extra && req.method === "POST") {
        const result = await extendExposure(decodeURIComponent(extra[1]), await readBody(req));
        return sendJson(res, 200, result.batch);
      }

      const box = pathname.match(/^\/api\/batches\/([^/]+)\/box$/);
      if (box && req.method === "POST") {
        const result = await boxBatch(decodeURIComponent(box[1]), await readBody(req));
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { error: "not_found", message: "接口不存在" });
    } catch (error) {
      if (error instanceof DomainError) {
        return sendJson(res, error.status, { error: error.code, message: error.message, ...(error.occupant ? { occupant: error.occupant } : {}) });
      }
      return sendJson(res, 500, { error: "internal_error", message: error.message });
    }
  });
}

// 直接运行时启动；被测试导入时不自动监听
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(port, () => console.log("曝光批次与冲洗联审台 listening on http://localhost:" + port));
}
