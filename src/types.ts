export interface RollDie {
  type: string; // "D6", "D10", "D20", etc.
  value: number;
}

interface ChatMessageBase {
  id: string; // short random identifier, e.g. 8-char base36
  playerId: string;
  playerName: string;
  playerColor: string;
  timestamp: number;
}

export interface TextMessage extends ChatMessageBase {
  type: "text";
  text: string;
  ooc?: boolean; // 场外发言（// 前缀），导出时排除
}

export interface RollMessage extends ChatMessageBase {
  type: "roll";
  dice: RollDie[];
  bonus: number;
  keep?: { mode: "h" | "l"; n: number }; // khN/klN：掷多颗取高/取低
  label?: string; // 检定名，如"生存"
}

export type ChatMessage = TextMessage | RollMessage;
