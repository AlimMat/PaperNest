"use strict";

// Embedded images can exceed localStorage's quota. IndexedDB retains full
// drafts; the old localStorage keys remain readable and serve as a fallback.
let writingDraftDatabase, writingDraftQueue = Promise.resolve();
function writingDraftDB() {
  if (!writingDraftDatabase) writingDraftDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open("ezread-writing-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("草稿数据库被其他窗口占用"));
  }).catch(error => { writingDraftDatabase = null; throw error; });
  return writingDraftDatabase;
}
async function writingDraftTransaction(action, key, value) {
  const db = await writingDraftDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", action === "get" ? "readonly" : "readwrite"), store = tx.objectStore("drafts");
    const request = action === "put" ? store.put(value, key) : action === "delete" ? store.delete(key) : store.get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("本机草稿保存失败"));
  });
}
function writingQueueDraft(operation) {
  const next = writingDraftQueue.then(operation, operation);
  writingDraftQueue = next.catch(() => {});
  return next;
}
function writingRemember(doc) {
  const key = writingDraftKey(doc.path), value = { content: doc.content, revision: doc.revision, at: Date.now() };
  return writingQueueDraft(async () => {
    try { await writingDraftTransaction("put", key, value); try { localStorage.removeItem(key); } catch {} return true; }
    catch {
      try { const raw = JSON.stringify(value); localStorage.setItem(key, raw); return localStorage.getItem(key) === raw; } catch { return false; }
    }
  });
}
function writingForget(path) {
  const key = writingDraftKey(path);
  return writingQueueDraft(async () => {
    try { await writingDraftTransaction("delete", key); } catch {}
    try { localStorage.removeItem(key); } catch {}
  });
}
async function writingReadDraft(path) {
  await writingDraftQueue;
  const key = writingDraftKey(path);
  let disk = null, legacy = null;
  try { disk = await writingDraftTransaction("get", key); } catch {}
  try { legacy = JSON.parse(localStorage.getItem(key) || "null"); } catch {}
  return legacy && (!disk || (legacy.at || 0) > (disk.at || 0)) ? legacy : disk;
}
