import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, checked, exists, inventory, readJson, sameFiles, uuid } from './files.mjs';

export function projectsIn(home) {
  const directory = path.join(home, 'projects');
  if (!exists(directory)) return [];
  checked(home, directory);
  return fs.readdirSync(directory).filter(name => checked(home, path.join(directory, name)).isDirectory())
    .map(name => ({ root: home, name }));
}

export function indexesFor(projects) {
  return projects.flatMap(project => {
    const file = path.join(project.root, 'projects', project.name, 'sessions-index.json');
    if (!exists(file)) return [];
    checked(project.root, file);
    const value = readJson(file);
    if (!value || !Array.isArray(value.entries) || value.entries.some(e => !e || typeof e.sessionId !== 'string' || !uuid.test(e.sessionId))) {
      throw new Error(`대화 인덱스 형식을 확인할 수 없습니다: ${file}`);
    }
    return [{ type: 'index', root: project.root, file, value, files: inventory(project.root, file) }];
  });
}

// Preserve untouched history lines byte-for-byte, including CRLF and a missing final newline.
async function* historyLines(home) {
  const file = path.join(home, 'history.jsonl');
  checked(home, file);
  let pending = '', first = true;
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8' })) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end + 1); pending = pending.slice(end + 1);
      yield parseLine(line, first, file); first = false;
    }
  }
  if (pending) yield parseLine(pending, first, file);
}

function parseLine(line, first, file) {
  const text = first ? line.replace(/^\uFEFF/, '') : line;
  if (!text.trim()) return { line, id: null };
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || !uuid.test(value.sessionId)))) {
    throw new Error(`입력 이력 형식을 확인할 수 없습니다: ${file}`);
  }
  return { line, id: value.sessionId?.toLowerCase() ?? null };
}

export async function prepareMetadata(home, projects, ids, removePromptHistory) {
  const plans = indexesFor(projects).filter(index => index.value.entries.some(e => ids.has(e.sessionId.toLowerCase())));
  const file = path.join(home, 'history.jsonl');
  if (removePromptHistory && exists(file)) {
    const files = inventory(home, file);
    // Reject corrupt history before the first session deletion, even if its bad line is unrelated.
    for await (const entry of historyLines(home)) { /* validate */ }
    if (!sameFiles(files, inventory(home, file))) throw new Error('입력 이력 확인 중 파일이 변경되었습니다.');
    plans.push({ type: 'history', root: home, file, files });
  }
  return plans;
}

export function checkMetadata(plans) {
  for (const plan of plans) {
    if (!sameFiles(plan.files, inventory(plan.root, plan.file))) throw new Error(`공유 메타데이터가 변경되었습니다: ${plan.file}`);
  }
}

export async function updateMetadata(plans, ids) {
  let removedPromptEntries = 0;
  for (const plan of plans) {
    checkMetadata([plan]);
    if (plan.type === 'index') {
      atomicJson(plan.file, { ...plan.value, entries: plan.value.entries.filter(e => !ids.has(e.sessionId.toLowerCase())) });
      continue;
    }
    const temp = `${plan.file}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temp, 'wx');
    try {
      for await (const entry of historyLines(plan.root)) {
        if (entry.id && ids.has(entry.id)) removedPromptEntries++;
        else fs.writeFileSync(descriptor, entry.line, 'utf8');
      }
      fs.fsyncSync(descriptor);
    } catch (error) {
      fs.closeSync(descriptor); fs.unlinkSync(temp); throw error;
    }
    fs.closeSync(descriptor);
    try { checkMetadata([plan]); fs.renameSync(temp, plan.file); }
    finally { if (exists(temp)) fs.unlinkSync(temp); }
  }
  return { removedPromptEntries };
}

export async function remainingHistoryIds(home, ids) {
  const result = new Set(), file = path.join(home, 'history.jsonl');
  if (exists(file)) for await (const entry of historyLines(home)) if (entry.id && ids.has(entry.id)) result.add(entry.id);
  return [...result];
}
