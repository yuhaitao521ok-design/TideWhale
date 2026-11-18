/**
 * 回测页的「标的库」：最近回测过的代码 + 自定义分组。
 *
 * 与 lib/watchlist.ts 的分组语义保持一致（分组 id / 名称 / 归属映射），
 * 但完全独立存储，互不影响：
 *   - 最近回测列表自动收集搜索过的代码（最多 MAX_BACKTEST_SYMBOLS 只）
 *   - 分组可自由命名、可拖动排序，同一个标的可以同时属于多个分组
 *   - 删除分组时只移除该归属，不会从标的库里消失
 *   - 每个「分配口径」（分组 / 所有标的 / 未分组）可给成员设仓位百分比，
 *     同一口径内合计不得超过 100%，剩余部分自动按现金处理（见 allocationOf）
 */

export const LIBRARY_KEY = "data-insider:backtest-library:v2";
/** v1 的归属是「代码 → 单个分组」，读取时自动升级为数组 */
export const LEGACY_LIBRARY_KEY = "data-insider:backtest-library:v1";
/** 更早的版本只有「最近回测」列表（string[]），首次打开时迁移过来 */
export const LEGACY_HISTORY_KEY = "data-insider:backtest-history:v1";

export const MAX_BACKTEST_SYMBOLS = 40;
export const MAX_BACKTEST_GROUPS = 12;
export const MAX_BACKTEST_GROUP_NAME = 12;
/** 单个分配口径内允许的仓位百分比上限（合计值，含现金后恒为 100） */
export const MAX_WEIGHT_PERCENT = 100;

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
  /** 代码 → 分组 id 列表（可属于多个分组；没有记录即「未分组」） */
  assignment: Record<string, string[]>;
  /**
   * 仓位百分比：分配口径 → 代码 → 百分比（0–100，1 位小数）。
   * 口径用真实分组 id，或 ALL_SYMBOLS_ID / UNGROUPED_SYMBOLS_ID。
   * 同一口径内合计不超过 100，剩余部分按现金处理。
   */
  weights: Record<string, Record<string, number>>;
}

export function emptyLibrary(): BacktestLibrary {
  return { symbols: [], groups: [], assignment: {}, weights: {} };
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

/** 仓位百分比规范化：保留 1 位小数并夹到 0–100 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(MAX_WEIGHT_PERCENT, Math.max(0, value)) * 10) / 10;
}

/** 所有可设仓位的口径：分组 id + 「所有标的」/「未分组」两个伪口径 */
function scopeIdsOf(library: BacktestLibrary): string[] {
  return [ALL_SYMBOLS_ID, UNGROUPED_SYMBOLS_ID, ...library.groups.map((group) => group.id)];
}

/** 从 weights 里删掉某个标的（该口径没有其它仓位时连同口径一起清掉） */
function dropWeight(
  weights: Record<string, Record<string, number>>,
  scopeId: string,
  symbol: string,
): Record<string, Record<string, number>> {
  const scope = weights[scopeId];
  if (!scope || !(symbol in scope)) return weights;
  const nextScope = { ...scope };
  delete nextScope[symbol];
  const next = { ...weights };
  if (Object.keys(nextScope).length > 0) next[scopeId] = nextScope;
  else delete next[scopeId];
  return next;
}

/** 删掉整个口径的仓位（删除分组 / 清空标的库时用） */
function dropScope(
  weights: Record<string, Record<string, number>>,
  scopeId: string,
): Record<string, Record<string, number>> {
  if (!weights[scopeId]) return weights;
  const next = { ...weights };
  delete next[scopeId];
  return next;
}

/**
 * 清理存档里的仓位：只保留「当前口径成员 + 有限数值」，按标的库顺序累加，
 * 超过 100% 的部分直接丢弃（保证持久化数据永远满足「合计 ≤ 100」）。
 */
function sanitizeWeights(
  raw: unknown,
  library: BacktestLibrary,
): Record<string, Record<string, number>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const output: Record<string, Record<string, number>> = {};

  for (const scopeId of scopeIdsOf(library)) {
    const stored = source[scopeId];
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) continue;
    const entries = stored as Record<string, unknown>;
    const allocation: Record<string, number> = {};
    let used = 0;

    for (const symbol of symbolsOf(library, scopeId)) {
      const value = entries[symbol];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const remaining = clampPercent(MAX_WEIGHT_PERCENT - used);
      if (remaining <= 0) break;
      const percent = clampPercent(Math.min(value, remaining));
      if (percent <= 0) continue;
      allocation[symbol] = percent;
      used = clampPercent(used + percent);
    }

    if (Object.keys(allocation).length > 0) output[scopeId] = allocation;
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

  const assignment: Record<string, string[]> = {};
  if (
    source.assignment &&
    typeof source.assignment === "object" &&
    !Array.isArray(source.assignment)
  ) {
    for (const [symbol, value] of Object.entries(source.assignment as Record<string, unknown>)) {
      if (!symbols.includes(symbol)) continue;
      // v1 是单个字符串，v2 是数组；两种都接受，顺带去重并清掉失效分组
      const candidates = Array.isArray(value) ? value : [value];
      const groupIds: string[] = [];
      for (const candidate of candidates) {
        if (typeof candidate !== "string" || !ids.has(candidate)) continue;
        if (!groupIds.includes(candidate)) groupIds.push(candidate);
      }
      if (groupIds.length > 0) assignment[symbol] = groupIds;
    }
  }

  const base: BacktestLibrary = { symbols, groups, assignment, weights: {} };
  return { ...base, weights: sanitizeWeights(source.weights, base) };
}

