async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error || "请求失败");
    error.status = response.status;
    throw error;
  }
  return data;
}

function upload(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      const error = new Error(data?.error || "请求失败");
      error.status = xhr.status;
      reject(error);
    };
    xhr.onerror = () => reject(new Error("上传失败"));
    xhr.onabort = () => reject(new Error("上传已取消"));
    xhr.send(form);
  });
}

export const api = {
  me: () => request("/api/me").catch((error) => (error.status === 401 ? null : Promise.reject(error))),
  login: (userName, password) => request("/api/login", {
    method: "POST",
    body: JSON.stringify({ userName, password }),
  }),
  logout: () => request("/api/logout", { method: "POST", body: "{}" }),
  apps: () => request("/api/apps"),
  app: (id) => request(`/api/apps/${id}`),
  publish: (id, form, onProgress) => upload(`/api/apps/${id}/versions`, form, onProgress),
  unpublish: (id, channel, version) => request(
    `/api/apps/${id}/versions/${channel}/${encodeURIComponent(version)}/unpublish`,
    { method: "POST", body: "{}" },
  ),
  activate: (id, channel, version) => request(
    `/api/apps/${id}/versions/${channel}/${encodeURIComponent(version)}/publish`,
    { method: "POST", body: "{}" },
  ),
  rollout: (id, channel, version, body) => request(
    `/api/apps/${id}/versions/${channel}/${encodeURIComponent(version)}/rollout`,
    { method: "PUT", body: JSON.stringify(body) },
  ),
  policies: () => request("/api/policies"),
  savePolicy: (appId, channel, minSupportedVersion) => request(`/api/policies/${appId}/${channel}`, {
    method: "PUT",
    body: JSON.stringify({ minSupportedVersion }),
  }),
  dashboard: (appId = "") => request(`/api/dashboard${appId ? `?appId=${encodeURIComponent(appId)}` : ""}`),
  devices: (appId = "") => request(`/api/devices${appId ? `?appId=${encodeURIComponent(appId)}` : ""}`),
  events: (appId, deviceId) => request(`/api/devices/${appId}/${encodeURIComponent(deviceId)}/events`),
};
