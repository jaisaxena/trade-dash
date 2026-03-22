const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T = unknown>(path: string) => apiFetch<T>(path),
  post: <T = unknown>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T = unknown>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: <T = unknown>(path: string) =>
    apiFetch<T>(path, { method: "DELETE" }),
};
