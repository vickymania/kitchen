// Talking to the worker. A 401 means this device is no longer paired (signed
// out, or revoked from another phone); the app hears that as an event.

export class ApiError extends Error {
  constructor(status, code) {
    super(code || `http_${status}`);
    this.status = status;
    this.code = code || `http_${status}`;
  }
}

/** True for "no network", false for "the server said no". */
export const isOffline = (e) => !(e instanceof ApiError);

async function request(method, path, body, contentType = "application/json") {
  const init = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = contentType;
    init.body = contentType === "application/json" ? JSON.stringify(body) : body;
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401) window.dispatchEvent(new CustomEvent("kitchen:unpaired"));
  if (!res.ok) throw new ApiError(res.status, data?.error);
  return data;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body = {}) => request("POST", path, body),
  upload: (path, blob) => request("POST", path, blob, blob.type),
};
