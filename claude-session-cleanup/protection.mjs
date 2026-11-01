import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checked, exists, inventory, readJson, uuid } from './files.mjs';

export function desktopDirectories(env = process.env, platform = process.platform) {
  const candidates = [];
  const children = root => exists(root) ? fs.readdirSync(root) : [];
  if (platform === 'win32') {
    if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'Claude'));
    if (env.LOCALAPPDATA) {
      const data = path.join(env.LOCALAPPDATA, 'Claude-Data');
      for (const name of children(data)) candidates.push(path.join(data, name));
      const packages = path.join(env.LOCALAPPDATA, 'Packages');
      for (const name of children(packages).filter(n => /^Claude_/i.test(n))) {
        for (const app of ['Claude', 'Claude-3p']) candidates.push(path.join(packages, name, 'LocalCache', 'Roaming', app));
      }
    }
  } else {
    candidates.push(platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude')
      : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude'));
  }
  return [...new Set(candidates.filter(exists).filter(p => checked(p, p).isDirectory()).map(p => path.resolve(p)))];
}

class MirrorFormatError extends Error {}

function discoverAppData(directories) {
  // Presence is independent of any supported storage format. Unknown files still mean app data.
  return directories.filter(directory => {
    checked(directory, directory);
    return fs.readdirSync(directory).length > 0;
  });
}

function stringUuid(value) {
  if (typeof value !== 'string' || !uuid.test(value)) {
    throw new MirrorFormatError('UUID 문자열 형식을 확인할 수 없습니다.');
  }
  return value.toLowerCase();
}

function localId(value) {
  if (typeof value !== 'string' || !value.startsWith('local_')) {
    throw new MirrorFormatError('Claude 앱의 고정 목록 형식을 확인할 수 없습니다.');
  }
  return `local_${stringUuid(value.slice(6))}`;
}

function collectPins(value, legacy = false) {
  const pins = new Set(), warnings = [];
  if (!Array.isArray(value)) return { pins, warnings: ['고정 목록이 배열이 아닙니다.'] };
  for (const [index, entry] of value.entries()) {
    try {
      let id = entry;
      if (legacy && typeof id === 'string' && id.startsWith('code:')) id = id.slice(5);
      // Other surfaces in the shared sidebar are outside the local Code transcript scope.
      if (legacy && typeof id === 'string' && /^(?:cowork|chat|space):/.test(id)) continue;
      pins.add(localId(id));
    } catch (error) {
      if (!(error instanceof MirrorFormatError)) throw error;
      warnings.push(`원소 ${index + 1}: ${error.message}`);
    }
  }
  return { pins, warnings };
}

