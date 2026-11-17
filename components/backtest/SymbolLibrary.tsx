"use client";

import { useState } from "react";

import { useI18n } from "@/lib/i18n";
import {
  ALL_SYMBOLS_ID,
  MAX_BACKTEST_GROUP_NAME,
  MAX_BACKTEST_GROUPS,
  UNGROUPED_SYMBOLS_ID,
  symbolsOf,
  type BacktestLibrary,
} from "@/lib/backtest-library";

interface SymbolLibraryProps {
  library: BacktestLibrary;
  /** 当前过滤的分组：ALL_SYMBOLS_ID / UNGROUPED_SYMBOLS_ID / 真实分组 id */
  activeGroupId: string;
  onActiveGroupChange: (groupId: string) => void;
  currentSymbol: string;
  /** 点击标的：切换回测对象 */
  onSelect: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  /** 返回错误信息；成功返回 null */
  onCreateGroup: (name: string) => string | null;
  onRenameGroup: (groupId: string, name: string) => string | null;
  onDeleteGroup: (groupId: string) => void;
  onAssign: (symbol: string, groupId: string | null) => void;
  onClear: () => void;
  /** 整组回测（只在真实分组上可用） */
  onBatchBacktest: (groupId: string) => void;
  batch: { running: boolean; done: number; total: number } | null;
}

/**
 * 回测标的库：最近搜索自动收集 + 自定义分组 + 整组回测。
 * 列表默认展示「全部」，切到分组后只显示组内标的，并可一键回测整组。
 */
