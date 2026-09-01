import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const storeDir = path.resolve(process.env.PROJECT_OBSERVER_HOME || path.join(os.homedir(), '.project-observer'));
const bindingFile = path.join(storeDir, 'session-bindings.json');

async function ensureStore() {
  await fs.mkdir(storeDir, { recursive: true });
}

async function readStore() {
  try {
    const raw = await fs.readFile(bindingFile, 'utf8');
    const data = JSON.parse(raw);
    return {
      version: Number(data?.version) || 1,
      bindings: data?.bindings && typeof data.bindings === 'object' ? data.bindings : {}
    };
  } catch {
    return { version: 1, bindings: {} };
  }
}

async function writeStore(store) {
  await ensureStore();
  await fs.writeFile(bindingFile, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export async function getSessionBindings() {
  const store = await readStore();
  return store.bindings;
}

export async function saveSessionBinding({ sessionId, projectKey, projectPath = null, projectName = null }) {
  const id = String(sessionId || '').trim();
  const key = String(projectKey || '').trim();
  if (!id) throw new Error('缺少 Codex Session ID');
  if (!key) throw new Error('缺少项目身份键');

  const store = await readStore();
  store.bindings[id] = {
    sessionId: id,
    projectKey: key,
    projectPath: projectPath ? String(projectPath) : null,
    projectName: projectName ? String(projectName) : null,
    confirmedAt: new Date().toISOString(),
    source: 'manual'
  };
  await writeStore(store);
  return store.bindings[id];
}

export async function removeSessionBinding(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  const store = await readStore();
  if (!store.bindings[id]) return false;
  delete store.bindings[id];
  await writeStore(store);
  return true;
}

export function getSessionBindingStoreInfo() {
  return { storeDir, bindingFile };
}
