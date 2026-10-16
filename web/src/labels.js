export const channels = [
  { id: "stable", name: "正式" },
  { id: "beta", name: "公测" },
  { id: "canary", name: "试点" },
];

export function channelName(id) {
  return channels.find((channel) => channel.id === id)?.name ?? id;
}

export function statusText(row) {
  if (row.displayStatus === "deprecated") return "已下线";
  if (row.displayStatus === "draft") return "草稿";
  if (row.displayStatus === "gray") return "灰度中";
  if (row.latest) return "当前最新";
  return "已发布";
}

export function statusType(row) {
  if (row.displayStatus === "deprecated") return "info";
  if (row.displayStatus === "draft") return "info";
  if (row.displayStatus === "gray") return "warning";
  if (row.latest) return "success";
  return "primary";
}

export function eventText(event) {
  if (event === "AppliedSuccess") return "成功";
  if (event === "Failed") return "失败";
  if (event === "UpdateStarted") return "更新中";
  if (event === "DownloadProgress") return "下载中";
  return "尚未上报";
}
