import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = path.resolve(serverDir, "..");

export function loadConfig(overrides = {}) {
  const file = JSON.parse(readFileSync(path.join(serverDir, "config.json"), "utf8"));
  const dataRoot = process.env.DATA_ROOT || overrides.dataRoot || file.dataRoot || "data";
  let users = overrides.users || file.users;
  if (!Array.isArray(users) || users.length === 0) {
    users = [{
      userName: process.env.ADMIN_USER || overrides.adminUser || file.adminUser || "admin",
      password: process.env.ADMIN_PASSWORD || overrides.adminPassword || file.adminPassword || "",
      role: "admin",
    }];
  } else {
    users = users.map((user) => ({ ...user }));
    if (process.env.ADMIN_PASSWORD) {
      const name = process.env.ADMIN_USER;
      users = users.map((user) => (
        user.role === "admin" && (!name || user.userName === name)
          ? { ...user, password: process.env.ADMIN_PASSWORD }
          : user
      ));
    }
    if (process.env.OPERATOR_PASSWORD) {
      users = users.map((user) => (
        user.role === "operator" ? { ...user, password: process.env.OPERATOR_PASSWORD } : user
      ));
    }
  }
  users = users.filter((user) => user?.userName && (user.role === "admin" || user.role === "operator"));
  const token = process.env.ADMIN_TOKEN || overrides.token || file.token || file.adminPassword || users.find((user) => user.role === "admin")?.password || "";
  return {
    port: Number(process.env.PORT || overrides.port || file.port || 5088),
    dataRoot: path.isAbsolute(dataRoot) ? dataRoot : path.join(repoRoot, dataRoot),
    users,
    token,
    usesFactoryPassword: users.some((user) => user.password === "change-me") || token === "change-me",
  };
}
