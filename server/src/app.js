import cookieParser from "cookie-parser";
import express from "express";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { createAuth, passwordMatches } from "./auth.js";
import { findChannel } from "./catalog.js";
import { repoRoot } from "./config.js";
import { ReleaseError } from "./errors.js";
import { FEED_NAME, normalizeIp } from "./feed.js";
import { createStore } from "./store.js";
import { writeArchive } from "./zip.js";

const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;

export async function createApp(config) {
  const normalized = normalizeConfig(config);
  const store = createStore(normalized.dataRoot);
  await store.init();
  const auth = createAuth(normalized);
  const upload = multer({ dest: store.tempDir, limits: { fileSize: MAX_UPLOAD } });
  const app = express();
  app.disable("x-powered-by");
  app.locals.store = store;
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));

  app.post("/api/login", (req, res) => {
    const user = normalized.users.find((item) => item.userName === req.body?.userName);
    if (!user || !passwordMatches(req.body?.password, user.password)) {
      res.status(401).json({ error: "账号或密码不正确。" });
      return;
    }
    auth.setSession(res, user.userName, user.role);
    res.json({ user: user.userName, role: user.role });
  });

  app.post("/api/logout", (req, res) => {
    auth.clearSession(res);
    res.json({ ok: true });
  });

  app.get("/api/me", (req, res) => {
    const actor = auth.actor(req);
    if (!actor) return reject(res);
    res.json({ user: actor.user, role: actor.role, usesFactoryPassword: normalized.usesFactoryPassword });
  });

  app.get("/api/apps", (req, res) => {
    if (!auth.isUser(req)) return reject(res);
    res.json({ apps: store.list() });
  });

  app.get("/api/apps/:appId", (req, res) => {
    if (!auth.isUser(req)) return reject(res);
    const page = store.read(req.params.appId);
    if (!page) return res.status(404).json({ error: "未知程序。" });
    res.json(page);
  });

  app.get("/api/dashboard", (req, res) => guard(res, () => {
    if (!auth.isUser(req)) return reject(res);
    res.json(store.dashboard(req.query.appId || ""));
  }));

  app.get("/api/devices", (req, res) => guard(res, () => {
    if (!auth.isUser(req)) return reject(res);
    res.json({ devices: store.devices(req.query.appId || "") });
  }));

  app.get("/api/devices/:appId/:deviceId/events", (req, res) => guard(res, () => {
    if (!auth.isUser(req)) return reject(res);
    res.json({ events: store.events(req.params.appId, req.params.deviceId) });
  }));

  app.get("/api/policies", (req, res) => {
    if (!auth.isUser(req)) return reject(res);
    res.json({ policies: store.policies() });
  });

  app.put("/api/policies/:appId/:channel", (req, res) => guard(res, () => {
    if (!auth.isAdmin(req)) return reject(res, 403);
    store.setPolicy(req.params.appId, req.params.channel, req.body?.minSupportedVersion);
    res.json({ ok: true });
  }));

  app.put("/api/apps/:appId/versions/:channel/:version/rollout", (req, res) => guard(res, async () => {
    if (!auth.isAdmin(req)) return reject(res, 403);
    await store.setRollout(req.params.appId, req.params.channel, req.params.version, req.body?.rolloutPercent, req.body?.devices, req.body?.ips);
    res.json({ ok: true });
  }));

  app.post("/api/apps/:appId/versions/:channel/:version/unpublish", (req, res) => guard(res, async () => {
    if (!auth.isAdmin(req)) return reject(res, 403);
    await store.unpublish(req.params.appId, req.params.channel, req.params.version);
    res.json({ ok: true });
  }));

  app.post("/api/apps/:appId/versions/:channel/:version/publish", (req, res) => guard(res, async () => {
    if (!auth.isAdmin(req)) return reject(res, 403);
    await store.activate(req.params.appId, req.params.channel, req.params.version);
    res.json({ ok: true });
  }));

  app.get("/api/apps/:appId/versions/:channel/:version/export", (req, res) => guard(res, async () => {
    if (!auth.isUser(req)) return reject(res);
    const pack = store.exportPack(req.params.appId, req.params.channel, req.params.version);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${pack.fileName}"`);
    await writeArchive(res, pack.entries);
  }));

  app.post(
    "/api/apps/:appId/versions",
    (req, res, next) => {
      if (!auth.isUser(req)) return reject(res);
      if (!auth.isAdmin(req)) return reject(res, 403);
      next();
    },
    upload.fields([
      { name: "fullPackage", maxCount: 1 },
      { name: "deltaPackage", maxCount: 1 },
      { name: "feed", maxCount: 1 },
      { name: "setup", maxCount: 1 },
      { name: "archive", maxCount: 1 },
      { name: "packages", maxCount: 20 },
    ]),
    async (req, res) => {
      const uploads = uploadsFrom(req.files);
      try {
        const saved = await store.publish({
          appId: req.params.appId,
          channel: req.body?.channel,
          version: req.body?.version,
          notes: req.body?.notes,
          status: req.body?.status,
          rolloutPercent: req.body?.rolloutPercent,
          devices: req.body?.devices,
          ips: req.body?.ips,
          uploads,
        });
        res.json(saved);
      } catch (error) {
        sendError(res, error);
      } finally {
        await Promise.all(uploads.map((file) => rm(file.path, { force: true })));
      }
    },
  );

  app.post("/api/v1/client/heartbeat", (req, res) => guard(res, () => {
    store.heartbeat(req.body, req.ip || req.socket?.remoteAddress || "");
    res.json({ ok: true });
  }));

  app.post("/api/v1/client/update-log", (req, res) => guard(res, () => {
    store.updateLog(req.body);
    res.json({ ok: true });
  }));

  app.get("/updates/:appId/:channel/d/:deviceId/:fileName", (req, res) => {
    sendPublic(res, store, auth, req, req.params.channel, req.params.deviceId);
  });

  app.get("/updates/:appId/:channel/:fileName", (req, res) => {
    if (!findChannel(req.params.channel)) return res.status(404).end();
    sendPublic(res, store, auth, req, req.params.channel, "");
  });

  app.get("/updates/:appId/:fileName", (req, res) => {
    sendPublic(res, store, auth, req, "stable", "");
  });

  const dist = path.join(repoRoot, "web", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/updates")) return next();
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "没有这个接口。" });
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: "文件超过 4 GB。" });
      return;
    }
    sendError(res, error);
  });

  return app;
}

