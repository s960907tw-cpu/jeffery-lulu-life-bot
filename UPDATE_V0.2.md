# v0.2 行事曆同步升級

這版新增：

- 新增 / 修改行程後，LINE 回覆 Flex 行程卡片。
- 卡片含「開啟 Google 行事曆」按鈕。
- 前 24 小時與前 1 小時提醒也附行程卡片與按鈕。
- 可設定 `LULU_GOOGLE_EMAIL`，將 `Jeffery × LULU` Google Calendar 分享給 LULU。
- Google Calendar 可透過手機系統行事曆顯示於 LINE「所有行事曆」。

## 如果你還沒部署 v0.1

直接用 v0.2 從 README 開始，不需要先安裝 v0.1。

## 如果已部署 v0.1

1. Render / GitHub 專案以 v0.2 的 `server.js` 覆蓋舊版並重新部署。
2. Apps Script 將 `apps-script/Code.gs` 全部覆蓋舊版。
3. Apps Script 再執行一次 `setupLifeBot()`。這個函式會沿用原本 Spreadsheet / Calendar，不會重建既有資料。
4. Deploy → Manage deployments → 編輯 Web app → New version → Deploy。
5. 若 Web app `/exec` URL 沒變，Render 的 `APPS_SCRIPT_URL` 不用改。
6. 若要共享給 LULU：Project Settings → Script Properties 新增 `LULU_GOOGLE_EMAIL`，再執行 `shareLifeCalendarWithLulu()`。
7. LULU 接受 Google Calendar 分享邀請。
8. Jeffery 與 LULU 各自在手機 LINE → 行事曆 → 所有行事曆 → 與裝置中的行事曆同步。

## LINE 原生共用行事曆限制

Bot 建立的是 Google Calendar 行程，可顯示於 LINE「所有行事曆」的外部行事曆區域；目前不是直接寫入該 LINE 聊天室自己的原生「共用行事曆」。
