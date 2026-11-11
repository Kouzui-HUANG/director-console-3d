# director3d-previs（zh-TW 人類可讀版）

> 本文件為 `SKILL.md` 的繁體中文對照翻譯，僅供人類閱讀；AI 執行時不會載入本檔。
> 原檔最後更新：2026-11-11。內容若有出入，以 `SKILL.md` 為準。
> `references/script-to-previs.md` 與 `references/example-street-scene.mjs` 未翻譯（前者為查表資料、後者為程式碼，內含的中文字串保持原樣）。

## Frontmatter 說明

- **name**：`director3d-previs`
- **description（觸發條件）**：把逐鏡分鏡腳本（分鏡腳本）轉成 Director Console 3D 的預視（previs，包含走位、臨演、攝影機、剪接點、MP4），並依意見修改。使用者說「開一個新的專案處理以下的戲」、「把這場戲做成預視」、「previs」、「3D 導演台」、「分鏡轉 3D」，或對預視提出修改意見（「太長了」、「走快一點」、「路人突然才動」）時使用。不負責撰寫分鏡腳本本身（→ shot-script-director）。
- **compatibility（相容性）**：需要 Director Console 3D 專案及其 director3d MCP 伺服器；檢查腳本需要 Node 23.6 以上。

# 從分鏡腳本做 Director Console 3D 預視

在 Director Console 3D 裡為一場寫好的戲做低多邊形預視：街景或室內場景、演員走位、臨演、每個 CUT 一台攝影機、剪接、輸出 MP4。這份預視會當作影片模型（Seedance）的位置連續性參考，所以誰站在哪、彼此距離、畫面方向在各顆鏡頭之間都必須一致。

專案裡的 `AGENTS.md` 記載指令、座標軸和單位；這個 skill 是建立在它之上的工作流程與使用者的標準。下文的 `<skill>` 指本檔所在的資料夾。

## 規則

1. **總長 15 秒以內**，除非使用者或劇本指定其他長度。第一版 30 秒被退回，意見是「太長了 15秒就好」，而且它要餵的影片模型大約只吃 15 秒。劇本估時加總超過時，每顆鏡頭按同一比例縮短，保留每個轉折和順序，並說明哪些停頓變短了。
2. **邊走邊講的步速為每秒 1.5 公尺。** 每秒 1.1 公尺時得到的意見是「走快一點」。
3. **臨演和車輛絕不在鏡頭裡起步、停下或定格。** 每個路人和車輛都從 t = 0 動到片尾，進出畫面時已經在移動（從攝影機後方或畫面外開始）。只有原地的動作（講電話、沖地）可以站著不動，而且要用非走路的姿勢。攝影機看得到的地方不能放姿勢為 `walk`/`mixed` 的 `crowd`：它是單一靜態網格，看起來就是一群走到一半定格的人。`check-extras.mjs` 必須通過。
4. **照劇本做，不改寫劇本。** 每個 CUT 一台攝影機（`cut1`、`cut2`…，名稱裡寫上劇本的鏡頭描述），剪接點時間＝各顆鏡頭長度的累加，每個 cut 照劇本的景別／鏡頭焦段／運鏡。每句台詞和每個表演節點都變成該時間點的標記（marker）。劇本的空間關係不可能成立時，取最接近、又保留原意的解讀，並告訴使用者。
5. **生成腳本是唯一的依據。** 整個專案都由 repo 裡的 `scenes/<project-id>/build.mjs` 產生（暫存區在工作階段結束後會被清掉）。所有修改都改在那裡再重新產生；只用 `run_commands` 或手改 JSON 做的修正，下次重新產生時就會消失。
6. **每次輸出前都要驗證**，用下方第 5 步的檢查；全部通過才傳送 MP4。
7. **用使用者的語言回報**（通常是繁體中文），格式見本檔最後。

## 工作流程

### 1. 先在紙上規劃

- 讀完整份劇本。逐個 CUT 列出：景別、焦段、運鏡、誰做什麼、台詞、估時。
- 依規則 1 做時間分配表（`references/script-to-previs.md` §1），並決定位置：朝攝影機走＝朝 +Z，街道沿 Z 軸延伸。
- 查清楚要用的物件類型的確切參數：`list_asset_types`（MCP）或 `src/core/assetTypes.ts`。
- 讀 `references/script-to-previs.md`，查劇本用語 → 攝影機設定、走路的數學、道具、光線和臨演。

### 2. 建立專案和場景資料夾

```bash
# after new_project {name, template: "blank"} returned the id
mkdir -p scenes/<id>
cp <skill>/scripts/previs-kit.mjs scenes/<id>/
```

撰寫 `scenes/<id>/build.mjs`。從 `references/example-street-scene.mjs`（一個用 kit 寫成、完整的 15 秒 4 顆鏡頭街景）複製寫法。順序：時間常數與走位函式 → 場景 → 主角（道具用 `kit.attached`）→ 臨演（`kit.walker`、`kit.pathWalker`、`kit.scooter`/`kit.vehicle`）→ 攝影機（`kit.camera`）→ `kit.writeProject(file, scene, {name, notes, settings, cuts, markers})`。

每個節點的時間都從常數（速度、鏡頭長度）推算出來，這樣「短一點」、「快一點」這類意見只要改一行。

### 3. 產生

```bash
node scenes/<id>/build.mjs projects/<id>.json
```

開著的 app 分頁會把檔案重新載入，算一個可復原的步驟。先修掉 kit 印出的所有 `warning:`，再執行 `validate_project`。