function normalizeConfig(config) {
  const users = Array.isArray(config.users) && config.users.length
    ? config.users
    : [{ userName: config.adminUser || "admin", password: config.adminPassword || "", role: "admin" }];
  const token = config.token || config.adminPassword || users.find((user) => user.role === "admin")?.password || "";
  return {
    ...config,
    users,
    token,
    usesFactoryPassword: config.usesFactoryPassword ?? (users.some((user) => user.password === "change-me") || token === "change-me"),
  };
}

function uploadsFrom(files) {
  const uploads = [];
  for (const key of ["fullPackage", "deltaPackage", "feed", "setup", "archive", "packages"]) {
    for (const file of files?.[key] ?? []) uploads.push({ path: file.path, originalName: file.originalname });
  }
  return uploads;
}

function sendPublic(res, store, auth, req, channel, deviceId) {
  const found = store.resolvePublic(req.params.appId, channel, req.params.fileName, {
    deviceId: deviceId || req.get("x-device-id") || req.query.deviceId || "",
    ip: normalizeIp(req.ip || req.socket?.remoteAddress || ""),
  }, auth.isAdmin(req));
  if (!found) return res.status(404).end();
  if (found.kind === "file") return res.sendFile(found.path);
  res.set("Cache-Control", "no-cache");
  res.type("json").send(found.body);
}

function reject(res, status = 401) {
  res.status(status).json({ error: status === 403 ? "没有发布权限。" : "需要登录。" });
}

async function guard(res, fn) {
  try {
    await fn();
  } catch (error) {
    sendError(res, error);
  }
}

function sendError(res, error) {
  if (res.headersSent) {
    console.error(error);
    return;
  }
  const known = error instanceof ReleaseError;
  if (!known) console.error(error);
  res.status(known ? 400 : 500).json({ error: known ? error.message : "保存失败。" });
}
