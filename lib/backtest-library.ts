/**
 * 回测页的「标的库」：最近回测过的代码 + 自定义分组。
 *
 * 与 lib/watchlist.ts 的分组语义保持一致（分组 id / 名称 / 归属映射），
 * 但完全独立存储，互不影响：
 *   - 最近回测列表自动收集搜索过的代码（最多 MAX_BACKTEST_SYMBOLS 只）
 *   - 分组可自由命名，一个标的只属于一个分组
 *   - 删除分组时标的回到「未分组」，不会从标的库里消失
 */

export const LIBRARY_KEY = "data-insider:backtest-library:v1";
/** 旧版只有「最近回测」列表的存储键，首次打开时迁移过来 */
export const LEGACY_HISTORY_KEY = "data-insider:backtest-history:v1";

export const MAX_BACKTEST_SYMBOLS = 40;
export const MAX_BACKTEST_GROUPS = 12;
export const MAX_BACKTEST_GROUP_NAME = 12;

export const SYMBOL_RE = /^[A-Z0-9.^=-]{1,12}$/;

/** 「所有标的」伪分组 id（不落库，仅 UI 过滤用） */
export const ALL_SYMBOLS_ID = "__all__";
/** 未分组的伪分组 id（不落库，仅 UI 过滤用） */
export const UNGROUPED_SYMBOLS_ID = "__ungrouped__";
export const UNGROUPED_SYMBOLS_NAME = "未分组";

export interface BacktestGroup {
  id: string;
  name: string;
}

export interface BacktestLibrary {
  /** 最近回测过的代码，最新的在最前 */
  symbols: string[];
  groups: BacktestGroup[];
  /** 代码 → 分组 id；没有记录即「未分组」 */
  assignment: Record<string, string>;
}

export function emptyLibrary(): BacktestLibrary {
  return { symbols: [], groups: [], assignment: {} };
}

function normalizeSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  return SYMBOL_RE.test(value) ? value : null;
}

function sanitizeSymbolList(raw: unknown, max = MAX_BACKTEST_SYMBOLS): string[] {
  if (!Array.isArray(raw)) return [];
  const output: string[] = [];
  for (const item of raw) {
    const symbol = normalizeSymbol(item);
    if (!symbol || output.includes(symbol)) continue;
    output.push(symbol);
    if (output.length >= max) break;
  }
  return output;
}

/** 从 localStorage 读到的任意值里挑出合法的标的库（非法代码 / 重名分组 / 悬空归属都会被清理） */
export function sanitizeLibrary(raw: unknown): BacktestLibrary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyLibrary();
  const source = raw as Record<string, unknown>;

  const symbols = sanitizeSymbolList(source.symbols);

  const groups: BacktestGroup[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  if (Array.isArray(source.groups)) {
    for (const item of source.groups) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.id !== "string" || typeof candidate.name !== "string") continue;

      const name = candidate.name.trim().slice(0, MAX_BACKTEST_GROUP_NAME);
      const id = candidate.id.trim().slice(0, 32);
      if (!name || !id || names.has(name.toLowerCase()) || ids.has(id)) continue;

      names.add(name.toLowerCase());
      ids.add(id);
      groups.push({ id, name });
      if (groups.length >= MAX_BACKTEST_GROUPS) break;
    }
  }

  const assignment: Record<string, string> = {};
  if (
    source.assignment &&
    typeof source.assignment === "object" &&
    !Array.isArray(source.assignment)
  ) {
    for (const [symbol, groupId] of Object.entries(source.assignment as Record<string, unknown>)) {
      if (typeof groupId !== "string" || !ids.has(groupId)) continue;
      if (!symbols.includes(symbol)) continue;
      assignment[symbol] = groupId;
    }
  }

  return { symbols, groups, assignment };
}

/** 旧版「最近回测」列表（string[]）→ 标的库（无分组） */
export function libraryFromHistory(raw: unknown): BacktestLibrary {
  return { symbols: sanitizeSymbolList(raw), groups: [], assignment: {} };
}

/** 加入标的库：去重、移到最前、超出上限时丢弃最旧的；非法代码原样返回 */
export function addSymbol(library: BacktestLibrary, symbol: string): BacktestLibrary {
  const value = normalizeSymbol(symbol);
  if (!value) return library;

  const symbols = [value, ...library.symbols.filter((item) => item !== value)].slice(
    0,
    MAX_BACKTEST_SYMBOLS,
  );
  if (symbols.length === library.symbols.length && symbols[0] === library.symbols[0]) {
    return library;
  }

  const assignment: Record<string, string> = {};
  for (const [key, groupId] of Object.entries(library.assignment)) {
    if (symbols.includes(key)) assignment[key] = groupId;
  }
  return { ...library, symbols, assignment };
}

