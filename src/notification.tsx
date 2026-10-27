import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import OBR from "@owlbear-rodeo/sdk";
import { ChatMessage } from "./types";
import { diceNotation, keptValues, nat20Result, rollTitle, rollTotal } from "./roll";

const NOTIF_ID = "com.hootchat/notification";
const NOTIF_UPDATE_CHANNEL = "com.hootchat/notif-update";
const NOTIF_READY_CHANNEL = "com.hootchat/notif-ready";
const NOTIF_DISMISS_CHANNEL = "com.hootchat/notif-dismiss";

function hexLuminance(hex: string): number {
  const m = hex.replace("#", "").match(/.{2}/g);
  if (!m || m.length < 3) return 1;
  const [r, g, b] = m.map((x) => {
    const s = parseInt(x, 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function RollText({ msg }: { msg: Extract<ChatMessage, { type: "roll" }> }) {
  const { kept } = keptValues(msg.dice, msg.keep);
  const keptCopy = [...kept];
  const total = rollTotal(msg.dice, msg.bonus, msg.keep);
  const nat = nat20Result(msg.dice, msg.keep);

  return (
    <>
      <span style={{ fontStyle: "italic" }}>🎲 {rollTitle(msg.label, msg.keep)} </span>
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
    </>
  );
}

function NotifCard({
  msg,
  onDismiss,
}: {
  msg: ChatMessage;
  onDismiss: () => void;
}) {
  const dark = hexLuminance(msg.playerColor) < 0.1;
  const isOoc = msg.type === "text" && !!msg.ooc;
  return (
    <div
      style={{
        background: "rgba(26, 26, 46, 0.95)",
        border: "1px solid rgba(91, 91, 214, 0.4)",
        borderRadius: "8px",
        padding: "8px 8px 8px 14px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap: "4px 6px",
        userSelect: "none",
        ...(isOoc && { opacity: 0.5 }),
      }}
    >
      <span
        style={{
          color: msg.playerColor,
          fontWeight: 800,
          fontSize: "13px",
          whiteSpace: "nowrap",
          flexShrink: 0,
          ...(dark && {
            background: "rgba(255,255,255,0.30)",
            borderRadius: "3px",
            padding: "0 3px",
          }),
        }}
      >
        {msg.playerName}
      </span>
      <span
        style={{
          color: isOoc ? "#909090" : "#d0d0d0",
          fontSize: isOoc ? "12px" : "13px",
          flex: 1,
          minWidth: "60%",
          wordBreak: "break-word",
          whiteSpace: "pre-wrap",
        }}
      >
        {msg.type === "roll" ? <RollText msg={msg} /> : msg.text}
      </span>
      <button
        onClick={onDismiss}
        style={{
          background: "none",
          border: "none",
          color: "#555",
          cursor: "pointer",
          fontSize: "18px",
          lineHeight: 1,
          padding: "0 0 0 4px",
          flexShrink: 0,
          alignSelf: "flex-start",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "#aaa")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "#555")}
      >
        ×
      </button>
    </div>
  );
}

function NotificationApp() {
  const [queue, setQueue] = useState<ChatMessage[]>([]);
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    OBR.onReady(() => {
      unsub = OBR.broadcast.onMessage(NOTIF_UPDATE_CHANNEL, (event) => {
        if (!Array.isArray(event.data)) return;
        setQueue(event.data as ChatMessage[]);
      });
      // Signal background.ts that we're ready to receive the current state.
      OBR.broadcast.sendMessage(NOTIF_READY_CHANNEL, null, { destination: "LOCAL" }).catch(console.error);
    });
    return () => unsub?.();
  }, []);

  // Resize popover to fit content. Keep content hidden until setHeight resolves
  // so OBR doesn't flash the content at the wrong size before repositioning.
  useEffect(() => {
    if (queue.length === 0) {
      setVisible(false);
    } else {
      const h = containerRef.current?.offsetHeight ?? 0;
      OBR.onReady(() =>
        OBR.popover.setHeight(NOTIF_ID, h || 1)
          .then(() => setVisible(true))
          .catch(console.error)
      );
    }
  }, [queue]);

  const dismiss = (id: string) =>
    OBR.broadcast.sendMessage(NOTIF_DISMISS_CHANNEL, id, { destination: "LOCAL" }).catch(console.error);

  if (queue.length === 0) return null;

  return (
    <div
      ref={containerRef}
      style={{ display: "flex", flexDirection: "column", gap: "4px", visibility: visible ? "visible" : "hidden" }}
    >
      {queue.map((msg) => (
        <NotifCard key={msg.id} msg={msg} onDismiss={() => dismiss(msg.id)} />
      ))}
    </div>
  );
}

document.body.style.cssText =
  "margin:0;padding:0;background:transparent;overflow:hidden;" +
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px";

createRoot(document.getElementById("root")!).render(<NotificationApp />);
