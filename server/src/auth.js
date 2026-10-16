import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "release-admin";
const MAX_AGE = 12 * 60 * 60 * 1000;

export function passwordMatches(provided, expected) {
  if (!provided || !expected) return false;
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAuth(config) {
  const material = config.users.map((user) => `${user.userName}:${user.password}:${user.role}`).join("|");
  const secret = createHash("sha256").update(`release-admin:${material}:${config.token}`).digest();

  function readUser(req) {
    const raw = req.cookies?.[COOKIE];
    if (!raw || !raw.includes(".")) return null;
    const dot = raw.lastIndexOf(".");
    const body = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expected = createHmac("sha256", secret).update(body).digest("base64url");
    const left = Buffer.from(sig);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (!payload?.user || payload.exp < Date.now()) return null;
      const user = config.users.find((item) => item.userName === payload.user && item.role === payload.role);
      return user ? { user: user.userName, role: user.role } : null;
    } catch {
      return null;
    }
  }

  function setSession(res, user, role) {
    const body = Buffer.from(JSON.stringify({ user, role, exp: Date.now() + MAX_AGE })).toString("base64url");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    res.cookie(COOKIE, `${body}.${sig}`, { httpOnly: true, sameSite: "lax", maxAge: MAX_AGE });
  }

  function clearSession(res) {
    res.clearCookie(COOKIE);
  }

  function bearerRole(req) {
    const header = req.get("authorization") || "";
    if (!header.toLowerCase().startsWith("bearer ")) return null;
    const value = header.slice(7).trim();
    if (passwordMatches(value, config.token)) return "admin";
    const admin = config.users.find((user) => user.role === "admin" && passwordMatches(value, user.password));
    return admin ? "admin" : null;
  }

  function actor(req) {
    return readUser(req) || (bearerRole(req) ? { user: "token", role: "admin" } : null);
  }

  return {
    setSession,
    clearSession,
    actor,
    isUser: (req) => Boolean(actor(req)),
    isAdmin: (req) => actor(req)?.role === "admin",
  };
}