/** 从标的库移除（同时清掉分组归属） */
export function removeSymbol(library: BacktestLibrary, symbol: string): BacktestLibrary {
  if (!library.symbols.includes(symbol)) return library;
  const assignment = { ...library.assignment };
  delete assignment[symbol];
  return { ...library, symbols: library.symbols.filter((item) => item !== symbol), assignment };
}

/** 新建分组；重名 / 超过上限 / 空名称时返回 null */
export function createGroup(
  library: BacktestLibrary,
  name: string,
  now = Date.now(),
): { library: BacktestLibrary; group: BacktestGroup } | null {
  const trimmed = name.trim().slice(0, MAX_BACKTEST_GROUP_NAME);
  if (!trimmed) return null;
  if (library.groups.length >= MAX_BACKTEST_GROUPS) return null;
  if (library.groups.some((group) => group.name.toLowerCase() === trimmed.toLowerCase())) return null;

  const group: BacktestGroup = {
    id: `bg${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: trimmed,
  };
  return { library: { ...library, groups: [...library.groups, group] }, group };
}

/** 重命名分组；空名称 / 重名 / 分组不存在时返回 null */
export function renameGroup(
  library: BacktestLibrary,
  id: string,
  name: string,
): BacktestLibrary | null {
  const trimmed = name.trim().slice(0, MAX_BACKTEST_GROUP_NAME);
  if (!trimmed) return null;
  if (!library.groups.some((group) => group.id === id)) return null;
  if (
    library.groups.some(
      (group) => group.id !== id && group.name.toLowerCase() === trimmed.toLowerCase(),
    )
  ) {
    return null;
  }
  return {
    ...library,
    groups: library.groups.map((group) => (group.id === id ? { ...group, name: trimmed } : group)),
  };
}

/** 删除分组：组内标的回到「未分组」，不会从标的库消失 */
export function deleteGroup(library: BacktestLibrary, id: string): BacktestLibrary {
  if (!library.groups.some((group) => group.id === id)) return library;
  const assignment: Record<string, string> = {};
  for (const [symbol, groupId] of Object.entries(library.assignment)) {
    if (groupId !== id) assignment[symbol] = groupId;
  }
  return { ...library, groups: library.groups.filter((group) => group.id !== id), assignment };
}

/** 把标的归入分组（groupId 为 null 表示移出分组）；标的 / 分组不存在时原样返回 */
export function assignSymbol(
  library: BacktestLibrary,
  symbol: string,
  groupId: string | null,
): BacktestLibrary {
  if (!library.symbols.includes(symbol)) return library;
  const assignment = { ...library.assignment };
  if (groupId === null) {
    delete assignment[symbol];
    return { ...library, assignment };
  }
  if (!library.groups.some((group) => group.id === groupId)) return library;
  assignment[symbol] = groupId;
  return { ...library, assignment };
}

export interface LibrarySection {
  id: string;
  name: string;
  symbols: string[];
}

/**
 * 按分组切段（分组按创建顺序，空分组也保留；「未分组」只在有成员时追加）。
 * 段内保持标的库的原始顺序（最近回测在前）。
 */
export function groupSections(library: BacktestLibrary): LibrarySection[] {
  const buckets = new Map<string, string[]>();
  for (const group of library.groups) buckets.set(group.id, []);
  const ungrouped: string[] = [];

  for (const symbol of library.symbols) {
    const groupId = library.assignment[symbol];
    if (groupId && buckets.has(groupId)) buckets.get(groupId)!.push(symbol);
    else ungrouped.push(symbol);
  }

  const sections: LibrarySection[] = library.groups.map((group) => ({
    id: group.id,
    name: group.name,
    symbols: buckets.get(group.id) ?? [],
  }));
  if (ungrouped.length > 0 || library.groups.length === 0) {
    sections.push({ id: UNGROUPED_SYMBOLS_ID, name: UNGROUPED_SYMBOLS_NAME, symbols: ungrouped });
  }
  return sections;
}

/** 取某个分组（或全部 / 未分组）里的代码，用于「回测本组」 */
export function symbolsOf(library: BacktestLibrary, groupId: string): string[] {
  if (groupId === ALL_SYMBOLS_ID) return [...library.symbols];
  if (groupId === UNGROUPED_SYMBOLS_ID) {
    return library.symbols.filter((symbol) => !library.assignment[symbol]);
  }
  return library.symbols.filter((symbol) => library.assignment[symbol] === groupId);
}