/** 旧版「最近回测」列表（string[]）→ 标的库（无分组） */
export function libraryFromHistory(raw: unknown): BacktestLibrary {
  return { symbols: sanitizeSymbolList(raw), groups: [], assignment: {}, weights: {} };
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

  const assignment: Record<string, string[]> = {};
  for (const [key, groupIds] of Object.entries(library.assignment)) {
    if (symbols.includes(key)) assignment[key] = groupIds;
  }

  const weights: Record<string, Record<string, number>> = {};
  for (const [scopeId, scope] of Object.entries(library.weights)) {
    const nextScope: Record<string, number> = {};
    for (const [key, percent] of Object.entries(scope)) {
      if (symbols.includes(key)) nextScope[key] = percent;
    }
    if (Object.keys(nextScope).length > 0) weights[scopeId] = nextScope;
  }
  return { ...library, symbols, assignment, weights };
}

/** 从标的库移除（同时清掉分组归属与各口径的仓位） */
export function removeSymbol(library: BacktestLibrary, symbol: string): BacktestLibrary {
  if (!library.symbols.includes(symbol)) return library;
  const assignment = { ...library.assignment };
  delete assignment[symbol];

  let weights = library.weights;
  for (const scopeId of Object.keys(weights)) {
    weights = dropWeight(weights, scopeId, symbol);
  }

  return {
    ...library,
    symbols: library.symbols.filter((item) => item !== symbol),
    assignment,
    weights,
  };
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

/** 删除分组：从所有标的的归属里移除该 id，不会从标的库消失，同时清掉该分组的仓位 */
export function deleteGroup(library: BacktestLibrary, id: string): BacktestLibrary {
  if (!library.groups.some((group) => group.id === id)) return library;
  const assignment: Record<string, string[]> = {};
  for (const [symbol, groupIds] of Object.entries(library.assignment)) {
    const next = groupIds.filter((groupId) => groupId !== id);
    if (next.length > 0) assignment[symbol] = next;
  }
  return {
    ...library,
    groups: library.groups.filter((group) => group.id !== id),
    assignment,
    weights: dropScope(library.weights, id),
  };
}

/** 切换某个标的在某个分组里的归属（可同时属于多个分组） */
export function toggleSymbolGroup(
  library: BacktestLibrary,
  symbol: string,
  groupId: string,
): BacktestLibrary {
  if (!library.symbols.includes(symbol)) return library;
  if (!library.groups.some((group) => group.id === groupId)) return library;

  const current = library.assignment[symbol] ?? [];
  const adding = !current.includes(groupId);
  const next = adding ? [...current, groupId] : current.filter((item) => item !== groupId);

  const assignment = { ...library.assignment };
  if (next.length > 0) assignment[symbol] = next;
  else delete assignment[symbol];

  // 仓位只对「当前分组成员」有意义：离开分组时清掉该分组仓位；
  // 加入分组时清掉「未分组」口径的仓位（该标的已不属于未分组）
  let weights = library.weights;
  if (adding) weights = dropWeight(weights, UNGROUPED_SYMBOLS_ID, symbol);
  else weights = dropWeight(weights, groupId, symbol);

  return { ...library, assignment, weights };
}

/** 把标的移出全部分组（回到「未分组」），同时清掉它在各分组里的仓位 */
export function clearSymbolGroups(library: BacktestLibrary, symbol: string): BacktestLibrary {
  const groupIds = library.assignment[symbol] ?? [];
  if (groupIds.length === 0) return library;

  const assignment = { ...library.assignment };
  delete assignment[symbol];

  let weights = library.weights;
  for (const groupId of groupIds) {
    weights = dropWeight(weights, groupId, symbol);
  }

  return { ...library, assignment, weights };
}

/** 某个标的分属的分组（按分组当前顺序返回，供 UI 展示） */
export function groupsOfSymbol(library: BacktestLibrary, symbol: string): BacktestGroup[] {
  const groupIds = library.assignment[symbol] ?? [];
  return library.groups.filter((group) => groupIds.includes(group.id));
}

/** 调整分组顺序（拖动标签）：越界或原地不动时原样返回 */
export function moveGroup(library: BacktestLibrary, from: number, to: number): BacktestLibrary {
  if (from === to) return library;
  if (from < 0 || from >= library.groups.length) return library;
  if (to < 0 || to >= library.groups.length) return library;

  const groups = [...library.groups];
  const [moved] = groups.splice(from, 1);
  groups.splice(to, 0, moved);
  return { ...library, groups };
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
    const groupIds = library.assignment[symbol] ?? [];
    let placed = false;
    for (const groupId of groupIds) {
      if (!buckets.has(groupId)) continue;
      buckets.get(groupId)!.push(symbol);
      placed = true;
    }
    if (!placed) ungrouped.push(symbol);
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
  return library.symbols.filter((symbol) =>
    (library.assignment[symbol] ?? []).includes(groupId),
  );
}

/* ------------------------------- 仓位分配 ------------------------------- */

export interface BacktestAllocation {
  /** 分配口径：真实分组 id 或 ALL_SYMBOLS_ID / UNGROUPED_SYMBOLS_ID */
  scopeId: string;
  /** 该口径下的全部成员（顺序与标的库一致） */
  members: string[];
  /** 代码 → 百分比（只含 > 0 的项，合计 ≤ 100） */
  percentOf: Record<string, number>;
  /** 已分配合计（0–100） */
  invested: number;
  /** 未分配部分，按现金处理（0–100） */
  cash: number;
}

/**
 * 某个口径的仓位分配：只统计当前成员，合计夹到 100，
 * 不足以覆盖 100% 的差额就是现金占比（`cash`）。
 */
export function allocationOf(library: BacktestLibrary, scopeId: string): BacktestAllocation {
  const members = symbolsOf(library, scopeId);
  const stored = library.weights[scopeId] ?? {};
  const percentOf: Record<string, number> = {};
  let invested = 0;

  for (const symbol of members) {
    const value = stored[symbol];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    const percent = clampPercent(Math.min(value, MAX_WEIGHT_PERCENT - invested));
    if (percent <= 0) continue;
    percentOf[symbol] = percent;
    invested = clampPercent(invested + percent);
  }

  return {
    scopeId,
    members,
    percentOf,
    invested,
    cash: clampPercent(MAX_WEIGHT_PERCENT - invested),
  };
}

/** 某个标的在某个口径里的仓位（不是成员 / 未设置时为 0） */
export function weightOf(library: BacktestLibrary, scopeId: string, symbol: string): number {
  return allocationOf(library, scopeId).percentOf[symbol] ?? 0;
}

/**
 * 设置仓位百分比：负数 / 非数字夹到 0，超过剩余额度时按剩余额度封顶
 * （同一口径合计不超过 100%）。未变化时返回原对象，方便 React 跳过渲染。
 */
export function setSymbolWeight(
  library: BacktestLibrary,
  scopeId: string,
  symbol: string,
  percent: number,
): BacktestLibrary {
  if (!Number.isFinite(percent)) return library;
  if (!symbolsOf(library, scopeId).includes(symbol)) return library;

  const current = allocationOf(library, scopeId);
  const currentPercent = current.percentOf[symbol] ?? 0;
  const remaining = clampPercent(MAX_WEIGHT_PERCENT - (current.invested - currentPercent));
  const next = clampPercent(Math.min(percent, remaining));
  if (next === currentPercent) return library;

  const scope: Record<string, number> = { ...(library.weights[scopeId] ?? {}) };
  if (next <= 0) delete scope[symbol];
  else scope[symbol] = next;

  const weights = { ...library.weights };
  if (Object.keys(scope).length > 0) weights[scopeId] = scope;
  else delete weights[scopeId];
  return { ...library, weights };
}

/** 清空某个口径的全部仓位（现金回到 100%） */
export function clearAllocation(library: BacktestLibrary, scopeId: string): BacktestLibrary {
  const weights = dropScope(library.weights, scopeId);
  return weights === library.weights ? library : { ...library, weights };
}

/** 清空标的库：代码 / 归属 / 仓位一起清掉，分组保留 */
export function clearSymbols(library: BacktestLibrary): BacktestLibrary {
  return { ...library, symbols: [], assignment: {}, weights: {} };
}