### 4. 擺固定機位

跟拍鏡頭在 build.mjs 裡設定（follow + lookAt）。固定鏡頭則互動式找位置：先 `object.update {id, position}`，再 `camera.frame {camera, target, shot, keepPosition: true}`，用 `snapshot` 看畫面，最後把確定的位置／焦距／lookAt 寫進 build.mjs 並重新產生。

### 5. 驗證

以下全部執行，修正、重新產生，重複到通過：

1. `check_scene`（MCP）。如果沒有這個工具（伺服器是在 app 更新前啟動的），就在 repo 根目錄執行 `node <skill>/scripts/check-scene.mjs projects/<id>.json`。修正 OVERLAP（路線穿過柱子、樹、人）、CROSSED_LINE、SUBJECT_HIDDEN、KEYS_AFTER_END。
2. 在 repo 根目錄執行 `node <skill>/scripts/check-extras.mjs projects/<id>.json`：抓出在正在播出的鏡頭裡起步、停下或定格的臨演和車輛，這是 `check_scene` 不檢查的。必須印出 ✓。
3. 在關鍵節點用 `plan_view`：走位、距離、每台攝影機在軸線的哪一側。
4. `storyboard`，時間點取每個剪接點的前後、每個節點，以及臨演或車輛進入畫面的時刻。檢查頭沒有被切掉、道具在該在的位置、主角看得清楚。
5. 有疑問的地方用 `snapshot {labels: true}` 看；`view_camera` 回報某個物件佔滿整個畫面時也要用它確認（在鏡頭旁邊或後方的物件會被這樣回報）。

### 6. 輸出並傳送

`export_video {filename: "<片名>_previs_v<N>[_note]", tier: "1080p", burnIn: {timecode: true, camera: true}}` —— 檔名不要加 `.mp4`（工具會自己加，`x.mp4` 曾經變成 `x.mp4.mp4`）。把檔案傳給使用者，並保留舊版本。

## 收到意見後的修改

1. 把 `projects/<id>.json` 和 `scenes/<id>/generated.json`（kit 寫出的）做比對。如果不同，表示使用者在 app 裡改過：重新產生前先問，或把他們的修改移植進 build.mjs。沒有 `scenes/<id>/` 的專案（在 UI 裡做的或來自其他工作階段）：小修正用 `run_commands`；若要重新排時間或改動超過幾個物件，先寫一份能重現該專案的 build.mjs（複製場景和主角的關鍵影格，用 kit 重建臨演），用 `plan_view`/`storyboard` 確認一致後再修改。
2. 備份目前的檔案：`cp projects/<id>.json scenes/<id>/backup-v<N>.json`。
3. 改 build.mjs、重新產生、跑完第 5 步全部檢查，輸出為 v<N+1>。

| 意見 | 修改 |
|---|---|
| 太長了 / make it N s | 鏡頭長度常數和速度；標記會跟著變，因為它們用同一組常數；回報新的時間表、哪些停頓縮短了、距離的變化 |
| 走快一點 / slower | 速度常數；停步距離由 `easeOutDistance` 自動推算 |
| 某個臨演或車輛「突然才開始動」 | 改用 `walker` / `pathWalker` / `vehicle` 重建，錨定在它必須到位的時刻，t = 0 時從畫面外開始，一路動到片尾 |
| 某顆鏡頭看起來不對 | 只改那台攝影機；重新檢查它前後兩個剪接點 |

## 回報格式

用使用者的語言回覆：

- 一行：完成了什麼，以及 MP4 路徑（做成連結）；
- 一張表格：鏡頭 | 時間 | 內容（附時間的節點）；
- 「會影響你看片的改動」：他們會注意到的變化（停頓變短、距離、換掉的臨演）；
- 「我自己做的決定」：對劇本模糊或不可能之處的解讀；
- 「人偶做不出來的部分」：只能寫成標記的表演；
- 生成腳本和備份放在哪裡。

## Gotchas（踩過的坑）

- 臨演停在第一個關鍵影格的值：在第一個 key 之前都站著不動，然後剛好在攝影機看到時「起步」（使用者指出的問題）。從 t = 0 就下 key；`check-extras.mjs` 抓得到。
- 一個路人在 85mm 的鏡頭裡跟在主角後面走了好幾秒，看起來像在跟蹤，搶了戲。
- 一個臨演的路線離騎樓柱子只有 0.28 公尺（穿模）。`check_scene` 的 OVERLAP 抓得到。
- 機車在靠路緣的車道往南騎：在台灣是逆向。靠右行駛。
- 預設 `golden` 讓「暖色午後」太橘；`day` 才對。
- 長焦跟拍鏡頭切到頭：調高 lookAt 的 offset y，或改用較短的焦距。
- `camera.frame` 的 `keepPosition` 只接受 `true`，不接受座標（INVALID_ARGS）。
- `point` 姿勢固定用某一隻手；把角色鏡像（`scale: [-1, 1, 1]`）就能換另一隻手。
- 墨鏡只在角色的關鍵影格時間下 key，結果在兩個 key 之間花了 2.5 秒沿著臉往下滑。改用 `kit.attached`，它每 0.1 秒取樣一次。
- 沒寫 `ease` 的 key 預設是 `inOut`：等速移動的物件要用 `'linear'`。
- app 沒有景深（攝影機的 `dof` 已移除）。「失焦」只能靠距離和焦段表現。
