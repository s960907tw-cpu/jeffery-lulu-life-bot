# 上線後驗收清單

依序測試：

1. Bot 加入群組，是否出現歡迎訊息。
2. Jeffery：`我是 Jeffery`
3. LULU：`我是 LULU`
4. `幫我們新增明天晚上 7 點吃飯`，確認 Bot 回傳行程文字 + LINE 行程卡片 +「開啟 Google 行事曆」按鈕
5. `@Bot 明天有什麼行程？`
6. `記得買衛生紙`
7. `記得買牛奶`
8. `@Bot 還有什麼沒買？`
9. `牛奶買了`
10. `待辦：Jeffery 訂飯店`
11. `想去：台南美術館`
12. `@Bot 我們想去的地方有哪些？`
13. 建一個 50 分鐘後的測試行程，確認五分鐘內會收到「1 小時」提醒與 Google Calendar 按鈕。
14. Apps Script 手動執行 `sendWeeklySummary()`，確認群組收到週報。
15. 一般聊天一句，例如 `晚餐吃什麼啦`，沒有 @Bot 時確認 Bot 不會亂插話。

16. 若已設定 `LULU_GOOGLE_EMAIL`：執行 `shareLifeCalendarWithLulu()`，確認 LULU 收到 Calendar 分享並能看到同一筆行程。
17. Jeffery / LULU 手機在 LINE「所有行事曆」開啟「與裝置中的行事曆同步」，確認 Google Calendar 行程會顯示。
