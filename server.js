// 适配层：HTTP 路由、静态文件、并发串行化与状态码映射。
// 业务规则全部在 src/domain.js，持久化全部在 src/store.js。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, saveState } from "./src/store.js";
import {
  submitBatch,
  reviewBatch,
  changeBatch,
  addResun,
  boxBatch,
  endBatch,
  computeStats,
  decorate
} from "./src/domain.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3040);

// 写操作全局串行：同一进程内并发请求排队执行，规则冲突时不落库
let writeChain = Promise.resolve();
function serialize(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(() => {}, () => {});
  return run;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const STATUS_BY_CODE = {
  not_found: 404,
  missing_fields: 400,
  invalid_value: 400,
  confirm_required: 400,
  chemical_batch_conflict: 409,
  review_rejected: 409,
  box_gate_failed: 409,
  already_boxed: 409,
  batch_ended: 409,
  not_boxed: 409
};

// 运行领域命令：失败原样返回错误码（不落库），成功后原子写盘
async function runCommand(res, command, onSuccess) {
  const state = await loadState();
  const result = await command(state);
  if (!result.ok) {
    const status = STATUS_BY_CODE[result.code] || 400;
    return send(res, status, { error: result.code, message: result.message, details: result.details });
  }
  await saveState(state);
  return onSuccess(result.value);
}

function statePayload(state) {
  const batches = state.batches.map(decorate);
  return { batches, stats: computeStats(state.batches) };
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

async function serveStatic(req, res, url) {
  const rel = url.pathname === "/" ? "/index.html" : url.pathname.replace(/^\/public/, "");
  const filePath = normalize(join(publicDir, rel));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    const content = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/public/"))) {
    return serveStatic(req, res, url);
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    return loadState().then(state => send(res, 200, statePayload(state)))
      .catch(error => send(res, 500, { error: "internal", message: error.message }));
  }

  // 所有写接口排队执行，保证药液互斥与复晒幂定在并发下仍然成立
  const mutations = [
    { method: "POST", pattern: /^\/api\/batches$/,
      handler: async (body, state) => submitBatch(state, body) },
    { method: "POST", pattern: /^\/api\/batches\/([^/]+)\/review$/,
      handler: async (body, state, m) => reviewBatch(state, m[1], body) },
    { method: "PATCH", pattern: /^\/api\/batches\/([^/]+)\/changes$/,
      handler: async (body, state, m) => changeBatch(state, m[1], body) },
    { method: "POST", pattern: /^\/api\/batches\/([^/]+)\/resuns$/,
      handler: async (body, state, m) => addResun(state, m[1], { ...body, requestId: body.requestId || req.headers["idempotency-key"] }) },
    { method: "POST", pattern: /^\/api\/batches\/([^/]+)\/box$/,
      handler: async (body, state, m) => boxBatch(state, m[1], body) },
    { method: "POST", pattern: /^\/api\/batches\/([^/]+)\/end$/,
      handler: async (body, state, m) => endBatch(state, m[1]) }
  ];

  const route = mutations.find(r => r.method === req.method && url.pathname.match(r.pattern));
  if (!route) return send(res, 404, { error: "not_found", message: "接口不存在" });

  return serialize(async () => {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: "invalid_json", message: "请求体不是合法 JSON" });
    }
    const m = url.pathname.match(route.pattern);
    try {
      return await runCommand(res, state => route.handler(body, state, m), value => {
        const created = url.pathname === "/api/batches";
        return send(res, created ? 201 : 200, { ...value, batch: value.batch ? decorate(value.batch) : value.batch });
      });
    } catch (error) {
      return send(res, 500, { error: "internal", message: error.message });
    }
  });
});

server.listen(port, () => console.log("古法蓝晒 · 曝光批次与冲洗联审台 listening on http://localhost:" + port));
