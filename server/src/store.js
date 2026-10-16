import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { APPS, CHANNELS, findApp, findChannel } from "./catalog.js";
import { ReleaseError } from "./errors.js";
import {
  FEED_NAME,
  POLICY_NAME,
  buildAssets,
  inRollout,
  inspectPackage,
  isPublicName,
  normalizeIp,
  packageName,
  parseFeed,
  parseNupkgName,
  serializeFeed,
  setupName,
} from "./feed.js";
import { compareVersions, isVersion } from "./versions.js";
import { extractZip } from "./zip.js";

const ONLINE_MS = 5 * 60 * 1000;
const EVENTS = new Set(["UpdateStarted", "DownloadProgress", "AppliedSuccess", "Failed"]);

export { FEED_NAME, inRollout, normalizeIp, ReleaseError };

export function createStore(dataRoot) {
  const root = path.resolve(dataRoot);
  const gates = new Map();
  let db;

  async function init() {
    await mkdir(path.join(root, "tmp"), { recursive: true });
    for (const app of APPS) {
      for (const channel of CHANNELS) await mkdir(channelDir(app.id, channel.id), { recursive: true });
    }
    if (db) return;
    db = new DatabaseSync(path.join(root, "admin.db"));
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS releases (
        app_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        notes_markdown TEXT NOT NULL DEFAULT '',
        notes_html TEXT NOT NULL DEFAULT '',
        full_file TEXT NOT NULL,
        full_size INTEGER NOT NULL,
        sha1 TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        delta_file TEXT,
        delta_size INTEGER,
        delta_sha1 TEXT,
        delta_sha256 TEXT,
        setup_file TEXT,
        rollout_percent INTEGER NOT NULL DEFAULT 100,
        published_at TEXT NOT NULL,
        withdrawn_at TEXT,
        PRIMARY KEY (app_id, channel, version)
      );
      CREATE TABLE IF NOT EXISTS release_rules (
        app_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        version TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (app_id, channel, version, kind, value)
      );
      CREATE TABLE IF NOT EXISTS policies (
        app_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        min_supported_version TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (app_id, channel)
      );
      CREATE TABLE IF NOT EXISTS devices (
        app_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        machine_name TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        group_name TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL DEFAULT '',
        last_seen TEXT NOT NULL,
        last_event TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (app_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS update_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        event TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        progress INTEGER,
        created_at TEXT NOT NULL
      );
    `);
  }

  function close() {
    if (!db) return;
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    } catch {
      // The test cleanup still removes the directory if the handle is already gone.
    }
    db = null;
  }

  function list() {
    const rows = db.prepare("SELECT * FROM releases").all();
    return APPS.map((app) => {
      const own = rows.filter((row) => row.app_id === app.id);
      const latest = publicLatest(own, "stable");
      return {
        ...app,
        latestVersion: latest?.version ?? "",
        notes: latest?.notes_markdown ?? "",
        fullSize: latest?.full_size ?? null,
        publishedAt: latest?.published_at ?? null,
        historyCount: own.length,
        activeCount: own.filter((row) => row.status === "active").length,
        withdrawnCount: own.filter((row) => row.status === "deprecated").length,
      };
    });
  }

  function read(appId) {
    const app = findApp(appId);
    if (!app) return null;
    const rows = db.prepare("SELECT * FROM releases WHERE app_id = ?").all(app.id);
    const rules = db.prepare("SELECT * FROM release_rules WHERE app_id = ?").all(app.id);
    const latestByChannel = Object.fromEntries(CHANNELS.map((channel) => [channel.id, publicLatest(rows, channel.id)?.version ?? ""]));
    return {
      app,
      channels: CHANNELS,
      paths: Object.fromEntries(CHANNELS.map((channel) => [channel.id, {
        updatePath: `/updates/${app.id}/${channel.id}/`,
        devicePath: `/updates/${app.id}/${channel.id}/d/{设备ID}/`,
        feedPath: `/updates/${app.id}/${channel.id}/${FEED_NAME}`,
      }])),
      stableAlias: `/updates/${app.id}/`,
      versions: rows.map((row) => toVersion(row, rules, latestByChannel[row.channel])).sort(byRecent),
    };
  }

  function dashboard(appId = "") {
    const filter = optionalApp(appId);
    const devices = deviceRows(filter);
    const online = devices.filter((device) => isOnline(device.lastSeen)).length;
    const shares = new Map();
    for (const device of devices) {
      const key = device.version || "未知";
      shares.set(key, (shares.get(key) ?? 0) + 1);
    }
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 6);
    const events = db.prepare(`
      SELECT created_at FROM update_events
      WHERE event = 'Failed' AND created_at >= ? AND (? = '' OR app_id = ?)
    `).all(since.toISOString(), filter, filter);
    const days = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const day = new Date(since);
      day.setDate(since.getDate() + offset);
      days.push({ date: dayKey(day), count: 0 });
    }
    for (const event of events) {
      const key = dayKey(new Date(event.created_at));
      const bucket = days.find((day) => day.date === key);
      if (bucket) bucket.count += 1;
    }
    const recentFailures = db.prepare(`
      SELECT e.*, d.machine_name, d.ip
      FROM update_events e
      LEFT JOIN devices d ON d.app_id = e.app_id AND d.device_id = e.device_id
      WHERE e.event = 'Failed' AND (? = '' OR e.app_id = ?)
      ORDER BY e.id DESC LIMIT 8
    `).all(filter, filter).map(toEvent);
    return {
      deviceTotal: devices.length,
      deviceOnline: online,
      failureTotal: days.reduce((sum, day) => sum + day.count, 0),
      versionShares: [...shares.entries()].map(([version, count]) => ({ version, count })),
      failures: days,
      recentFailures,
    };
  }

  function devices(appId = "") {
    return deviceRows(optionalApp(appId));
  }

  function events(appId, deviceId) {
    const app = requireApp(appId);
    const id = cleanId(deviceId, "设备 ID");
    return db.prepare(`
      SELECT * FROM update_events WHERE app_id = ? AND device_id = ? ORDER BY id DESC LIMIT 50
    `).all(app.id, id).map(toEvent);
  }

  function policies() {
    const saved = db.prepare("SELECT * FROM policies").all();
    return APPS.flatMap((app) => CHANNELS.map((channel) => ({
      appId: app.id,
      appName: app.name,
      channel: channel.id,
      channelName: channel.name,
      minSupportedVersion: saved.find((row) => row.app_id === app.id && row.channel === channel.id)?.min_supported_version || "",
    })));
  }

  function setPolicy(appId, channel, minSupportedVersion) {
    const app = requireApp(appId);
    const selected = requireChannel(channel);
    const min = String(minSupportedVersion ?? "").trim();
    if (min && !isVersion(min)) throw new ReleaseError("最低兼容版本请使用 1.2.3 这种形式。");
    db.prepare(`
      INSERT INTO policies (app_id, channel, min_supported_version) VALUES (?, ?, ?)
      ON CONFLICT(app_id, channel) DO UPDATE SET min_supported_version = excluded.min_supported_version
    `).run(app.id, selected.id, min);
    writePolicyFile(app.id, selected.id);
  }

  function setRollout(appId, channel, version, rolloutPercent, devices, ips) {
    const app = requireApp(appId);
    const selected = requireChannel(channel);
    if (!isVersion(version)) throw new ReleaseError("版本号无效。");
    const percent = clampPercent(rolloutPercent, null);
    if (percent == null) throw new ReleaseError("灰度比例请填写 0 到 100 的整数。");
    return withSyncLock(`${app.id}:${selected.id}`, () => {
      const row = getRelease(app.id, selected.id, version);
      if (!row) throw new ReleaseError("没有这个版本。");
      if (row.status === "deprecated") throw new ReleaseError("已下线的版本不能调整灰度。");
      const deviceList = devices == null ? currentDevices(app.id, selected.id, version) : cleanList(devices);
      const ipList = (ips == null ? currentIps(app.id, selected.id, version) : cleanList(ips)).map(normalizeIp);
      transaction(() => {
        db.prepare("UPDATE releases SET rollout_percent = ? WHERE app_id = ? AND channel = ? AND version = ?")
          .run(percent, app.id, selected.id, version);
        replaceRules(app.id, selected.id, version, deviceList, ipList);
      });
      refreshFeed(app.id, selected.id);
    });
  }

  async function publish(input) {
    const app = requireApp(input.appId);
    const selected = requireChannel(input.channel || "stable");
    const noteText = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : null;
    if (noteText && noteText.length > 8000) throw new ReleaseError("更新说明请控制在 8000 字以内。");
    const status = input.status === "draft" ? "draft" : "active";
    const staging = await mkdtemp(path.join(tmpdir(), "release-upload-"));
    try {
      const gathered = await gather(input.uploads, staging);
      const picked = pickReleaseFiles(app, input.version, gathered);
      const full = await inspectPackage(picked.full.path, "全量包");
      const delta = picked.delta ? await inspectPackage(picked.delta.path, "差分包") : null;
      let incoming = [];
      if (picked.feed) {
        const json = await readFile(picked.feed.path, "utf8");
        if (json.length > 2_000_000) throw new ReleaseError("上传的清单过大。");
        incoming = parseFeed(json);
      }
      const fullName = packageName(app, picked.version, "full");
      const deltaName = delta ? packageName(app, picked.version, "delta") : null;
      const produced = buildAssets(app, picked.version, noteText, full, fullName, delta, deltaName, incoming);
      const fullAsset = produced.find((asset) => asset.Type === "Full");
      const deltaAsset = produced.find((asset) => asset.Type === "Delta") ?? null;
      const deviceList = cleanList(input.devices);
      const ipList = cleanList(input.ips);
      await withLock(`${app.id}:${selected.id}`, async () => {
        assertNotDowngrade(app.id, selected.id, picked.version);
        const current = getRelease(app.id, selected.id, picked.version);
        const percent = clampPercent(input.rolloutPercent, current?.rollout_percent ?? 100);
        const dir = channelDir(app.id, selected.id);
        await moveIntoPlace(picked.full.path, path.join(dir, fullName));
        if (delta && deltaName) await moveIntoPlace(picked.delta.path, path.join(dir, deltaName));
        const setupFile = picked.setup ? setupName(app, picked.version) : null;
        if (picked.setup && setupFile) await moveIntoPlace(picked.setup.path, path.join(dir, setupFile));
        transaction(() => {
          db.prepare(`
            INSERT INTO releases (
              app_id, channel, version, status, notes_markdown, notes_html,
              full_file, full_size, sha1, sha256,
              delta_file, delta_size, delta_sha1, delta_sha256,
              setup_file, rollout_percent, published_at, withdrawn_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(app_id, channel, version) DO UPDATE SET
              status = excluded.status,
              notes_markdown = CASE WHEN excluded.notes_markdown = '' THEN releases.notes_markdown ELSE excluded.notes_markdown END,
              notes_html = CASE WHEN excluded.notes_markdown = '' THEN releases.notes_html ELSE excluded.notes_html END,
              full_file = excluded.full_file,
              full_size = excluded.full_size,
              sha1 = excluded.sha1,
              sha256 = excluded.sha256,
              delta_file = COALESCE(excluded.delta_file, releases.delta_file),
              delta_size = COALESCE(excluded.delta_size, releases.delta_size),
              delta_sha1 = COALESCE(excluded.delta_sha1, releases.delta_sha1),
              delta_sha256 = COALESCE(excluded.delta_sha256, releases.delta_sha256),
              setup_file = COALESCE(excluded.setup_file, releases.setup_file),
              rollout_percent = excluded.rollout_percent,
              published_at = excluded.published_at,
              withdrawn_at = NULL
          `).run(
            app.id, selected.id, picked.version, status,
            fullAsset.NotesMarkdown, fullAsset.NotesHtml,
            fullName, full.size, full.sha1, full.sha256,
            deltaName, delta?.size ?? null, delta?.sha1 ?? null, delta?.sha256 ?? null,
            setupFile, percent, new Date().toISOString(),
          );
          if (deviceList || ipList) {
            replaceRules(app.id, selected.id, picked.version, deviceList ?? currentDevices(app.id, selected.id, picked.version), (ipList ?? currentIps(app.id, selected.id, picked.version)).map(normalizeIp));
          }
        });
        refreshFeed(app.id, selected.id);
        console.log(`已发布 ${app.id} ${selected.id} ${picked.version}，全量 ${full.size} 字节`);
      });
      return { appId: app.id, channel: selected.id, version: picked.version };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async function activate(appId, channel, version) {
    await changeStatus(appId, channel, version, "active");
  }

  async function unpublish(appId, channel, version) {
    await changeStatus(appId, channel, version, "deprecated");
  }

  function resolvePublic(appId, channel, fileName, identity = emptyIdentity(), privileged = false) {
    const app = findApp(appId);
    const selected = findChannel(channel);
    if (!app || !selected || !isPublicName(fileName)) return null;
    const who = { deviceId: String(identity.deviceId || "").trim(), ip: normalizeIp(identity.ip) };
    if (fileName === FEED_NAME) {
      return { kind: "json", body: serializeFeed(feedAssets(app, selected.id, who, privileged)) };
    }
    if (fileName === POLICY_NAME) {
      return { kind: "json", body: policyBody(app.id, selected.id) };
    }
    const row = findByFile(app.id, selected.id, fileName);
    if (!row || !include(row, who, privileged)) return null;
    const filePath = path.join(channelDir(app.id, selected.id), fileName);
    return existsSync(filePath) ? { kind: "file", path: filePath } : null;
  }

  function exportPack(appId, channel, version) {
    const app = requireApp(appId);
    const selected = requireChannel(channel);
    if (!isVersion(version)) throw new ReleaseError("版本号无效。");
    const row = getRelease(app.id, selected.id, version);
    if (!row) throw new ReleaseError("没有这个版本。");
    const dir = channelDir(app.id, selected.id);
    const fullPath = path.join(dir, row.full_file);
    if (!existsSync(fullPath)) throw new ReleaseError("全量包已不在磁盘上。");
    const entries = [
      { name: row.full_file, path: fullPath },
      { name: FEED_NAME, content: serializeFeed(assetsFromRow(app, row)) },
      { name: POLICY_NAME, content: policyBody(app.id, selected.id) },
      { name: "更新说明.md", content: row.notes_markdown || "" },
    ];
    if (row.delta_file && existsSync(path.join(dir, row.delta_file))) entries.push({ name: row.delta_file, path: path.join(dir, row.delta_file) });
    if (row.setup_file && existsSync(path.join(dir, row.setup_file))) entries.push({ name: row.setup_file, path: path.join(dir, row.setup_file) });
    return { fileName: `${app.id}-${selected.id}-${row.version}-offline.zip`, entries };
  }

  function heartbeat(body, ip) {
    const app = requireApp(body?.appId);
    const deviceId = cleanId(body?.deviceId, "设备 ID");
    const channel = body?.channel ? requireChannel(body.channel).id : "";
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO devices (
        app_id, device_id, machine_name, version, os, ip, group_name, channel, last_seen, last_event, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')
      ON CONFLICT(app_id, device_id) DO UPDATE SET
        machine_name = CASE WHEN excluded.machine_name = '' THEN devices.machine_name ELSE excluded.machine_name END,
        version = CASE WHEN excluded.version = '' THEN devices.version ELSE excluded.version END,
        os = CASE WHEN excluded.os = '' THEN devices.os ELSE excluded.os END,
        ip = CASE WHEN excluded.ip = '' THEN devices.ip ELSE excluded.ip END,
        group_name = CASE WHEN excluded.group_name = '' THEN devices.group_name ELSE excluded.group_name END,
        channel = CASE WHEN excluded.channel = '' THEN devices.channel ELSE excluded.channel END,
        last_seen = excluded.last_seen
    `).run(
      app.id, deviceId, clip(body?.machineName, 120), clip(body?.version, 40), clip(body?.os, 120),
      normalizeIp(body?.ip) || normalizeIp(ip), clip(body?.group, 80), channel, now,
    );
  }

  function updateLog(body) {
    const app = requireApp(body?.appId);
    const deviceId = cleanId(body?.deviceId, "设备 ID");
    const event = String(body?.event || "");
    if (!EVENTS.has(event)) throw new ReleaseError("未知的更新事件。");
    const version = clip(body?.version, 40);
    const message = clip(body?.message, 4000);
    const progress = body?.progress == null || body.progress === "" ? null : Number(body.progress);
    if (progress != null && (!Number.isFinite(progress) || progress < 0 || progress > 100)) {
      throw new ReleaseError("下载进度请填写 0 到 100。");
    }
    const now = new Date().toISOString();
    transaction(() => {
      db.prepare(`
        INSERT INTO update_events (app_id, device_id, event, version, message, progress, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(app.id, deviceId, event, version, message, progress == null ? null : Math.round(progress), now);
      db.prepare(`
        INSERT INTO devices (app_id, device_id, machine_name, version, os, ip, group_name, channel, last_seen, last_event, last_error)
        VALUES (?, ?, '', ?, '', '', '', '', ?, ?, ?)
        ON CONFLICT(app_id, device_id) DO UPDATE SET
          version = CASE WHEN excluded.version = '' THEN devices.version ELSE excluded.version END,
          last_seen = excluded.last_seen,
          last_event = excluded.last_event,
          last_error = excluded.last_error
      `).run(app.id, deviceId, version, now, event, event === "Failed" ? message : "");
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("DELETE FROM update_events WHERE created_at < ?").run(cutoff);
    });
    if (event === "Failed") console.log(`更新失败 ${app.id} ${deviceId} ${version} ${message}`);
  }

  async function changeStatus(appId, channel, version, status) {
    const app = requireApp(appId);
    const selected = requireChannel(channel);
    if (!isVersion(version)) throw new ReleaseError("版本号无效。");
    await withLock(`${app.id}:${selected.id}`, async () => {
      const row = getRelease(app.id, selected.id, version);
      if (!row) throw new ReleaseError("没有这个版本。");
      if (status === "deprecated" && row.status === "deprecated") throw new ReleaseError("这个版本已经下线。");
      if (status === "active" && row.status === "active" && row.rollout_percent >= 100) throw new ReleaseError("这个版本已经发布。");
      const withdrawnAt = status === "deprecated" ? new Date().toISOString() : null;
      db.prepare("UPDATE releases SET status = ?, withdrawn_at = ? WHERE app_id = ? AND channel = ? AND version = ?")
        .run(status, withdrawnAt, app.id, selected.id, version);
      refreshFeed(app.id, selected.id);
      console.log(status === "deprecated" ? `已下线 ${app.id} ${selected.id} ${version}` : `已发布 ${app.id} ${selected.id} ${version}`);
    });
  }

  function feedAssets(app, channel, identity, privileged) {
    return loadChannel(app.id, channel)
      .filter((row) => include(row, identity, privileged))
      .flatMap((row) => assetsFromRow(app, row));
  }

  function loadChannel(appId, channel) {
    const rows = db.prepare("SELECT * FROM releases WHERE app_id = ? AND channel = ?").all(appId, channel);
    const rules = db.prepare("SELECT * FROM release_rules WHERE app_id = ? AND channel = ?").all(appId, channel);
    return rows.map((row) => attachRules(row, rules));
  }

  function findByFile(appId, channel, fileName) {
    return loadChannel(appId, channel).find((row) => row.full_file === fileName || row.delta_file === fileName || row.setup_file === fileName) ?? null;
  }

  function refreshFeed(appId, channel) {
    const app = findApp(appId);
    const body = serializeFeed(feedAssets(app, channel, emptyIdentity(), false));
    writeText(path.join(channelDir(appId, channel), FEED_NAME), body);
    writePolicyFile(appId, channel);
  }

  function writePolicyFile(appId, channel) {
    writeText(path.join(channelDir(appId, channel), POLICY_NAME), policyBody(appId, channel));
  }

  function policyBody(appId, channel) {
    const row = db.prepare("SELECT min_supported_version FROM policies WHERE app_id = ? AND channel = ?").get(appId, channel);
    return `${JSON.stringify({ appId, channel, minSupportedVersion: row?.min_supported_version || "" }, null, 2)}\n`;
  }

  function assertNotDowngrade(appId, channel, version) {
    const rows = db.prepare("SELECT version FROM releases WHERE app_id = ? AND channel = ?").all(appId, channel);
    let highest = null;
    for (const row of rows) {
      if (!highest || compareVersions(row.version, highest) > 0) highest = row.version;
    }
    if (highest && compareVersions(version, highest) < 0) {
      const name = findChannel(channel)?.name || channel;
      throw new ReleaseError(`版本不能倒退。${name}通道当前最高是 ${highest}。`);
    }
  }

  function getRelease(appId, channel, version) {
    return db.prepare("SELECT * FROM releases WHERE app_id = ? AND channel = ? AND version = ?").get(appId, channel, version) ?? null;
  }

  function replaceRules(appId, channel, version, devices, ips) {
    db.prepare("DELETE FROM release_rules WHERE app_id = ? AND channel = ? AND version = ?").run(appId, channel, version);
    const insert = db.prepare("INSERT INTO release_rules (app_id, channel, version, kind, value) VALUES (?, ?, ?, ?, ?)");
    for (const value of devices) insert.run(appId, channel, version, "device", value);
    for (const value of ips) insert.run(appId, channel, version, "ip", normalizeIp(value));
  }

  function currentDevices(appId, channel, version) {
    return db.prepare("SELECT value FROM release_rules WHERE app_id = ? AND channel = ? AND version = ? AND kind = 'device'")
      .all(appId, channel, version).map((row) => row.value);
  }

  function currentIps(appId, channel, version) {
    return db.prepare("SELECT value FROM release_rules WHERE app_id = ? AND channel = ? AND version = ? AND kind = 'ip'")
      .all(appId, channel, version).map((row) => row.value);
  }

  function transaction(fn) {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already closed by the failed statement */ }
      throw error;
    }
  }

  function deviceRows(appId) {
    return db.prepare(`
      SELECT * FROM devices WHERE (? = '' OR app_id = ?) ORDER BY last_seen DESC
    `).all(appId, appId).map((row) => ({
      appId: row.app_id,
      appName: findApp(row.app_id)?.name || row.app_id,
      deviceId: row.device_id,
      machineName: row.machine_name,
      version: row.version,
      os: row.os,
      ip: row.ip,
      group: row.group_name,
      channel: row.channel,
      lastSeen: row.last_seen,
      online: isOnline(row.last_seen),
      lastEvent: row.last_event,
      lastError: row.last_error,
    }));
  }

  function toVersion(row, rules, latest) {
    const attached = attachRules(row, rules);
    const displayStatus = row.status === "deprecated" ? "deprecated" : row.status === "draft" ? "draft" : row.rollout_percent < 100 ? "gray" : "active";
    return {
      channel: row.channel,
      version: row.version,
      status: row.status,
      displayStatus,
      latest: Boolean(latest) && row.version === latest && displayStatus === "active",
      notes: row.notes_markdown,
      notesHtml: row.notes_html,
      fullSize: row.full_size,
      deltaSize: row.delta_size,
      sha1: row.sha1,
      sha256: row.sha256,
      publishedAt: row.published_at,
      withdrawnAt: row.withdrawn_at,
      rolloutPercent: row.rollout_percent,
      fullFileName: row.full_file,
      deltaFileName: row.delta_file,
      setupFileName: row.setup_file,
      fileKept: existsSync(path.join(channelDir(row.app_id, row.channel), row.full_file)),
      whitelistDevices: attached.devices,
      whitelistIps: attached.ips,
    };
  }

  function channelDir(appId, channel) {
    return path.join(root, "feeds", appId, channel);
  }

  function withLock(id, fn) {
    const previous = gates.get(id) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    gates.set(id, run.then(() => {}, () => {}));
    return run;
  }

  function withSyncLock(id, fn) {
    const previous = gates.get(id) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    gates.set(id, previous.catch(() => {}).then(() => gate));
    return previous.catch(() => {}).then(() => {
      try { return fn(); } finally { release(); }
    });
  }

  return {
    init, close, list, read, dashboard, devices, events, policies, setPolicy, setRollout,
    publish, activate, unpublish, resolvePublic, exportPack, heartbeat, updateLog,
    root, tempDir: path.join(root, "tmp"),
  };
}

function attachRules(row, rules) {
  const own = rules.filter((rule) => rule.app_id === row.app_id && rule.channel === row.channel && rule.version === row.version);
  return {
    ...row,
    devices: own.filter((rule) => rule.kind === "device").map((rule) => rule.value),
    ips: own.filter((rule) => rule.kind === "ip").map((rule) => rule.value),
  };
}

function include(row, identity, privileged) {
  if (row.status === "deprecated") return false;
  if (privileged) return true;
  if (row.status === "draft") return whitelisted(row, identity);
  if (row.status !== "active") return false;
  if (row.rollout_percent >= 100) return true;
  return whitelisted(row, identity) || inRollout(identity.deviceId, row.rollout_percent);
}

function whitelisted(row, identity) {
  if (identity.deviceId && row.devices?.includes(identity.deviceId)) return true;
  return Boolean(identity.ip && row.ips?.includes(identity.ip));
}

function assetsFromRow(app, row) {
  const full = {
    PackageId: app.packId,
    Version: row.version,
    Type: "Full",
    FileName: row.full_file,
    Sha1: row.sha1,
    Sha256: row.sha256,
    Size: row.full_size,
    NotesMarkdown: row.notes_markdown,
    NotesHtml: row.notes_html,
  };
  if (!row.delta_file) return [full];
  return [full, {
    ...full,
    Type: "Delta",
    FileName: row.delta_file,
    Sha1: row.delta_sha1 || "",
    Sha256: row.delta_sha256 || "",
    Size: row.delta_size || 0,
  }];
}

function publicLatest(rows, channel) {
  let open = null;
  let gray = null;
  for (const row of rows) {
    if (row.channel !== channel || row.status !== "active") continue;
    if (row.rollout_percent >= 100) {
      if (!open || compareVersions(row.version, open.version) > 0) open = row;
    } else if (!gray || compareVersions(row.version, gray.version) > 0) gray = row;
  }
  return open || gray;
}

function byRecent(left, right) {
  const leftTime = Date.parse(left.publishedAt || left.withdrawnAt || 0);
  const rightTime = Date.parse(right.publishedAt || right.withdrawnAt || 0);
  if (rightTime !== leftTime) return rightTime - leftTime;
  return compareVersions(right.version, left.version);
}

function optionalApp(appId) {
  if (!appId) return "";
  return requireApp(appId).id;
}

function requireApp(appId) {
  const app = findApp(appId);
  if (!app) throw new ReleaseError("未知程序。");
  return app;
}

function requireChannel(channel) {
  const selected = findChannel(channel);
  if (!selected) throw new ReleaseError("未知通道。请使用 stable、beta 或 canary。");
  return selected;
}

function emptyIdentity() {
  return { deviceId: "", ip: "" };
}

function isOnline(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) && Date.now() - time <= ONLINE_MS;
}

function dayKey(date) {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function toEvent(row) {
  return {
    id: row.id,
    appId: row.app_id,
    deviceId: row.device_id,
    machineName: row.machine_name || "",
    ip: row.ip || "",
    event: row.event,
    version: row.version,
    message: row.message,
    progress: row.progress,
    createdAt: row.created_at,
  };
}

function cleanId(value, label) {
  const text = String(value || "").trim();
  if (!text || text.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(text)) throw new ReleaseError(`${label}格式不正确。`);
  return text;
}

function clip(value, max) {
  return String(value || "").trim().slice(0, max);
}

function clampPercent(value, fallback) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100) throw new ReleaseError("灰度比例请填写 0 到 100 的整数。");
  return number;
}

function cleanList(value) {
  if (value == null) return null;
  const source = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  const items = [];
  for (const item of source) {
    const text = String(item).trim();
    if (!text) continue;
    if (text.length > 80 || !/^[A-Za-z0-9.:_-]+$/.test(text)) throw new ReleaseError(`白名单格式不正确：${text}`);
    if (!items.includes(text)) items.push(text);
  }
  if (items.length > 200) throw new ReleaseError("白名单最多 200 条。");
  return items;
}

async function gather(uploads, staging) {
  const files = [];
  for (const upload of uploads ?? []) {
    if (!upload?.path) continue;
    const name = path.basename(upload.originalName || upload.path);
    if (name.toLowerCase().endsWith(".zip")) files.push(...await extractZip(upload.path, staging));
    else files.push({ path: upload.path, name });
  }
  if (files.length === 0) throw new ReleaseError("请上传全量包或包含发布文件的 zip。");
  return files;
}

function pickReleaseFiles(app, requestedVersion, files) {
  const jsons = files.filter((file) => file.name.toLowerCase().endsWith(".json"));
  const exes = files.filter((file) => file.name.toLowerCase().endsWith(".exe"));
  const packs = files.filter((file) => file.name.toLowerCase().endsWith(".nupkg"));
  const unknown = files.find((file) => !jsons.includes(file) && !exes.includes(file) && !packs.includes(file));
  if (unknown) throw new ReleaseError(`不支持的文件：${unknown.name}`);
  const versionText = typeof requestedVersion === "string" ? requestedVersion.trim() : "";
  if (versionText && !isVersion(versionText)) throw new ReleaseError("版本号请使用 1.2.3 这种形式。");
  const parsed = packs.map((file) => ({ ...file, meta: parseNupkgName(file.name) }));
  let version = versionText;
  if (!version) {
    version = parsed.map((file) => file.meta?.version).filter(isVersion).sort((left, right) => compareVersions(right, left))[0] || "";
  }
  if (!version) throw new ReleaseError("版本号请使用 1.2.3 这种形式。");
  const fulls = parsed.filter((file) => {
    if (file.meta?.kind === "delta") return false;
    if (file.meta?.version && file.meta.version !== version) return false;
    if (file.meta?.id && file.meta.id !== app.packId) return false;
    return file.meta?.kind === "full" || !file.meta;
  });
  if (fulls.length !== 1) {
    throw new ReleaseError(fulls.length === 0 ? "请上传全量包（.nupkg）。" : "有多个全量包，请填写要发布的版本号。");
  }
  const deltas = parsed.filter((file) => file.meta?.kind === "delta" && (!file.meta.version || file.meta.version === version) && (!file.meta.id || file.meta.id === app.packId));
  if (deltas.length > 1) throw new ReleaseError("差分包只能有一个。");
  return {
    version,
    full: fulls[0],
    delta: deltas[0] ?? null,
    feed: jsons.find((file) => file.name.toLowerCase() === FEED_NAME) ?? jsons[0] ?? null,
    setup: exes.find((file) => /setup/i.test(file.name)) ?? exes[0] ?? null,
  };
}

async function moveIntoPlace(source, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(dest, { force: true });
  try {
    await rename(source, dest);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    const { copyFile } = await import("node:fs/promises");
    await copyFile(source, dest);
    await rm(source, { force: true });
  }
}

function writeText(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(temp, content);
  rmSync(file, { force: true });
  renameSync(temp, file);
}
