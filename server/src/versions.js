const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export function isVersion(value) {
  return typeof value === "string" && VERSION.test(value);
}

export function compareVersions(left, right) {
  const [leftCore, leftPre] = split(left);
  const [rightCore, rightPre] = split(right);
  const core = compareCore(leftCore, rightCore);
  if (core !== 0) return core;
  if (!leftPre && !rightPre) return 0;
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  return leftPre < rightPre ? -1 : leftPre > rightPre ? 1 : 0;
}

function split(version) {
  const dash = version.indexOf("-");
  return dash < 0 ? [version, ""] : [version.slice(0, dash), version.slice(dash + 1)];
}

function compareCore(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