export default function SymbolLibrary({
  library,
  activeGroupId,
  onActiveGroupChange,
  currentSymbol,
  onSelect,
  onRemove,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onAssign,
  onClear,
  onBatchBacktest,
  batch,
}: SymbolLibraryProps) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const activeGroup = library.groups.find((group) => group.id === activeGroupId) ?? null;
  const members = symbolsOf(library, activeGroupId);

  function submitCreate() {
    const message = onCreateGroup(name);
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    setName("");
    setCreating(false);
  }

  const tabClass = (active: boolean) =>
    `inline-flex max-w-[120px] items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] transition-colors ${
      active
        ? "border-accent/50 bg-accent-soft font-medium text-accent"
        : "border-border text-muted-foreground hover:border-accent/30 hover:bg-hover hover:text-foreground"
    }`;

  return (
    <section className="rounded-xl border border-border bg-card p-3">
      <p className="mb-2 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
        {t("标的库")}
        <span className="num flex items-center gap-1.5 rounded bg-muted px-1.5 py-0.5 text-[9.5px] font-normal text-muted-foreground/80">
          {library.symbols.length}
          {library.symbols.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="rounded px-0.5 transition-colors hover:bg-hover hover:text-negative-text"
            >
              {t("清空")}
            </button>
          )}
        </span>
      </p>

      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => onActiveGroupChange(ALL_SYMBOLS_ID)}
          aria-pressed={activeGroupId === ALL_SYMBOLS_ID}
          className={tabClass(activeGroupId === ALL_SYMBOLS_ID)}
        >
          {t("所有标的")}
        </button>
        {library.groups.map((group) => (
          <button
            key={group.id}
            type="button"
            onClick={() => {
              onActiveGroupChange(group.id);
              setRenaming(false);
              setError(null);
            }}
            aria-pressed={activeGroupId === group.id}
            title={group.name}
            className={tabClass(activeGroupId === group.id)}
          >
            <span className="truncate">{group.name}</span>
            <span className="num shrink-0 opacity-70">{symbolsOf(library, group.id).length}</span>
          </button>
        ))}
        {library.groups.length > 0 && symbolsOf(library, UNGROUPED_SYMBOLS_ID).length > 0 && (
          <button
            type="button"
            onClick={() => {
              onActiveGroupChange(UNGROUPED_SYMBOLS_ID);
              setRenaming(false);
              setError(null);
            }}
            aria-pressed={activeGroupId === UNGROUPED_SYMBOLS_ID}
            className={tabClass(activeGroupId === UNGROUPED_SYMBOLS_ID)}
          >
            {t("未分组")}
            <span className="num shrink-0 opacity-70">
              {symbolsOf(library, UNGROUPED_SYMBOLS_ID).length}
            </span>
          </button>
        )}
        <button
          type="button"
          disabled={library.groups.length >= MAX_BACKTEST_GROUPS}
          onClick={() => {
            setCreating(true);
            setError(null);
          }}
          aria-label={t("新建分组")}
          title={t("新建分组")}
          className="rounded-md border border-dashed border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:border-accent/40 hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          ＋
        </button>
      </div>

      {creating && (
        <div className="mt-1.5 flex items-center gap-1">
          <input
            autoFocus
            value={name}
            maxLength={MAX_BACKTEST_GROUP_NAME}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitCreate();
              if (event.key === "Escape") {
                setCreating(false);
                setError(null);
              }
            }}
            placeholder={t("分组名称，如 科技 / 指数")}
            aria-label={t("新分组名称")}
            className="h-6 min-w-0 flex-1 rounded-md border border-border bg-card px-1.5 text-[11px] outline-none focus:border-accent/60"
          />
          <button
            type="button"
            onClick={submitCreate}
            className="h-6 shrink-0 rounded-md bg-foreground px-2 text-[10.5px] text-background"
          >
            {t("创建")}
          </button>
        </div>
      )}

      {(activeGroup || activeGroupId === UNGROUPED_SYMBOLS_ID) && (
        <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-1.5">
          {activeGroup && renaming ? (
            <input
              autoFocus
              defaultValue={activeGroup.name}
              maxLength={MAX_BACKTEST_GROUP_NAME}
              aria-label={t("重命名分组")}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  const message = onRenameGroup(activeGroup.id, event.currentTarget.value);
                  if (message) setError(message);
                  else {
                    setRenaming(false);
                    setError(null);
                  }
                }
                if (event.key === "Escape") setRenaming(false);
              }}
              onBlur={() => setRenaming(false)}
              className="h-6 min-w-0 flex-1 rounded-md border border-border bg-card px-1.5 text-[11px] outline-none focus:border-accent/60"
            />
          ) : (
            <>
              {activeGroup && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setRenaming(true);
                      setError(null);
                    }}
                    className="rounded px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                  >
                    {t("重命名")}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteGroup(activeGroup.id)}
                    className="rounded px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-negative-soft hover:text-negative-text"
                  >
                    {t("删除分组")}
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={members.length === 0 || Boolean(batch?.running)}
                onClick={() => onBatchBacktest(activeGroupId)}
                className="ml-auto inline-flex h-6 items-center gap-1 rounded-md border border-accent/40 bg-accent-soft px-2 text-[10.5px] font-medium text-accent transition-colors hover:border-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("回测本组")}
              </button>
            </>
          )}
        </div>
      )}

      {error && <p className="mt-1 text-[10px] leading-4 text-negative-text">{t(error)}</p>}
      {batch?.running && (
        <p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="h-2 w-2 animate-spin rounded-full border border-accent border-t-transparent" />
          {t("回测中")} {batch.done}/{batch.total}
        </p>
      )}

      <div className="mt-2 max-h-[248px] space-y-1 overflow-y-auto pr-0.5 scroll-thin">
        {members.length === 0 ? (
          <p className="py-1 text-[10px] leading-4 text-muted-foreground/70">
            {activeGroup ? t("该分组还没有标的") : t("搜索并选择一个标的后会记录在这里")}
          </p>
        ) : (
          members.map((symbol) => {
            const active = symbol === currentSymbol;
            return (
              <div
                key={symbol}
                className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 transition-colors ${
                  active ? "border-accent/50 bg-accent-soft/40" : "border-transparent hover:bg-hover"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(symbol)}
                  aria-pressed={active}
                  title={t("点击切换回测标的")}
                  className={`num w-[62px] shrink-0 truncate text-left text-[11.5px] ${
                    active ? "font-medium text-accent" : "text-foreground/85"
                  }`}
                >
                  {symbol}
                </button>
                <select
                  value={library.assignment[symbol] ?? ""}
                  onChange={(event) => onAssign(symbol, event.target.value || null)}
                  aria-label={t("设置分组")}
                  title={t("设置分组")}
                  className="h-5 min-w-0 flex-1 truncate rounded border border-transparent bg-transparent px-0.5 text-[10px] text-muted-foreground outline-none transition-colors hover:border-border focus:border-accent/60"
                >
                  <option value="">{t("未分组")}</option>
                  {library.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onRemove(symbol)}
                  aria-label={`${symbol} ${t("移除")}`}
                  title={t("移除")}
                  className="shrink-0 rounded px-0.5 text-[12px] leading-none text-muted-foreground/70 transition-colors hover:bg-hover hover:text-negative-text"
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