export function readProtection(directories) {
  const pins = new Set(), records = [], sources = discoverAppData(directories), warnings = [];
  // Schema failures are diagnostic data. File access and path safety failures remain fatal.
  const mirror = (root, file, read) => {
    checked(root, file);
    try { return read(); }
    catch (error) {
      if (!(error instanceof SyntaxError || error instanceof MirrorFormatError)) throw error;
      warnings.push(`${file}: ${error.message}`);
    }
  };
  for (const directory of sources) {
    const markers = ['claude_desktop_config.json', 'claude-code-sessions', 'Local Storage', 'IndexedDB']
      .map(name => path.join(directory, name)).filter(exists);
    for (const marker of markers) checked(directory, marker);
    if (!markers.length) warnings.push(`${directory}: 지원하는 앱 저장 형식을 찾지 못했습니다.`);
    const localPins = new Set();
    const config = path.join(directory, 'claude_desktop_config.json');
    if (exists(config)) {
      mirror(directory, config, () => {
        const value = readJson(config);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MirrorFormatError('앱 설정이 JSON 객체가 아닙니다.');
        let prefs = value.preferences?.epitaxyPrefs;
        if (typeof prefs === 'string') prefs = JSON.parse(prefs);
        if (prefs !== undefined && (!prefs || typeof prefs !== 'object' || Array.isArray(prefs))) {
          throw new MirrorFormatError('Claude 고정 설정 형식을 확인할 수 없습니다.');
        }
        const list = (name, value, legacy = false) => {
          const collected = collectPins(value, legacy);
          for (const pin of collected.pins) localPins.add(pin);
          for (const warning of collected.warnings) warnings.push(`${config}: ${name} ${warning}`);
        };
        if (prefs && Object.hasOwn(prefs, 'starred-local-code-sessions')) {
          list('starred-local-code-sessions', prefs['starred-local-code-sessions']);
        } else warnings.push(`${config}: 알려진 고정 목록 키가 없습니다.`);
        // Historical pins are additional protection, never authority to allow deletion.
        const legacy = prefs?.['dframe-local-slice'];
        if (legacy && Object.hasOwn(legacy, 'pinnedOrder')) list('pinnedOrder', legacy.pinnedOrder, true);
        if (prefs?.['starred-session-groups']?.length) warnings.push(`${config}: 고정된 그룹의 포함 대화를 확인할 수 없습니다.`);
      });
    }
    const sessions = path.join(directory, 'claude-code-sessions');
    const ownRecords = [];
    if (exists(sessions)) {
      // The supported layout is account/org/local_<uuid>.json. Never use paths from JSON.
      for (const account of fs.readdirSync(sessions)) {
        const accountDir = path.join(sessions, account);
        if (!checked(directory, accountDir).isDirectory()) continue;
        for (const org of fs.readdirSync(accountDir)) {
          const orgDir = path.join(accountDir, org);
          if (!checked(directory, orgDir).isDirectory()) continue;
          for (const name of fs.readdirSync(orgDir).filter(n => /^local_.*\.json$/i.test(n))) {
            const file = path.join(orgDir, name);
            const record = mirror(directory, file, () => {
              const value = readJson(file), id = localId(name.slice(0, -5));
              if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MirrorFormatError('앱 항목이 JSON 객체가 아닙니다.');
              const cliId = stringUuid(value.cliSessionId);
              if (localId(value.sessionId) !== id) {
                throw new MirrorFormatError('앱 항목과 실제 대화의 연결을 확인할 수 없습니다.');
              }
              for (const key of ['isStarred', 'isPinned']) {
                if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new MirrorFormatError('잘못된 고정 표시입니다.');
                if (value[key]) localPins.add(id);
              }
              let modified = 0;
              for (const key of ['lastActivityAt', 'lastFocusedAt', 'lastTurnEdgeAt', 'latestUserFrameAt']) {
                if (value[key] !== undefined) {
                  if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0) {
                    throw new MirrorFormatError('앱 활동 시각을 확인할 수 없습니다.');
                  }
                  modified = Math.max(modified, value[key]);
                }
              }
              return { id, cliId, modified, files: inventory(directory, file) };
            });
            if (record) ownRecords.push(record);
          }
        }
      }
    }
    for (const id of localPins) {
      const matches = ownRecords.filter(record => record.id === id);
      if (!matches.length) warnings.push(`${directory}: 고정 항목 ${id}의 실제 대화 ID를 찾을 수 없습니다.`);
      for (const record of matches) pins.add(record.cliId);
    }
    records.push(...ownRecords);
  }
  // No authoritative reader is implemented: observed app data can only be unverified.
  return { state: sources.length ? 'unverified' : 'absent', pins, records, sources, warnings };
}

export function deletionPolicy(protection) {
  if (protection.state === 'absent' || protection.state === 'verified') return { allowed: true, reasons: [] };
  return { allowed: false, reasons: protection.sources.length
    ? protection.sources.map(source => `고정 원본 미검증: ${source}`) : ['고정 상태 확인 불가'] };
}

export function requireVerifiedPins(protection) {
  const policy = deletionPolicy(protection);
  if (!policy.allowed) {
    throw new Error('Claude 앱의 고정 원본(IndexedDB)을 검증할 수 없어 삭제를 중단합니다. '
      + '현재 앱 저장 형식은 미리보기만 지원합니다: ' + policy.reasons.join(', '));
  }
}
