import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { ZipArchive } from "archiver";
import { createApp } from "./app.js";
import { inRollout } from "./feed.js";
import { createStore } from "./store.js";

test("history keeps older versions and rejects a downgrade", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "release-admin-"));
  const store = createStore(dir);
  await store.init();
  try {
    await publishFile(store, dir, "1.0.0", "修复夹线");
    await publishFile(store, dir, "1.0.9", "九");
    await publishFile(store, dir, "1.0.10", "十");

    let page = store.read("single-arm");
    assert.equal(page.versions.find((row) => row.latest).version, "1.0.10");
    assert.equal(page.versions.length, 3);
    assert.ok(page.versions.some((row) => row.version === "1.0.0" && row.displayStatus === "active" && row.notes === "修复夹线"));

    const eleven = await writeZip(dir, "eleven");
    const sha = createHash("sha1").update(await readFile(eleven)).digest("hex").toUpperCase();
    const feedFile = path.join(dir, "feeds", "single-arm", "stable", "releases.win.json");
    const oldSha = JSON.parse(await readFile(feedFile, "utf8")).Assets.find((asset) => asset.Version === "1.0.0").SHA1;
    const feed = await writeText(dir, "incoming.json", JSON.stringify({
      Assets: [
        { PackageId: "single-arm", Version: "1.0.0", Type: "Full", SHA1: "0000000000000000000000000000000000000000", Size: 1, NotesMarkdown: "被篡改" },
        { PackageId: "single-arm", Version: "1.0.11", Type: "Full", FileName: "other.nupkg", SHA1: sha, Size: (await readFile(eleven)).length, NotesMarkdown: "来自清单" },
      ],
    }));
    await store.publish({
      appId: "single-arm",
      version: "1.0.11",
      uploads: [
        { path: eleven, originalName: "single-arm-1.0.11-full.nupkg" },
        { path: feed, originalName: "releases.win.json" },
      ],
    });
    const feedJson = await readFile(feedFile, "utf8");
    assert.match(feedJson, new RegExp(oldSha));
    assert.match(feedJson, /修复夹线/);
    assert.doesNotMatch(feedJson, /被篡改/);
    assert.match(feedJson, /single-arm-1\.0\.11-full\.nupkg/);
    assert.match(feedJson, /来自清单/);

    const badZip = await writeZip(dir, "bad");
    const dateZip = await writeZip(dir, "date");
    const oldZip = await writeZip(dir, "old");
    const badFeed = await writeText(dir, "bad.json", JSON.stringify({
      Assets: [{ PackageId: "single-arm", Version: "9.9.9", Type: "Full", SHA1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", Size: 1 }],
    }));
    await assert.rejects(() => store.publish({
      appId: "single-arm",
      version: "9.9.9",
      uploads: [
        { path: badZip, originalName: "bad.nupkg" },
        { path: badFeed, originalName: "releases.win.json" },
      ],
    }), /SHA1/);
    await assert.rejects(() => store.publish({
      appId: "single-arm",
      version: "20261012.1530",
      uploads: [{ path: dateZip, originalName: "date.nupkg" }],
    }), /1\.2\.3/);
    await assert.rejects(() => store.publish({
      appId: "single-arm",
      version: "1.0.9",
      uploads: [{ path: oldZip, originalName: "old.nupkg" }],
    }), /版本不能倒退/);

    await store.unpublish("single-arm", "stable", "1.0.11");
    page = store.read("single-arm");
    assert.equal(page.versions.find((row) => row.version === "1.0.11").displayStatus, "deprecated");
    assert.equal(page.versions.find((row) => row.latest).version, "1.0.10");
    assert.equal(page.versions.length, 4);
    assert.equal(store.resolvePublic("single-arm", "stable", "single-arm-1.0.11-full.nupkg"), null);
    assert.equal((await readFile(path.join(dir, "feeds", "single-arm", "stable", "single-arm-1.0.11-full.nupkg"))).length > 0, true);
    assert.doesNotMatch(await readFile(feedFile, "utf8"), /1\.0\.11/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("channels, draft whitelist, rollout and heartbeat", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "release-admin-"));
  const store = createStore(dir);
  await store.init();
  try {
    const packed = await writeZip(dir, "beta");
    const archive = await zipFiles(dir, "beta.zip", {
      "single-arm-2.0.0-full.nupkg": await readFile(packed),
    });
    await store.publish({
      appId: "single-arm",
      channel: "beta",
      status: "draft",
      devices: ["pilot-1"],
      uploads: [{ path: archive, originalName: "beta.zip" }],
    });
    const stable = store.resolvePublic("single-arm", "stable", "releases.win.json").body;
    const hidden = store.resolvePublic("single-arm", "beta", "releases.win.json").body;
    const visible = store.resolvePublic("single-arm", "beta", "releases.win.json", { deviceId: "pilot-1", ip: "" }).body;
    assert.doesNotMatch(stable, /2\.0\.0/);
    assert.doesNotMatch(hidden, /2\.0\.0/);
    assert.match(visible, /2\.0\.0/);

    await store.activate("single-arm", "beta", "2.0.0");
    await store.setRollout("single-arm", "beta", "2.0.0", 0, ["pilot-1"], ["10.0.0.8"]);
    assert.doesNotMatch(store.resolvePublic("single-arm", "beta", "releases.win.json").body, /2\.0\.0/);
    assert.match(store.resolvePublic("single-arm", "beta", "releases.win.json", { deviceId: "", ip: "10.0.0.8" }).body, /2\.0\.0/);
    assert.equal(store.resolvePublic("single-arm", "beta", "single-arm-2.0.0-full.nupkg", { deviceId: "other", ip: "" }), null);

    let inside = "";
    let outside = "";
    for (let i = 0; i < 400 && (!inside || !outside); i += 1) {
      const id = `dev-${i}`;
      if (inRollout(id, 50)) inside = id;
      else outside = id;
    }
    await store.setRollout("single-arm", "beta", "2.0.0", 50, [], []);
    assert.match(store.resolvePublic("single-arm", "beta", "releases.win.json", { deviceId: inside, ip: "" }).body, /2\.0\.0/);
    assert.doesNotMatch(store.resolvePublic("single-arm", "beta", "releases.win.json", { deviceId: outside, ip: "" }).body, /2\.0\.0/);

    store.setPolicy("single-arm", "beta", "1.2.0");
    assert.match(store.resolvePublic("single-arm", "beta", "policy.json").body, /"minSupportedVersion": "1.2.0"/);

    store.heartbeat({
      appId: "single-arm", deviceId: "pc-01", machineName: "一线", version: "2.0.0", os: "Windows", group: "A", channel: "beta",
    }, "::ffff:10.0.0.8");
    store.updateLog({ appId: "single-arm", deviceId: "pc-01", event: "Failed", version: "2.0.0", message: "磁盘满了" });
    const board = store.dashboard("single-arm");
    assert.equal(board.deviceTotal, 1);
    assert.equal(board.deviceOnline, 1);
    assert.equal(board.failureTotal, 1);
    assert.equal(board.recentFailures[0].message, "磁盘满了");
    assert.equal(store.devices("single-arm")[0].ip, "10.0.0.8");
    assert.equal(store.devices("single-arm")[0].lastEvent, "Failed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("http login, roles and anonymous download", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "release-admin-http-"));
  const app = await createApp({
    dataRoot: dir,
    token: "ci-token",
    usesFactoryPassword: false,
    users: [
      { userName: "admin", password: "test-pass", role: "admin" },
      { userName: "operator", password: "op-pass", role: "operator" },
    ],
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const feed = await fetch(`${base}/updates/single-arm/stable/releases.win.json`);
    assert.equal(feed.status, 200);
    assert.match(await feed.text(), /"Assets": \[\]/);
    assert.equal((await fetch(`${base}/api/apps`)).status, 401);

    const operator = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userName: "operator", password: "op-pass" }),
    });
    const operatorCookie = operator.headers.getSetCookie()[0].split(";")[0];
    const denied = await fetch(`${base}/api/apps/single-arm/versions`, {
      method: "POST",
      headers: { cookie: operatorCookie },
      body: new FormData(),
    });
    assert.equal(denied.status, 403);

    const full = await writeZip(dir, "http");
    const body = new FormData();
    body.set("version", "1.2.0");
    body.set("notes", "页面能看见");
    body.set("channel", "stable");
    body.set("fullPackage", new Blob([await readFile(full)]), "single-arm-1.2.0-full.nupkg");
    const published = await fetch(`${base}/api/apps/single-arm/versions`, {
      method: "POST",
      headers: { authorization: "Bearer ci-token" },
      body,
    });
    assert.equal(published.status, 200, await published.clone().text());

    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userName: "admin", password: "test-pass" }),
    });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    const history = await fetch(`${base}/api/apps/single-arm`, { headers: { cookie } });
    const json = await history.json();
    assert.equal(json.versions.length, 1);
    assert.equal(json.versions[0].version, "1.2.0");
    assert.equal(json.versions[0].latest, true);
    assert.equal(json.versions[0].notes, "页面能看见");
    assert.equal((await fetch(`${base}/updates/single-arm/releases.win.json`)).status, 200);
    assert.match(await (await fetch(`${base}/updates/single-arm/stable/releases.win.json`)).text(), /页面能看见/);
    assert.equal((await fetch(`${base}/updates/single-arm/single-arm-1.2.0-full.nupkg`)).status, 200);
    const exported = await fetch(`${base}/api/apps/single-arm/versions/stable/1.2.0/export`, { headers: { cookie: operatorCookie } });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type"), /zip/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    app.locals.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function publishFile(store, dir, version, notes) {
  await store.publish({
    appId: "single-arm",
    version,
    notes,
    uploads: [{ path: await writeZip(dir, version), originalName: `single-arm-${version}-full.nupkg` }],
  });
}

async function writeZip(dir, text) {
  const file = path.join(dir, `${text}.nupkg`);
  await writeFile(file, zip(String(text)));
  return file;
}

async function writeText(dir, name, text) {
  const file = path.join(dir, name);
  await writeFile(file, text);
  return file;
}

function zipFiles(dir, name, files) {
  const target = path.join(dir, name);
  return new Promise((resolve, reject) => {
    const output = createWriteStream(target);
    const archive = new ZipArchive({ zlib: { level: 0 } });
    output.on("close", () => resolve(target));
    archive.on("error", reject);
    archive.pipe(output);
    for (const [entry, content] of Object.entries(files)) archive.append(content, { name: entry });
    archive.finalize();
  });
}

function zip(text) {
  const name = Buffer.from("readme.txt");
  const data = Buffer.from(text);
  const compressed = deflateRawSync(data);
  const local = Buffer.alloc(30 + name.length + compressed.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  compressed.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ~crc >>> 0;
}
