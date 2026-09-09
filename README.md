# Jeffery × LULU Life Bot

LINE 群組共用生活助理 MVP。

## 已完成的功能

- LINE 群組 Webhook 與簽章驗證
- Jeffery / LULU 身分綁定
- `@Bot` AI 自然語言聊天
- 不 @Bot 也能辨識明確生活管理指令
- Google Calendar 共同行程
- 建立 / 修改行程後回傳 LINE Flex 行程卡片與「開啟 Google 行事曆」按鈕
- 行程提醒訊息附 Google Calendar 行程卡片
- 可選填 LULU Google 帳號，自動共享 Jeffery × LULU 共同行事曆
- Google Calendar 同步到手機系統行事曆後，可顯示於 LINE「所有行事曆」
- 新增 / 查詢 / 修改 / 取消行程
- Google Sheet 採買清單
- Google Sheet 待辦清單
- Google Sheet Wishlist（想去 / 想吃 / 想買）
- 行程前 24 小時 LINE 提醒
- 行程前 1 小時 LINE 提醒
- 每週日晚上 20:00 下週摘要
- OpenAI Responses API + function calling

## 架構

LINE 群組 → Render / Node.js → OpenAI
                         ↘ Google Apps Script → Google Sheet + Google Calendar
                                              ↘ LINE 主動提醒

## 1. 建立 LINE Bot

1. 建立 LINE Official Account 與 Messaging API channel。
2. 在 LINE Developers Console 的 Messaging API 設定中開啟 **Allow bot to join group chats**。
3. 取得：
   - Channel secret
   - Channel access token
4. 先不用填 Webhook URL，等 Render 部署完成。

## 2. 建立 Google Apps Script backend

1. 到 Google Apps Script 新增一個獨立專案。
2. 將 `apps-script/Code.gs` 全部貼入。
3. 執行 `setupLifeBot()`。
4. 第一次會要求 Google Sheets / Calendar 權限，允許即可。
5. 到 Apps Script：**Project Settings → Script Properties**，新增：
   - `LINE_CHANNEL_ACCESS_TOKEN` = LINE 的 Channel access token
   - `LULU_GOOGLE_EMAIL` = LULU 的 Google / Gmail 帳號（可先不填）
6. 如果已填 `LULU_GOOGLE_EMAIL`，執行 `shareLifeCalendarWithLulu()`，LULU 接受 Google Calendar 分享邀請後即可共用。
7. 再執行 `showSetupStatus()`，在 Execution log 取得：
   - `BACKEND_TOKEN`
   - Spreadsheet URL
   - Calendar ID
8. Deploy → New deployment → Web app：
   - Execute as: Me
   - Who has access: Anyone
9. 複製 Web app `/exec` URL。

> Apps Script endpoint 本身雖設為 Anyone，但每一個 POST 都必須帶 BACKEND_TOKEN，程式會拒絕不正確的 token。

## 3. OpenAI API

建立 OpenAI API key，Render 只需要把它放進環境變數 `OPENAI_API_KEY`。不要把 key 寫入 GitHub 或程式碼。

預設模型：`gpt-5.6-luna`。可透過 `OPENAI_MODEL` 更換。

## 4. 部署到 Render

把這個資料夾推到 GitHub，Render 建立 Web Service。

環境變數：

```text
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-luna
APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
APPS_SCRIPT_TOKEN=<setupLifeBot 產生的 BACKEND_TOKEN>
BOT_NAME=J&L小管家
TIMEZONE=Asia/Taipei
```

Render 成功後，例如網址：

```text
https://jeffery-lulu-life-bot.onrender.com
```

LINE Webhook URL 設為：

```text
https://jeffery-lulu-life-bot.onrender.com/webhook
```

按 Verify，並開啟 Use webhook。


## 讓 Google Calendar 顯示在 LINE 行事曆

Bot 寫入的是 `Jeffery × LULU` Google Calendar。LINE 官方目前可在「所有行事曆」讀取裝置系統行事曆，因此請 Jeffery 與 LULU 各自設定一次：

1. 手機先登入自己的 Google 帳號，確認 `Jeffery × LULU` 共同行事曆已出現在手機系統行事曆。
2. LINE → 行事曆 →「所有行事曆」。
3. 右上選單 → **與裝置中的行事曆同步**。
4. 勾選 / 顯示 `Jeffery × LULU` 外部行事曆。

之後 Bot 新增或修改 Google Calendar 行程，只要手機系統行事曆完成同步，LINE「所有行事曆」也會跟著更新。

> 限制：這不是 LINE 聊天室本身的「共用行事曆」資料。LINE Messaging API 目前沒有讓 Bot 直接寫入聊天室原生共用行事曆的官方端點。

## 5. 拉進 Jeffery × LULU LINE 群組

Bot 進群後會自動註冊 groupId。

Jeffery 輸入：

```text
我是 Jeffery
```

LULU 輸入：

```text
我是 LULU
```

同一身分不能被兩個 LINE userId 重複綁定。

## 6. 測試語句

### 行程

```text
幫我們新增 9/19 晚上 7 點吃燒肉
```

```text
@J&L小管家 這週我們有什麼行程？
```

```text
把 9/19 的燒肉改成晚上 8 點
```

```text
取消 9/19 的燒肉
```

### 採買

```text
記得買衛生紙
```

```text
採買：牛奶
```

```text
牛奶買了
```

```text
@J&L小管家 還有什麼沒買？
```

### 待辦

```text
待辦：Jeffery 訂北海道飯店
```

```text
訂飯店完成了
```

### Wishlist

```text
想去：台南某某咖啡廳
```

```text
想吃：高雄某某燒肉
```

```text
@J&L小管家 我們有哪些想去的地方？
```

### AI 聊天

```text
@J&L小管家 這週六如果沒行程，幫我們想三個約會方向
```

## 提醒規則

每 5 分鐘檢查一次行程：

- 距離行程 <= 24 小時，且尚未提醒 → 發一次「24 小時內有行程」
- 距離行程 <= 1 小時，且尚未提醒 → 發一次「1 小時後有行程」
- 若建立的是一小時內的新行程，只發一小時提醒，避免一次跳兩則

每週日約 20:00：

- 下週行程
- 尚未完成採買
- 尚未完成待辦

Apps Script 的 time trigger 執行時間可能在設定小時內有些微浮動。

## Bot 不會亂插話

群組中只有以下狀況會回：

- 明確 `@Bot`
- 「我是 Jeffery / 我是 LULU」
- 很明確的新增行程、提醒、採買、待辦、Wishlist、查行程等語句

一般 Jeffery 和 LULU 的聊天不會每句都跳出來。

## 下一階段建議

- LINE Rich Menu：行程 / 採買 / 待辦 / Wishlist 四顆按鈕
- 共同記帳與分帳
- 生日、紀念日與固定週期提醒
- 旅行模式：機票、飯店、景點、行李清單
- 串 Google Maps 地點與導航
- AI 即時搜尋餐廳 / 天氣 / 活動
- 圖片收據辨識後自動記帳
- 更完整的聊天記憶持久化
