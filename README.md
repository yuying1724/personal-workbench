# 個人工作台（v2，網頁版）

任務、習慣、日記、專案、訂閱、課程：**GitHub Pages 前端（可安裝成 App）＋ Google 試算表當資料庫 ＋ Apps Script 當 API**。
v2 起，版面、登入方式、程式結構都跟「財務管理」（finance-web）一致：

- 手機：底部分頁列（總覽／任務／習慣／日記／更多）＋右下角 ＋ 按鈕；電腦：左側邊欄
- 登入：**裝置授權碼（每台裝置一組）＋ PIN**，取代以前的 API_TOKEN
- 資料表結構完全沒變，試算表裡的資料不用搬

網站：`https://yuying1724.github.io/personal-workbench/`

---

## 一、從舊版切換到 v2（只要做一次）

順序很重要：**先更新後端、再更新網站**。後端更新後舊版網站仍然能用（過渡期相容），所以不會有「兩邊都不能用」的空窗。

### 1. 更新 Apps Script 後端
1. 打開試算表「個人工作台」→ **擴充功能 → Apps Script**。
2. 點左邊的 **Api.gs**，全選刪掉，貼上本專案 `dist/Api.gs` 的全部內容，按 **儲存**。
   （`個人工作台-計算函數.gs` 不用動。）
3. 回到試算表 **重新整理頁面**，上方會多出 **「個人工作台」** 選單。
4. 選單 **個人工作台 → 第一次設定**：
   - 第一次執行 Google 會要求授權，看到「Google 尚未驗證這個應用程式」是正常的：**進階 → 前往（不安全）→ 允許**。
   - 設定 **PIN**（至少 6 碼）。
   - 幫這台裝置取名字，畫面會顯示一組 **裝置授權碼**（`XXXXX-XXXXX-XXXXX-XXXXX`），**只顯示這一次**，請存進密碼管理員或先抄下來。
5. 回到 Apps Script：**部署 → 管理部署作業** → 選網址是
   `…/AKfycbxlJ4rIFUT0RiDrnAwq2E2ah_7ERs43Zg09-vlvv221h6268-IxvLXENNmA3mAriKpW/exec` 的那一個 → **編輯（鉛筆）→ 版本：新版本 → 部署**。網址不會變。

### 2. 更新網站
1. 雙擊資料夾裡的 **`push.bat`**（會自動先合併 GitHub 上的最新版再上傳）。
2. GitHub 儲存庫 **Settings → Pages → Build and deployment**：Source 選 *Deploy from a branch*，Branch 選 `main`、資料夾改成 **`/docs`** → Save。
3. 等一分鐘，打開網站，輸入 **裝置授權碼＋PIN** 登入（授權碼之後會記在這台裝置，下次只要 PIN）。

### 3. 其他裝置（手機、家裡電腦）
- 試算表選單 **個人工作台 → 新增裝置授權碼**，每台裝置一組；遺失時用 **查看或撤銷裝置** 撤銷。
- 手機 Chrome：**⋮ → 安裝應用程式**（或「加到主畫面」）。

### 4. 確認新版都沒問題後
試算表選單 **個人工作台 → 關閉舊版網站入口**（刪除 API_TOKEN），舊的 token 就完全失效了。

---

## 二、在不同電腦工作（公司／家裡）

**GitHub 上的這個儲存庫是唯一正本。** 不管在哪台電腦請 Claude 修改，流程都一樣：

1. 在 Claude 桌面 App 開「個人工作台」這個 Project 的對話，連結這台電腦上的 `personal-workbench` 資料夾。
2. Claude 會先從 GitHub 抓最新版再開始改，改完直接寫進這個資料夾。
3. 雙擊 **`push.bat`** 上傳。它會先把另一台電腦推上去的修改合併進來再上傳，不會互相蓋掉。
4. 如果動到後端（`server/` 或 `dist/Api.gs`），照「三、日常維護」把新的 `dist/Api.gs` 貼到 Apps Script 並部署新版本。

**第一次在新電腦使用**（例如家裡電腦，只要做一次）：
1. 安裝 [Git for Windows](https://git-scm.com/download/win)（安裝時都按預設）。
2. 在想放的位置（例如「文件」）按右鍵 → *Open Git Bash here*，輸入：
   ```
   git clone https://github.com/yuying1724/personal-workbench.git
   ```
3. 第一次 push 時會跳出 GitHub 登入視窗，登入一次之後就記住了。

> 小提醒：開始工作前如果想先確認這台電腦是最新版，可以雙擊 `pull.bat`。

---

## 三、日常維護

| 想做的事 | 做法 |
|---|---|
| 更新前端 | 改 `docs/` 之後雙擊 `push.bat`，手機開啟 App 時會自動更新 |
| 更新後端 | 改 `server/` → `npm run build` → 把 `dist/Api.gs` 整份貼進 Apps Script 的 Api.gs → **部署 → 管理部署作業 → 編輯 → 新版本 → 部署**（網址不變） |
| 忘記 PIN | 試算表選單 **個人工作台 → 設定或變更 PIN**（只有試算表擁有者能執行） |
| 手機遺失 | **個人工作台 → 查看或撤銷裝置**；或 **登出所有裝置** |
| 備份 | 試算表 **檔案 → 版本記錄** 會自動保留；也可以 **檔案 → 建立副本** |

> 試算表可以直接手動修正資料，但請不要改各分頁第一列的表頭文字、也不要調整欄位順序（程式依欄位位置寫入）。

---

## 四、安全性

- 網頁應用程式網址是公開可連的，保護來自後端驗證：每個請求都要有登入取得的工作階段碼；登入需要「裝置授權碼」＋「PIN」，兩者都以加鹽 SHA-256 雜湊存在 Apps Script 的**指令碼屬性**（不在試算表、不在程式碼），GitHub 儲存庫裡沒有任何祕密。
- PIN 連續錯 5 次鎖定 15 分鐘；授權碼錯誤不計次（不知道授權碼的人無法靠亂試把妳鎖在門外）。
- 工作階段 60 分鐘、使用中自動延長；App 閒置也會自動鎖定。撤銷裝置或「登出所有裝置」立即生效。
- 寫入操作一律加鎖，兩台裝置同時儲存也不會互相覆蓋成亂碼。

---

## 五、專案結構

```
docs/      GitHub Pages 前端（原生 ES Modules，不需建置；sw.js 由 build 產生）
server/    Apps Script 後端原始碼
  api.js     新版 API：登入驗證、動作分派
  auth.js    裝置授權碼＋PIN、工作階段（與財務管理同一套）
  legacy.js  各模組資料邏輯（來自 2026-09-21 線上版 Api.gs，內容不變）
  main.js    doGet/doPost 入口、試算表選單
dist/Api.gs  由 server/ 合併出來、要貼進 Apps Script 的檔案（不要手動改它）
backup/    切換前的線上版備份（Api.gs、計算函數.gs、舊版 index.html）
tools/     build-gas.js、build-web.js、dev-server.js（本機試玩）
tests/     後端單元測試＋瀏覽器端到端測試
```

## 六、開發

需要 Node 20 以上。

```bash
npm test                 # 建置 + 全部測試（用真正打包後的 Api.gs 搭配記憶體版 Google 服務）
npm run dev -- --demo    # 本機試玩 http://127.0.0.1:8788（終端機會印出試玩用的授權碼與 PIN；資料只在記憶體）
```
