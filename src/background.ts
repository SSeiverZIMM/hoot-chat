import OBR from "@owlbear-rodeo/sdk";
import { ChatMessage } from "./types";

const CHAT_STATUS_CHANNEL = "com.hootchat/chat-status";
const STATUS_REQUEST_CHANNEL = "com.hootchat/status-request";
const NOTIF_ID = "com.hootchat/notification";
const NOTIF_UPDATE_CHANNEL = "com.hootchat/notif-update";
const NOTIF_READY_CHANNEL = "com.hootchat/notif-ready";
const NOTIF_DISMISS_CHANNEL = "com.hootchat/notif-dismiss";
const MSG_BROADCAST_CHANNEL = "com.hootchat/message";
const HISTORY_KEY = "com.hootchat/history";
const EXPIRE_MS = 6_000;

function msgKey(m: ChatMessage): string {
  return m.id;
}

OBR.onReady(async () => {
  const myId = await OBR.player.getId();
  let myName = await OBR.player.getName();
  OBR.player.onChange((p) => {
    myName = p.name;
  });
  let chatIsOpen = false;

  function setUnread(unread: boolean) {
    OBR.action
      .setIcon(unread ? "/icon-unread.svg" : "/icon.svg")
      .catch(console.error);
  }

  OBR.broadcast.onMessage(CHAT_STATUS_CHANNEL, (event) => {
    chatIsOpen = event.data === "open";
    if (chatIsOpen) setUnread(false); // 打开聊天即清除未读角标
  });
  OBR.broadcast.sendMessage(STATUS_REQUEST_CHANNEL, null, { destination: "LOCAL" }).catch(console.error);

  // Popover state machine: CLOSED -> OPENING -> OPEN
  // Messages accumulate in activeNotifs regardless of state; NOTIF_READY flushes them.
  type PopoverState = "CLOSED" | "OPENING" | "OPEN";
  let popoverState: PopoverState = "CLOSED";
  const activeNotifs = new Map<string, { msg: ChatMessage; timer: ReturnType<typeof setTimeout> }>();

  function sendUpdate() {
    const msgs = [...activeNotifs.values()].map((v) => v.msg);
    OBR.broadcast.sendMessage(NOTIF_UPDATE_CHANNEL, msgs, { destination: "LOCAL" }).catch(console.error);
  }

  function removeNotif(id: string) {
    const entry = activeNotifs.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    activeNotifs.delete(id);
    if (activeNotifs.size === 0) {
      popoverState = "CLOSED";
      OBR.popover.close(NOTIF_ID).catch(console.error);
    } else {
      sendUpdate();
    }
  }

  function openPopover() {
    popoverState = "OPENING";
    OBR.popover.open({
      id: NOTIF_ID,
      url: "/notification.html",
      width: 320,
      height: 1,
      anchorReference: "POSITION",
      anchorPosition: {
        left: Math.round(window.screen.availWidth / 2),
        top: 70,
      },
      anchorOrigin: { horizontal: "CENTER", vertical: "TOP" },
      transformOrigin: { horizontal: "CENTER", vertical: "TOP" },
      disableClickAway: true,
      hidePaper: true,
    }).catch((e) => {
      console.error(e);
      popoverState = "CLOSED";
    });
  }

  // Notification iframe signals it's ready — send current state.
  OBR.broadcast.onMessage(NOTIF_READY_CHANNEL, () => {
    popoverState = "OPEN";
    sendUpdate();
  });

  // User dismissed a notification from within the iframe.
  OBR.broadcast.onMessage(NOTIF_DISMISS_CHANNEL, (event) => {
    removeNotif(event.data as string);
  });

  // Seed seen set from history so we don't re-notify on reconnect.
  const meta = await OBR.room.getMetadata();
  const history = Array.isArray(meta[HISTORY_KEY]) ? (meta[HISTORY_KEY] as ChatMessage[]) : [];
  const seen = new Set<string>(history.map(msgKey));

  OBR.broadcast.onMessage(MSG_BROADCAST_CHANNEL, (event) => {
    const msg = event.data as ChatMessage;
    if (!msg || seen.has(msgKey(msg))) return;
    seen.add(msgKey(msg));
    if (msg.playerId === myId || chatIsOpen) return;

    // 私密消息（/s 暗骰、/@玩家名 悄悄话）：不可见则不弹通知、不计未读
    if (msg.type === "text" && (msg.hidden || msg.whisper)) {
      const canSee =
        !msg.hidden &&
        (msg.whisperId
          ? msg.whisperId === myId
          : !!msg.whisper && msg.whisper.toLowerCase() === myName.toLowerCase());
      if (!canSee) return;
    }

    const id = msgKey(msg);
    const timer = setTimeout(() => removeNotif(id), EXPIRE_MS);
    activeNotifs.set(id, { msg, timer });
    setUnread(true);

    if (popoverState === "CLOSED") {
      openPopover(); // sendUpdate deferred until NOTIF_READY
    } else if (popoverState === "OPEN") {
      sendUpdate();
    }
    // OPENING: message is in activeNotifs, will be sent on NOTIF_READY
  });
});
