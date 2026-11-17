"use client";

import { useRef, useState } from "react";

import { useI18n } from "@/lib/i18n";
import {
  ALL_SYMBOLS_ID,
  MAX_BACKTEST_GROUP_NAME,
  MAX_BACKTEST_GROUPS,
  UNGROUPED_SYMBOLS_ID,
  groupsOfSymbol,
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
  /** 勾选 / 取消勾选某个分组（同一标的可属于多个分组） */
  onToggleGroup: (symbol: string, groupId: string) => void;
  onClearGroups: (symbol: string) => void;
  /** 拖动标签调整分组顺序 */
  onMoveGroup: (fromId: string, toId: string) => void;
  onClear: () => void;
  /** 整组回测（只在真实分组上可用） */
  onBatchBacktest: (groupId: string) => void;
  batch: { running: boolean; done: number; total: number } | null;
}

const DRAG_THRESHOLD = 6;

/**
 * 回测标的库：最近搜索自动收集 + 自定义分组（可多选）+ 整组回测。
 * 分组标签支持左右拖动排序；每个标的可同时归入多个分组。
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
  onToggleGroup,
  onClearGroups,
  onMoveGroup,
  onClear,
  onBatchBacktest,
  batch,
}: SymbolLibraryProps) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  /** 正在编辑分组的标的（展开多选面板） */
  const [editingSymbol, setEditingSymbol] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
    overId: string | null;
  } | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
    overId: string | null;
  } | null>(null);

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

  function groupAtPoint(x: number, y: number): string | null {
    let bestId: string | null = null;
    let bestDistance = Infinity;
    for (const group of library.groups) {
      const element = tabRefs.current.get(group.id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      const distance = Math.hypot(
        x - (rect.left + rect.width / 2),
        (y - (rect.top + rect.height / 2)) * 2,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = group.id;
      }
    }
    return bestId;
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>, groupId: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    suppressClickRef.current = false;
    const next = {
      id: groupId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      overId: null,
    };
    dragRef.current = next;
    setDrag(next);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const current = dragRef.current;
    if (!current) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (event.cancelable) event.preventDefault();
    const next = { ...current, moved: true, overId: groupAtPoint(event.clientX, event.clientY) };
    dragRef.current = next;
    setDrag(next);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLButtonElement>, groupId: string) {
    const current = dragRef.current;
    if (!current) return;
    if (current.moved) {
      // 拖动结束后紧跟的 click 不应切换标签
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 250);
      if (current.overId && current.overId !== groupId) onMoveGroup(groupId, current.overId);
    }
    dragRef.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleGroupClick(groupId: string) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onActiveGroupChange(groupId);
    setRenaming(false);
    setError(null);
    setEditingSymbol(null);
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
          onClick={() => handleGroupClick(ALL_SYMBOLS_ID)}
          aria-pressed={activeGroupId === ALL_SYMBOLS_ID}
          className={tabClass(activeGroupId === ALL_SYMBOLS_ID)}
        >
          {t("所有标的")}
        </button>
        {library.groups.map((group) => {
          const dragging = drag?.id === group.id && drag.moved;
          const isOver = Boolean(drag?.moved && drag.overId === group.id && drag.id !== group.id);
          return (
            <button
              key={group.id}
              ref={(element) => {
                if (element) tabRefs.current.set(group.id, element);
                else tabRefs.current.delete(group.id);
              }}
              type="button"
              onPointerDown={(event) => handlePointerDown(event, group.id)}
              onPointerMove={handlePointerMove}
              onPointerUp={(event) => handlePointerUp(event, group.id)}
              onPointerCancel={() => {
                dragRef.current = null;
                setDrag(null);
              }}
              onClick={() => handleGroupClick(group.id)}
              aria-pressed={activeGroupId === group.id}
              title={`${group.name} · ${t("拖动调整分组顺序")}`}
              className={`${tabClass(activeGroupId === group.id)} cursor-grab touch-pan-y select-none active:cursor-grabbing ${
                dragging ? "opacity-50" : ""
              } ${isOver ? "ring-1 ring-accent/50" : ""}`}
            >
              <span className="truncate">{group.name}</span>
              <span className="num shrink-0 opacity-70">{symbolsOf(library, group.id).length}</span>
            </button>
          );
        })}
        {library.groups.length > 0 && symbolsOf(library, UNGROUPED_SYMBOLS_ID).length > 0 && (
          <button
            type="button"
            onClick={() => handleGroupClick(UNGROUPED_SYMBOLS_ID)}
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

      {library.groups.length > 1 && (
        <p className="mt-1 text-[9.5px] leading-3 text-muted-foreground/60">
          {t("拖动分组标签可调整顺序")}
        </p>
      )}

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
            const memberships = groupsOfSymbol(library, symbol);
            const editing = editingSymbol === symbol;
            return (
              <div
                key={symbol}
                className={`rounded-md border transition-colors ${
                  active ? "border-accent/50 bg-accent-soft/40" : "border-transparent"
                }`}
              >
                <div className="flex items-center gap-1 px-1.5 py-0.5">
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
                  <button
                    type="button"
                    onClick={() => setEditingSymbol(editing ? null : symbol)}
                    aria-expanded={editing}
                    aria-label={`${symbol} ${t("设置分组")}`}
                    title={t("设置分组")}
                    className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-[10px] transition-colors ${
                      editing
                        ? "bg-hover text-foreground"
                        : "text-muted-foreground hover:bg-hover hover:text-foreground"
                    }`}
                  >
                    {memberships.length === 0
                      ? t("未分组")
                      : `${memberships
                          .slice(0, 2)
                          .map((group) => group.name)
                          .join(" / ")}${memberships.length > 2 ? ` +${memberships.length - 2}` : ""}`}
                  </button>
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

                {editing && (
                  <div className="border-t border-border/60 px-1.5 py-1">
                    {library.groups.length === 0 ? (
                      <p className="text-[10px] leading-4 text-muted-foreground/70">
                        {t("先新建分组")}
                      </p>
                    ) : (
                      <div className="max-h-[132px] space-y-0.5 overflow-y-auto scroll-thin">
                        {library.groups.map((group) => (
                          <label
                            key={group.id}
                            className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[10.5px] text-foreground transition-colors hover:bg-hover"
                          >
                            <input
                              type="checkbox"
                              checked={memberships.some((item) => item.id === group.id)}
                              onChange={() => onToggleGroup(symbol, group.id)}
                              className="h-3 w-3 accent-[var(--accent)]"
                            />
                            <span className="truncate">{group.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {memberships.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onClearGroups(symbol)}
                        className="mt-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-negative-soft hover:text-negative-text"
                      >
                        {t("移出全部分组")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
