const TASK_STORAGE_KEY = "ar-glasses-v0-task";

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed (HTTP ${response.status}).`);
  }
  return body;
}

export async function createModel() {
  return readJson(
    await fetch("/api/model", {
      method: "POST",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function getModelStatus(taskId) {
  return readJson(await fetch(`/api/model/${encodeURIComponent(taskId)}`));
}

export function saveTask(taskId) {
  localStorage.setItem(TASK_STORAGE_KEY, taskId);
}

export function loadTask() {
  return localStorage.getItem(TASK_STORAGE_KEY);
}

export function clearTask() {
  localStorage.removeItem(TASK_STORAGE_KEY);
}
