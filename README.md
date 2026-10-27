Hoot Chat 中文版

面向中文桌玩家的 [Owlbear Rodeo](https://www.owlbear.rodeo/) 聊天扩展，基于
[ddfisher/hoot-chat](https://github.com/ddfisher/hoot-chat)（GPL-3.0）汉化与功能增强。

- 全中文界面，保留玩家颜色、弹窗通知等原版功能
- DnD 风格文字掷骰（取代原版的 Draw Steel power roll）
- BBCode 聊天记录导出（颜色自动取自枭熊房间内玩家颜色）
- `//` 场外发言（暗化显示，不参与导出）
- 一键清空聊天记录（带二次确认防呆）

## 指令

| 指令 | 说明 |
|---|---|
| `/roll 2d6+3`（或 `/r`） | 基础掷骰，支持 `NdX±N` 组合 |
| `/r 1d20+6 生存` | 末尾文字作为检定名显示 |
| `/r 2d20kh1+5` | `khN` 取最高 N 颗，`klN` 取最低 N 颗（`dlN`/`dhN` 同义） |
| `/adv +6 察觉` | 优势，等价于 `/r 2d20kh1+6 察觉` |
| `/dis +2` | 劣势，等价于 `/r 2d20kl1+2` |
| `//文字` | 场外发言：聊天中暗化缩小显示，导出时自动排除 |
| `/clear` | 清空全部聊天记录（需二次确认） |
| `/help`（或 `/h`） | 显示指令帮助 |

单颗 d20 掷出 20 显示 🎉 大成功，掷出 1 显示 💀 大失败。

## 安装

1. 在 Owlbear Rodeo 打开 **扩展** 菜单，选择 **添加扩展**。
2. 输入 manifest 地址（本地开发示例）：
   ```
   http://localhost:5173/manifest.json
   ```

## 开发

```bash
npm install
npm run dev      # 本地开发，默认 http://localhost:5173
npm run build    # 构建到 dist/
```

## 出处声明

原版 [Hoot Chat](https://github.com/ddfisher/hoot-chat) 由 Ardent Light 开发，
以 GPL-3.0 协议发布。本仓库的修改版同样遵循 GPL-3.0 协议。
