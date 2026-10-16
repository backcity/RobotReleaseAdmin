export const APPS = [
  { id: "single-arm", name: "单臂客户端", packId: "single-arm" },
  { id: "dual-arm", name: "双臂客户端", packId: "dual-arm" },
  { id: "single-arm-backend", name: "单臂后台", packId: "single-arm-backend" },
  { id: "dual-arm-backend", name: "双臂后台", packId: "dual-arm-backend" },
];

export const CHANNELS = [
  { id: "stable", name: "正式" },
  { id: "beta", name: "公测" },
  { id: "canary", name: "试点" },
];

export function findApp(id) {
  return APPS.find((app) => app.id === id) ?? null;
}

export function findChannel(id) {
  return CHANNELS.find((channel) => channel.id === id) ?? null;
}
