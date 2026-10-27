import { useEffect, useRef, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";
import { ChatMessage, RollDie, RollMessage } from "./types";
import {
  KeepSpec,
  bbcodeDiceExpr,
  diceNotation,
  keptValues,
  nat20Result,
  rollTitle,
  rollTotal,
} from "./roll";

const DICE_PREFIX = "rodeo.owlbear.dice/";
const CHAT_STATUS_CHANNEL = "com.hootchat/chat-status";
const STATUS_REQUEST_CHANNEL = "com.hootchat/status-request";
const MSG_BROADCAST_CHANNEL = "com.hootchat/message";
const CLEAR_CHANNEL = "com.hootchat/clear";
const HISTORY_KEY = "com.hootchat/history";
const HISTORY_MAX_BYTES = 4 * 1024;

// --- helpers ---

function hexLuminance(hex: string): number {
  const m = hex.replace("#", "").match(/.{2}/g);
  if (!m || m.length < 3) return 1;
  const [r, g, b] = m.map((x) => {
    const s = parseInt(x, 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function nameStyle(color: string): React.CSSProperties {
  return hexLuminance(color) < 0.1
    ? {
        color,
        background: "rgba(255,255,255,0.30)",
        borderRadius: "3px",
        padding: "0 3px",
      }
    : { color };
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function msgKey(m: ChatMessage): string {
  return m.id;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// --- 掷骰解析 ---

interface ParsedRoll {
  dice: RollDie[];
  bonus: number;
  keep?: KeepSpec;
  label?: string;
}

const DIE_TOKEN = /^([+-]?)(\d*)d(\d+)(kh|kl|dh|dl)?(\d+)?$/i;
const NUM_TOKEN = /^[+-]?\d+$/;
const TOKEN_SCAN = /[+-]?\d*d\d+(?:kh|kl|dh|dl)?\d*|[+-]?\d+/gi;

/** 从输入中提取所有骰子/数字 token（表达式）与末尾检定名 */
function splitLabel(input: string): { expr: string; label?: string } {
  const s = input.trim();
  let expr = "";
  let labelStart = -1;
  let lastIndex = 0;
  s.replace(TOKEN_SCAN, (m: string, offset: number) => {
    // token 之间的间隙文字（非空白）意味着检定名出现在这里
    const gap = s.slice(lastIndex, offset);
    if (gap.trim() !== "" && labelStart < 0) labelStart = lastIndex;
    if (labelStart < 0) expr += m;
    lastIndex = offset + m.length;
    return m;
  });
  if (labelStart >= 0) {
    // 检定名在中间：其后的 token 也归入检定名
    return {
      expr: s.slice(0, labelStart).replace(/\s+/g, ""),
      label: s.slice(labelStart).trim(),
    };
  }
  const tail = s.slice(lastIndex);
  const label = tail.trim() !== "" ? tail.trim() : undefined;
  return { expr: expr.replace(/\s+/g, ""), label };
}

/** 解析 "2d6+3"、"1d20+6 生存"、"2d20kh1+5"、"4d6dl1" */
function parseAndRoll(notation: string): ParsedRoll | null {
  const { expr, label } = splitLabel(notation);
  if (!expr) return null;

  const tokens = expr.split(/(?=[+-])/).filter(Boolean);
  const dice: RollDie[] = [];
  let bonus = 0;
  let firstKeep: KeepSpec | undefined;
  let keepSeen = false;

  for (const token of tokens) {
    const sign = token.startsWith("-") ? -1 : 1;
    const part = token.replace(/^[+-]/, "");

    const diceMatch = part.match(DIE_TOKEN);
    if (diceMatch) {
      if (sign < 0) return null; // 负数骰组不支持
      const count = parseInt(diceMatch[2] || "1");
      const sides = parseInt(diceMatch[3]);
      if (count < 1 || count > 100 || sides < 2 || sides > 10000) return null;

      // keep/drop 规范化为 { mode, n }
      let keep: KeepSpec | undefined;
      const op = diceMatch[4]?.toLowerCase();
      const opN = diceMatch[5] ? parseInt(diceMatch[5]) : 1;
      if (op) {
        if (op === "kh" || op === "kl") {
          keep = { mode: op === "kh" ? "h" : "l", n: Math.min(Math.max(1, opN), count) };
        } else {
          // dl N：丢低 N 颗 = 取高 count-N；dh N：丢高 N 颗 = 取低 count-N
          const keepN = count - opN;
          if (keepN < 1) return null;
          keep = { mode: op === "dl" ? "h" : "l", n: Math.min(keepN, count) };
        }
        if (keep.n >= count) keep = undefined;
      }

      const type = `D${sides}`;
      for (let i = 0; i < count; i++) {
        dice.push({ type, value: Math.ceil(Math.random() * sides) });
      }
      // 同一表达式只取第一个 keep 参数，简化处理
      if (!keepSeen) {
        firstKeep = keep;
        keepSeen = true;
      }
      continue;
    }

    const num = parseInt(part);
    if (isNaN(num)) return null;
    bonus += sign * num;
  }

  if (dice.length === 0) return null;
  return { dice, bonus, keep: firstKeep, label };
}

/** 优势/劣势：等价于 2d20kh1 / 2d20kl1 */
function parseAdvDis(args: string, mode: "h" | "l"): ParsedRoll | null {
  const { expr, label } = splitLabel(args);
  if (expr && !NUM_TOKEN.test(expr)) return null;
  const bonus = expr ? parseInt(expr) : 0;
  if (isNaN(bonus)) return null;
  const dice: RollDie[] = [
    { type: "D20", value: Math.ceil(Math.random() * 20) },
    { type: "D20", value: Math.ceil(Math.random() * 20) },
  ];
  return { dice, bonus, keep: { mode, n: 1 }, label };
}

type RollKind = "roll" | "adv" | "dis";

/** 解析一条完整的骰子指令输入，如 "/r d20+6 长剑命中"、"/adv +6 察觉" */
function parseRollInput(input: string): { kind: RollKind; parsed: ParsedRoll } | null {
  const cmd = input
    .replace(/^\/advantage\b/i, "/adv")
    .replace(/^\/disadvantage\b/i, "/dis");
  if (/^\/(r|roll)(\s|$)/i.test(cmd)) {
    const rest = cmd.replace(/^\/(r|roll)\s*/i, "");
    const parsed = parseAndRoll(rest);
    return parsed ? { kind: "roll", parsed } : null;
  }
  if (/^\/adv(\s|$)/i.test(cmd)) {
    const parsed = parseAdvDis(cmd.replace(/^\/adv\s*/i, ""), "h");
    return parsed ? { kind: "adv", parsed } : null;
  }
  if (/^\/dis(\s|$)/i.test(cmd)) {
    const parsed = parseAdvDis(cmd.replace(/^\/dis\s*/i, ""), "l");
    return parsed ? { kind: "dis", parsed } : null;
  }
  return null;
}

// --- 掷骰渲染（聊天窗口）---

function RollDisplay({ msg }: { msg: RollMessage }) {
  const { kept } = keptValues(msg.dice, msg.keep);
  const keptCopy = [...kept];
  const total = rollTotal(msg.dice, msg.bonus, msg.keep);
  const nat = nat20Result(msg.dice, msg.keep);

  return (
    <span>
      {msg.text && <span>{msg.text} </span>}
      <span style={{ color: "#888" }}>🎲 </span>
      <span style={{ color: "#888", fontStyle: "italic" }}>{rollTitle(msg.label, msg.keep)} </span>
      <span style={{ color: "#555" }}>{diceNotation(msg.dice, 0, msg.keep)}： </span>
      {msg.dice.map((d, i) => {
        const idx = keptCopy.indexOf(d.value);
        const isKept = idx >= 0;
        if (isKept) keptCopy.splice(idx, 1);
        return (
          <span key={i}>
            {i > 0 && <span style={{ color: "#555" }}> + </span>}
            <span
              style={{
                fontWeight: isKept ? 700 : 400,
                color: isKept ? undefined : "#555",
                textDecoration: isKept ? undefined : "line-through",
              }}
            >
              {d.value}
            </span>
          </span>
        );
      })}
      {msg.bonus !== 0 && (
        <span style={{ color: "#888" }}>
          {" "}
          {msg.bonus > 0 ? "+" : "-"} {Math.abs(msg.bonus)}
        </span>
      )}
      <span style={{ color: "#555" }}> = </span>
      <span style={{ color: "#a78bfa", fontWeight: 700 }}>{total}</span>
      {nat === "crit" && (
        <>
          {" "}
          <span style={{ color: "#fbbf24", fontWeight: 700 }}>🎉 大成功！</span>
        </>
      )}
      {nat === "fail" && (
        <>
          {" "}
          <span style={{ color: "#ef4444", fontWeight: 700 }}>💀 大失败…</span>
        </>
      )}
    </span>
  );
}

// --- 导出 BBCode ---

function formatMsgBBCode(m: ChatMessage): string | null {
  if (m.type === "text") {
    if (m.ooc) return null;
    return `[color=silver]<${m.playerName}>[/color] [color=${m.playerColor}]${m.text}[/color]`;
  }
  const total = rollTotal(m.dice, m.bonus, m.keep);
  const nat = nat20Result(m.dice, m.keep);
  const natText = nat === "crit" ? " 🎉大成功" : nat === "fail" ? " 💀大失败" : "";
  const rollPart =
    `🎲 [i]${rollTitle(m.label, m.keep)} ${diceNotation(m.dice, 0, m.keep)}：` +
    `${bbcodeDiceExpr(m)} = [b]${total}[/b]${natText}[/i]`;
  if (m.text) {
    return (
      `[color=silver]<${m.playerName}>[/color] ` +
      `[color=${m.playerColor}]${m.text} ${rollPart}[/color]`
    );
  }
  return (
    `[color=silver]<${m.playerName}>[/color] ` +
    `[color=${m.playerColor}]${rollPart}[/color]`
  );
}

function exportBBCode(messages: ChatMessage[]) {
  const lines = messages
    .map(formatMsgBBCode)
    .filter((l): l is string => l !== null);
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  a.href = url;
  a.download = `hoot-chat-记录-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// --- component ---

export default function App() {
  const [ready, setReady] = useState(false);
  const [allMessages, setAllMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [helpEntries, setHelpEntries] = useState<{ anchorId: string; key: number }[]>([]);
  const [clearArmed, setClearArmed] = useState(false);

  const playerIdRef = useRef("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastRollFingerprintRef = useRef<string | null>(null);
  const allMessagesRef = useRef<ChatMessage[]>([]);
  const seenRef = useRef(new Set<string>());
  const isHostRef = useRef(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function writeHistory(messages: ChatMessage[]) {
    if (!isHostRef.current) return;
    // Serialize each message once, then scan from the end to find how many fit
    const parts = messages.map((m) => JSON.stringify(m));
    let bytes = 2; // [ and ]
    let start = parts.length;
    for (let i = parts.length - 1; i >= 0; i--) {
      bytes += parts[i].length + (start < parts.length ? 1 : 0); // +1 for comma
      if (bytes > HISTORY_MAX_BYTES) break;
      start = i;
    }
    OBR.room.setMetadata({ [HISTORY_KEY]: messages.slice(start) }).catch(console.error);
  }

  function updatePlayerInfo(playerId: string, name: string, color: string) {
    const updated = allMessagesRef.current.map((m) =>
      m.playerId === playerId ? { ...m, playerName: name, playerColor: color } : m
    );
    allMessagesRef.current = updated;
    setAllMessages(updated);
    writeHistory(updated);
  }

  function addMessages(incoming: ChatMessage[]) {
    const newMsgs = incoming.filter((m) => !seenRef.current.has(msgKey(m)));
    if (newMsgs.length === 0) return;
    newMsgs.forEach((m) => seenRef.current.add(msgKey(m)));
    const updated = [...allMessagesRef.current, ...newMsgs];
    allMessagesRef.current = updated;
    setAllMessages(updated);
    writeHistory(updated);
  }

  function clearAll() {
    seenRef.current.clear();
    allMessagesRef.current = [];
    setAllMessages([]);
    writeHistory([]);
    OBR.broadcast.sendMessage(CLEAR_CHANNEL, null).catch(console.error);
  }

  const sendOpen = () =>
    OBR.broadcast
      .sendMessage(CHAT_STATUS_CHANNEL, "open", { destination: "LOCAL" })
      .catch(console.error);

  const sendClosed = () =>
    OBR.broadcast
      .sendMessage(CHAT_STATUS_CHANNEL, "closed", { destination: "LOCAL" })
      .catch(console.error);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    OBR.onReady(async () => {
      const isOpen = await OBR.action.isOpen();
      if (isOpen) sendOpen();

      unsubs.push(OBR.action.onOpenChange((open) => {
        if (open) sendOpen(); else sendClosed();
      }));

      unsubs.push(
        OBR.broadcast.onMessage(STATUS_REQUEST_CHANNEL, async () => {
          if (await OBR.action.isOpen()) sendOpen();
        })
      );

      playerIdRef.current = await OBR.player.getId();
      const playerNameSnapshot = await OBR.player.getName();
      const playerColorSnapshot = await OBR.player.getColor();

      // Load history from metadata for cold-start scrollback
      const meta = await OBR.room.getMetadata();
      const history = Array.isArray(meta[HISTORY_KEY]) ? (meta[HISTORY_KEY] as ChatMessage[]) : [];
      addMessages(history);

      // Determine initial host (player with lexicographically lowest ID)
      const party = await OBR.party.getPlayers();
      const allIds = [playerIdRef.current, ...party.map((p) => p.id)];
      isHostRef.current = playerIdRef.current === [...allIds].sort()[0];


      // Receive messages from other clients (and echoed own messages)
      unsubs.push(OBR.broadcast.onMessage(MSG_BROADCAST_CHANNEL, (event) => {
        if (event.data) addMessages([event.data as ChatMessage]);
      }));

      // Receive clear requests from other clients
      unsubs.push(OBR.broadcast.onMessage(CLEAR_CHANNEL, () => {
        seenRef.current.clear();
        allMessagesRef.current = [];
        setAllMessages([]);
        writeHistory([]);
      }));

      unsubs.push(
        OBR.party.onChange((party) => {
          const allIds = [playerIdRef.current, ...party.map((p) => p.id)];
          isHostRef.current = playerIdRef.current === [...allIds].sort()[0];
          for (const p of party) updatePlayerInfo(p.id, p.name, p.color);
        })
      );

      let lastName = playerNameSnapshot;
      let lastColor = playerColorSnapshot;
      unsubs.push(
        OBR.player.onChange((player) => {
          if (player.name === lastName && player.color === lastColor) return;
          lastName = player.name;
          lastColor = player.color;
          updatePlayerInfo(playerIdRef.current, player.name, player.color);
        })
      );

      unsubs.push(
        OBR.player.onChange((player) => {
          const rawValues = player.metadata[DICE_PREFIX + "rollValues"] as
            | Record<string, number | null>
            | undefined;
          if (!rawValues) {
            lastRollFingerprintRef.current = null;
            return;
          }

          const entries = Object.entries(rawValues);
          if (entries.length === 0) return;

          if (entries.some(([, v]) => v === null)) {
            lastRollFingerprintRef.current = null;
            return;
          }

          const values = rawValues as Record<string, number>;

          type RawDie = { id: string; type: string } | { dice: Array<{ id: string; type: string }> };
          const rawRoll = player.metadata[DICE_PREFIX + "roll"] as
            | {
                dice: Array<RawDie>;
                bonus: number;
                hidden: boolean;
                specialRollData?: { type: string; bonus: number; netEdges: number; hasSkill?: boolean };
              }
            | undefined;
          if (!rawRoll || rawRoll.hidden) return;

          const fingerprint = entries
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, v]) => `${id}:${v}`)
            .join(",");
          if (fingerprint === lastRollFingerprintRef.current) return;
          lastRollFingerprintRef.current = fingerprint;

          const dice: RollDie[] = rawRoll.dice.flatMap((d) => {
            if ("dice" in d) {
              // Grouped die (d100): inner D100 gives tens (0,10,…,90), inner D10 gives ones (0–9).
              // Sum to 0 is the conventional 100.
              const sum = d.dice.reduce((acc, inner) => acc + (values[inner.id] ?? 0), 0);
              return [{ type: "D100", value: sum === 0 ? 100 : sum }];
            }
            const flat = d as { id: string; type: string };
            const raw = values[flat.id];
            // D10 encodes a result of 10 as 0
            const value = flat.type === "D10" && raw === 0 ? 10 : raw;
            return [{ type: flat.type, value }];
          });
          // 官方骰子的 Draw Steel power roll 不再特殊处理，按普通骰子展示
          const bonus = rawRoll.specialRollData?.type === "POWER_ROLL"
            ? (rawRoll.specialRollData?.bonus ?? 0)
            : rawRoll.bonus;
          sendRoll(dice, bonus).catch(console.error);
        })
      );

      setReady(true);
    });

    return () => {
      unsubs.forEach((u) => u());
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [ready]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [allMessages[allMessages.length - 1]?.id]);

  useEffect(() => {
    if (helpEntries.length > 0) bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [helpEntries.length]);

  async function sendMessage() {
    const text = input.trim();
    if (!text) return;

    if (text === "/help" || text === "/h") {
      setHelpEntries((prev) => [...prev, { anchorId: allMessagesRef.current[allMessagesRef.current.length - 1]?.id ?? "", key: Date.now() }]);
      setInput("");
      return;
    }

    // 场外发言：// 开头，暗化显示，不参与导出
    if (text.startsWith("//")) {
      const oocText = text.slice(2).trim();
      if (!oocText) return;
      setInput("");
      const msg: ChatMessage = {
        id: newId(),
        playerId: playerIdRef.current,
        playerName: await OBR.player.getName(),
        playerColor: await OBR.player.getColor(),
        type: "text",
        text: oocText,
        ooc: true,
        timestamp: Date.now(),
      };
      addMessages([msg]);
      OBR.broadcast.sendMessage(MSG_BROADCAST_CHANNEL, msg).catch(console.error);
      return;
    }

    if (text === "/clear") {
      setInput("");
      armClear();
      return;
    }

    if (text.startsWith("/")) {
      const result = parseRollInput(text);
      if (!result) return; // 未知指令：不发送
      setInput("");
      const p = result.parsed;
      sendRoll(p.dice, p.bonus, p.keep, p.label).catch(console.error);
      return;
    }

    // 行内骰指令：指令前有叙述文字，如"玛格丽特拔剑 /r d20+6 长剑命中"
    const inlineMatch = text.match(/(?:^|\s)\/(?:r|roll|adv|advantage|dis|disadvantage)(?=\s|$)/i);
    if (inlineMatch && inlineMatch.index !== undefined && inlineMatch.index > 0) {
      const prefix = text.slice(0, inlineMatch.index).trim();
      const result = parseRollInput(text.slice(inlineMatch.index).trim());
      if (result) {
        setInput("");
        const p = result.parsed;
        sendRoll(p.dice, p.bonus, p.keep, p.label, prefix).catch(console.error);
        return;
      }
      // 解析失败 → 落回普通文本消息
    }

    setInput("");

    const msg: ChatMessage = {
      id: newId(),
      playerId: playerIdRef.current,
      playerName: await OBR.player.getName(),
      playerColor: await OBR.player.getColor(),
      type: "text",
      text,
      timestamp: Date.now(),
    };

    addMessages([msg]);
    OBR.broadcast.sendMessage(MSG_BROADCAST_CHANNEL, msg).catch(console.error);
  }

  async function sendRoll(dice: RollDie[], bonus: number, keep?: KeepSpec, label?: string, text?: string) {
    const msg: RollMessage = {
      id: newId(),
      playerId: playerIdRef.current,
      playerName: await OBR.player.getName(),
      playerColor: await OBR.player.getColor(),
      type: "roll",
      dice,
      bonus,
      ...(keep && { keep }),
      ...(label && { label }),
      ...(text && { text }),
      timestamp: Date.now(),
    };

    addMessages([msg]);
    OBR.broadcast.sendMessage(MSG_BROADCAST_CHANNEL, msg).catch(console.error);
  }

  function armClear() {
    if (clearArmed) {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      setClearArmed(false);
      clearAll();
      return;
    }
    setClearArmed(true);
    clearTimerRef.current = setTimeout(() => setClearArmed(false), 5000);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  if (!ready) {
    return <div style={styles.loading}>连接中…</div>;
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <button style={styles.toolButton} onClick={() => exportBBCode(allMessages)}>
          导出
        </button>
        <button
          style={{ ...styles.toolButton, ...(clearArmed ? styles.toolButtonDanger : {}) }}
          onClick={armClear}
        >
          {clearArmed ? "确认清空？" : "清空"}
        </button>
      </div>
      <div style={styles.messageList}>
        {allMessages.length === 0 && helpEntries.length === 0 && (
          <div style={styles.empty}>还没有消息，打个招呼吧！</div>
        )}
        {(() => {
          // Build a map from anchorId -> help keys to insert after that message.
          // anchorId "" means insert before all messages.
          const helpAfter = new Map<string, number[]>();
          for (const { anchorId, key } of helpEntries) {
            const list = helpAfter.get(anchorId) ?? [];
            list.push(key);
            helpAfter.set(anchorId, list);
          }
          const helpCard = (key: number) => (
            <div key={`help-${key}`} style={styles.helpCard}>
              <div style={styles.helpHeader}>
                <span style={styles.helpTitle}>指令</span>
              </div>
              <div style={styles.helpSection}>
                <div><code style={styles.helpCmd}>/roll</code> <span style={styles.helpAlias}>（或 /r）</span>掷骰</div>
                <div style={styles.helpIndent}>
                  <div style={styles.helpExample}>/roll 2d6+3 &nbsp;·&nbsp; /r 1d20+6 生存 &nbsp;·&nbsp; /r 4d6dl1</div>
                  <div>NdX 骰子 · ±N 修正 · 末尾文字为检定名（斜体显示）</div>
                  <div>指令也可以嵌在句子中：玛格丽特拔剑 /r d20+6 长剑命中</div>
                  <div style={styles.helpOptions}>
                    <span><code style={styles.helpCmd}>khN</code> 取最高 N 颗 &nbsp;·&nbsp; <code style={styles.helpCmd}>klN</code> 取最低 N 颗</span>
                    <span><code style={styles.helpCmd}>dlN</code> 丢弃最低 N 颗 &nbsp;·&nbsp; <code style={styles.helpCmd}>dhN</code> 丢弃最高 N 颗</span>
                  </div>
                </div>
              </div>
              <div style={styles.helpSection}>
                <div><code style={styles.helpCmd}>/adv</code> &nbsp;/&nbsp; <code style={styles.helpCmd}>/dis</code> 优势 / 劣势</div>
                <div style={styles.helpIndent}>
                  <div style={styles.helpExample}>/adv +6 察觉 &nbsp;·&nbsp; /dis +2</div>
                  <div>掷 2 颗 d20 取高 / 取低，等价于 /r 2d20kh1+6</div>
                  <div style={styles.helpOptions}>
                    <span>单独掷出 20 → 🎉 大成功；掷出 1 → 💀 大失败</span>
                  </div>
                </div>
              </div>
              <div style={styles.helpSection}>
                <div><code style={styles.helpCmd}>//文字</code> 场外发言</div>
                <div style={styles.helpIndent}>
                  <div style={styles.helpExample}>// 今天先打到这</div>
                  <div>消息会变暗缩小，且不参与「导出记录」</div>
                </div>
              </div>
              <div style={styles.helpSection}>
                <div><code style={styles.helpCmd}>/clear</code> 清空全部聊天记录（与上方按钮相同，需二次确认）</div>
              </div>
            </div>
          );
          const items: React.ReactNode[] = [];
          for (const key of helpAfter.get("") ?? []) items.push(helpCard(key));
          for (const msg of allMessages) {
            const isOoc = msg.type === "text" && !!msg.ooc;
            items.push(
              <div
                key={msg.id}
                style={{
                  ...styles.message,
                  ...(isOoc ? styles.oocMessage : {}),
                }}
              >
                <span style={{ ...styles.name, ...nameStyle(msg.playerColor) }}>
                  {msg.playerName}
                </span>
                <span style={styles.time}>{formatTime(msg.timestamp)}</span>
                <div
                  style={{
                    ...styles.text,
                    ...(isOoc ? styles.oocText : {}),
                  }}
                >
                  {msg.type === "roll" ? <RollDisplay msg={msg} /> : msg.text}
                </div>
              </div>
            );
            for (const key of helpAfter.get(msg.id) ?? []) items.push(helpCard(key));
          }
          return items;
        })()}
        <div ref={bottomRef} />
      </div>
      <div style={styles.inputRow}>
        <input
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息…（// 开头为场外发言）"
          maxLength={500}
          autoFocus
        />
        <button style={styles.button} onClick={sendMessage}>
          发送
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    position: "relative",
  },
  loading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    color: "#888",
  },
  toolbar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    display: "flex",
    gap: "8px",
    padding: "8px 12px",
    background: "rgba(18, 18, 30, 0.55)",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
    borderBottom: "1px solid rgba(42, 42, 74, 0.6)",
  },
  toolButton: {
    background: "#5b5bd6",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    padding: "4px 12px",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "12px",
  },
  toolButtonDanger: {
    background: "#ef4444",
  },
  messageList: {
    flex: 1,
    overflowY: "auto",
    padding: "48px 12px 12px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  empty: {
    color: "#666",
    textAlign: "center",
    marginTop: "40px",
  },
  helpCard: {
    background: "rgba(91, 91, 214, 0.12)",
    border: "1px solid rgba(91, 91, 214, 0.35)",
    borderRadius: "8px",
    padding: "10px 12px",
    fontSize: "13px",
    color: "#aaa",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  helpHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  helpTitle: {
    color: "#c4b5fd",
    fontWeight: 700,
    fontSize: "14px",
  },
  helpSection: {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
  },
  helpCmd: {
    color: "#c4b5fd",
    fontFamily: "monospace",
    background: "rgba(196,181,253,0.1)",
    borderRadius: "3px",
    padding: "0 3px",
  },
  helpAlias: {
    color: "#666",
    fontSize: "12px",
  },
  helpIndent: {
    paddingLeft: "10px",
    display: "flex",
    flexDirection: "column",
    gap: "3px",
  },
  helpExample: {
    color: "#666",
    fontFamily: "monospace",
    fontSize: "12px",
  },
  helpOptions: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    fontSize: "12px",
    color: "#666",
  },
  message: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gridTemplateRows: "auto auto",
    gap: "2px 8px",
  },
  oocMessage: {
    opacity: 0.45,
  },
  oocText: {
    fontSize: "0.85em",
    color: "#909090",
  },
  name: {
    fontWeight: 800,
    fontSize: "12px",
    justifySelf: "start",
  },
  time: {
    color: "#666",
    fontSize: "11px",
    alignSelf: "center",
  },
  text: {
    gridColumn: "1 / -1",
    color: "#d0d0d0",
    lineHeight: 1.4,
    wordBreak: "break-word",
  },
  inputRow: {
    display: "flex",
    gap: "8px",
    padding: "10px",
    borderTop: "1px solid #2a2a4a",
    background: "#12121e",
  },
  input: {
    flex: 1,
    background: "#2a2a4a",
    border: "1px solid #3a3a5a",
    borderRadius: "6px",
    padding: "8px 10px",
    color: "#e0e0e0",
    fontSize: "14px",
    outline: "none",
  },
  button: {
    background: "#5b5bd6",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    padding: "8px 14px",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "13px",
  },
};
