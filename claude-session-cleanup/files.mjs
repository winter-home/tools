import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function exists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Check every ancestor: a safe-looking filename may still sit below a junction.
export function checked(root, file) {
  root = path.resolve(root); file = path.resolve(file);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`허용된 저장 위치 밖의 경로입니다: ${file}`);
  }
  // Walk the entire absolute path, including ancestors above the configured root.
  const volume = path.parse(file).root;
  let current = volume, stat;
  for (const part of ['', ...file.slice(volume.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== file)) {
      throw new Error(`링크 또는 잘못된 경로를 처리하지 않습니다: ${current}`);
    }
  }
  return stat;
}

function fileEntry(root, file, stat) {
  return { root, file, size: stat.size, mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs, ino: String(stat.ino), dev: String(stat.dev) };
}

// A transcript/debug file is never a directory to recurse into. Required main logs must exist.
export function fileInventory(root, target, { required = false } = {}) {
  if (!required && !exists(target)) return [];
  const stat = checked(root, target);
  if (!stat.isFile()) throw new Error(`일반 파일이 아닙니다: ${target}`);
  return [fileEntry(root, target, stat)];
}

export function inventory(root, target) {
  if (!exists(target)) return [];
  const stat = checked(root, target);
  if (stat.isDirectory()) return fs.readdirSync(target).flatMap(name => inventory(root, path.join(target, name)));
  if (!stat.isFile()) throw new Error(`일반 파일이 아닙니다: ${target}`);
  return [fileEntry(root, target, stat)];
}

export function sameFiles(a, b) {
  const ordered = value => [...value].sort((x, y) => x.file.localeCompare(y.file));
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}

export function atomicJson(file, value, { flush = false } = {}) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', flush });
  try { fs.renameSync(temp, file); }
  finally { if (exists(temp)) fs.unlinkSync(temp); }
}

export async function backupFiles(files, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const manifest = [];
  for (const [index, item] of files.entries()) {
    checked(item.root, item.file);
    const backup = path.join(directory, `${index}.gz`);
    await pipeline(fs.createReadStream(item.file), createGzip({ level: 1 }),
      fs.createWriteStream(backup, { flags: 'wx', flush: true }));
    manifest.push({ original: item.file, backup, size: item.size });
  }
  // Payloads must be flushed and closed, then the manifest flushed and renamed, before deletion.
  atomicJson(path.join(directory, 'manifest.json'), { files: manifest }, { flush: true });
  return manifest;
}
