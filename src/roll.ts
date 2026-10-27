import { RollDie, RollMessage } from "./types";

export interface KeepSpec {
  mode: "h" | "l";
  n: number;
}

/** 拆分骰值：返回保留的值与被丢弃的值（按投掷顺序的成员关系） */
export function keptValues(
  dice: RollDie[],
  keep?: KeepSpec
): { kept: number[]; dropped: number[] } {
  const vals = dice.map((d) => d.value);
  if (!keep || keep.n >= vals.length) return { kept: vals, dropped: [] };
  const sorted = [...vals].sort((a, b) => (keep.mode === "h" ? b - a : a - b));
  const kept = sorted.slice(0, keep.n);
  const keptCopy = [...kept];
  const dropped: number[] = [];
  for (const v of vals) {
    const idx = keptCopy.indexOf(v);
    if (idx >= 0) keptCopy.splice(idx, 1);
    else dropped.push(v);
  }
  return { kept, dropped };
}

export function rollTotal(dice: RollDie[], bonus: number, keep?: KeepSpec): number {
  const { kept } = keptValues(dice, keep);
  return kept.reduce((s, v) => s + v, 0) + bonus;
}

const KEEP_SUFFIX: Record<string, string> = {
  h1: "（优势）",
  l1: "（劣势）",
};

/** keep 描述后缀，如"（优势）""（取高3）" */
export function keepSuffix(keep?: KeepSpec): string {
  if (!keep) return "";
  const s = `${keep.mode}${keep.n}`;
  if (KEEP_SUFFIX[s]) return KEEP_SUFFIX[s];
  return keep.mode === "h" ? `（取高${keep.n}）` : `（取低${keep.n}）`;
}

/** 骰子记法文本，如 "2d20+6" */
export function diceNotation(dice: RollDie[], bonus: number, keep?: KeepSpec): string {
  const groups: { type: string; count: number }[] = [];
  for (const die of dice) {
    const g = groups.find((g) => g.type === die.type);
    if (g) g.count++;
    else groups.push({ type: die.type, count: 1 });
  }
  let notation = groups.map((g) => `${g.count}${g.type.toLowerCase()}`).join(" + ");
  if (keep && keep.n < groups.reduce((s, g) => s + g.count, 0)) {
    notation += keep.mode === "h" ? `kh${keep.n}` : `kl${keep.n}`;
  }
  if (bonus !== 0) notation += bonus > 0 ? `+${bonus}` : `${bonus}`;
  return notation;
}

/** 标题文本，如 "生存（优势）" 或 "掷骰" */
export function rollTitle(label?: string, keep?: KeepSpec): string {
  return (label || "掷骰") + keepSuffix(keep);
}

/** 单颗 d20 判定：大成功 / 大失败 */
export function nat20Result(
  dice: RollDie[],
  keep?: KeepSpec
): "crit" | "fail" | null {
  if (keep) return null;
  if (dice.length !== 1 || dice[0].type !== "D20") return null;
  if (dice[0].value === 20) return "crit";
  if (dice[0].value === 1) return "fail";
  return null;
}

/** 导出 BBCode 用：骰值表达式，如 "[b]17[/b] + [s][color=gray]8[/color][/s] + 6" */
export function bbcodeDiceExpr(msg: RollMessage): string {
  const { kept } = keptValues(msg.dice, msg.keep);
  const keptCopy = [...kept];
  const parts = msg.dice.map((d) => {
    const idx = keptCopy.indexOf(d.value);
    if (idx >= 0) {
      keptCopy.splice(idx, 1);
      return `[b]${d.value}[/b]`;
    }
    return `[s][color=gray]${d.value}[/color][/s]`;
  });
  if (msg.bonus !== 0) {
    parts.push(msg.bonus > 0 ? `+${msg.bonus}` : `${msg.bonus}`);
  }
  return parts.join(" + ");
}
