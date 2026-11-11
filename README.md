# 🎬 3D 導演台（Director Console 3D）

在 Chrome 裡做 3D 預視（previs）的導演台：用低多邊形單色物件搭場景、設定 30 秒內的人物與攝影機運動、多機位剪輯，最後輸出 MP4。低階電腦也跑得動，人類用滑鼠操作，AI Agent 可透過 MCP、HTTP 或 JSON 檔操作，兩邊共用同一套指令。

## 功能

- **物件庫**（全部由程式生成，不需外部模型）：男、女、小孩、路人、人群；地面、丘陵、水面、道路；牆、房間（可開門窗，編輯時自動剖開擋視線的牆）、建築物、小屋、城市街區、樓梯、柱子；桌椅、沙發、床、書桌、門（開門角度可做動畫）、汽車、樹、灌木、路燈、長椅等。
- **人物**：靜態人偶，13 種姿勢（站、走、跑、坐、說話、揮手、指向、講電話、抱胸、叉腰、舉手、蹲、躺），姿勢可在時間軸上切換；「走到某點」「沿路徑移動」會自動轉向並換成走路姿勢。
- **時間軸**：最長 30 秒；每個屬性都能設關鍵影格，並可選緩動（線性、漸入、漸出、停格）。「自動關鍵影格」模式下，拖動物件就會記錄動畫；3D 視圖會顯示移動路徑。另有劇本標記軌與剪輯軌。
- **攝影機**：實體鏡頭換算（焦距＋感光元件 → 視角）、腳架／手持／軌道車／搖臂／空拍機、注視目標、跟拍、手持晃動與空拍漂移、一鍵構圖（大特寫到大遠景 × 角度 × 方位 × 過肩）、24 種運鏡預設（推拉、橫移、升降、搖、環繞、變焦、滑動變焦、空拍拉升／飛越／環繞…）。
- **特殊鏡頭**：魚眼（等距、等立體角、球極投影，含「小行星」）、360° 全景。
- **畫面比例**：16:9、9:16、1:1、4:5、4:3、1.85:1、2.39:1、2:1、自訂；解析度 720p 到 4K。
- **多機位剪輯**：剪輯軌決定每個時段用哪台機；「多機位監看牆」點一下就能切換，像導播台。
- **輸出**：MP4（H.264，WebCodecs 逐格離線算圖，慢電腦也不會掉格）、目前畫面 PNG、分鏡表 PNG；可壓上時間碼、機位名稱、焦距。
- **專案**：自動儲存、多專案管理、範本、JSON 匯入匯出、復原／重做。

## 需求

- Google Chrome（最新版；需要 WebGL2 與 WebCodecs）
- Node.js 22.18 以上（本機伺服器與 MCP 直接執行 TypeScript，不需編譯）

## 快速開始

```bash
npm install
```

```bash
npm start
```

開啟 http://127.0.0.1:5178/ 。第一次執行會自動建立範例專案「街頭對話」。

開發模式（修改程式碼即時更新）：

```bash
npm run dev
```

### 一鍵開啟（macOS）

```bash
npm run mac-app
```

會在桌面產生「3D 導演台.app」（圖示來源：`scripts/mac-app/icon.svg`）。點兩下就會：伺服器沒開時在背景啟動它（原始碼比上次建置新時先重新建置），再用 Chrome 開一個沒有分頁列的獨立視窗。

- 拖到 Dock 之後就是一鍵開啟。
- 想放到別的資料夾：`npm run mac-app -- ~/Applications`。
- 捷徑記得專案的位置；搬動專案資料夾後請重新執行一次。
- 有問題時看 `~/Library/Logs/director3d-launcher.log`（也可以用「主控台」App 開啟）。

### 只用網頁（不跑伺服器）

`npm run build` 產生的 `dist/` 可以放到任何靜態網站主機。這時專案存在瀏覽器的 IndexedDB 裡，不能使用 MCP 和專案資料夾。

## 介面

| 區域 | 用途 |
|---|---|
| 左側「物件庫／場景大綱」 | 點一下把物件放到畫面中央，或拖曳到 3D 視窗的指定位置；大綱可選取、改名、隱藏、鎖定 |
| 中間 3D 視窗 | 編輯／俯視／攝影機／節目／多機位五種視角；右下角子母畫面是節目監看 |
| 右側屬性面板 | 位置、旋轉、顏色、參數、攝影機設定；◇ 按鈕加關鍵影格 |
| 下方時間軸 | 播放控制、剪輯軌（＋ 切換機位）、標記（雙擊新增）、各物件的關鍵影格（可拖曳，右鍵改緩動） |
| 右上「{ } 指令」 | 指令主控台：查看每個操作對應的 JSON 指令、貼上指令批次執行、複製給 AI 的說明 |

常用快捷鍵：Space 播放、W/E/R 移動／旋轉／縮放、K 加關鍵影格、1–5 切換視角、C 看穿攝影機、F 聚焦、⌘Z 復原、⌘D 複製、Delete 刪除。完整列表在介面右上的「?」。

## AI Agent 操作

所有操作都是 JSON 指令，人類介面與 AI 走同一條指令匯流排：

```json
[
  {"cmd": "object.add", "args": {"type": "female", "id": "lead", "position": [0, 0, 0]}},
  {"cmd": "object.add", "args": {"type": "camera", "id": "camA"}},
  {"cmd": "camera.frame", "args": {"camera": "camA", "target": "lead", "shot": "MS", "side": "frontLeft"}},
  {"cmd": "camera.move", "args": {"camera": "camA", "preset": "dollyIn", "start": 0, "duration": 4}}
]
```

AI 的完整操作指南（座標系、單位、指令、範例流程）在 [AGENTS.md](AGENTS.md)。

### 1. MCP（Claude Code／Claude Desktop）

- **Claude Code**：在這個資料夾開啟 Claude Code，專案內的 `.mcp.json` 會提供 `director3d` 工具（第一次使用時請允許）。需要畫面時，工具會自動啟動伺服器並用 Chrome 開啟導演台。
- **Claude Desktop**：在設定檔的 `mcpServers` 加入（路徑改成你的實際位置）：

```json
{
  "mcpServers": {
    "director3d": { "command": "node", "args": ["/Users/你/Documents/claude_code/director-console-3d/server/mcp.ts"] }
  }
}
```

工具：`get_guide`、`list_commands`、`list_asset_types`（物件類型與參數範圍）、`get_project`（可用 `ids`／`fields` 只取一部分）、`run_commands`、`describe_scene`、`view_camera`、`evaluate_scene`（某時間點的精確位置與角度）、`ground_height`（丘陵地面高度）、`check_scene`（自動檢查：穿模、懸空／陷地、攝影機在牆裡、鏡頭沒拍到人或主角被擋、越軸、跳接、閃格與時間軸問題，每項附修正建議）、`snapshot`（回傳畫面圖片；`labels: true` 會在畫面上標出物件 id、框、景別與被遮擋比例，`cameras: "all"` 把所有機位拼成一張）、`plan_view`（俯視平面圖：物件 id、面向箭頭、攝影機視野扇形、移動路徑與關鍵時間、公尺格線）、`storyboard`（也支援 `labels`）、`export_video`、`get_export_status`、`list_projects`、`open_project`、`new_project`、`validate_project`。唯讀工具都標了 `readOnlyHint`，Claude Code 等用戶端可以自動放行；整批指令失敗時會一次列出所有錯誤（`errors`），成功時會列出這批修改新造成的場景問題（`checks.new`）。指令 `object.place` 可以用真實尺寸做相對擺放：放在桌上、站在某物前方 0.3 公尺、坐到椅子上。

### 2. HTTP

```bash
curl -s -X POST http://127.0.0.1:5178/api/rpc -H "content-type: application/json" -H "x-director-token: $(cat .director3d/token)" -d '{"method":"describe","params":{"time":2}}'
```

### 3. 瀏覽器內

在 DevTools 或瀏覽器自動化工具中使用 `window.director.run([...])`、`.describe()`、`.view()`、`.snapshot()`、`.planView()`、`.cameraSheet()`、`.exportVideo()`、`.help()`。

### 4. 直接編輯專案檔

`projects/<id>.json` 是可讀的 JSON，附 JSON Schema（`schema/project.schema.json`）。存檔後，開著的導演台會即時重載，這次修改也會成為一個可復原的步驟。格式有錯時不會套用，畫面會提示錯誤位置。

## 檔案位置

| 路徑 | 內容 |
|---|---|
| `projects/` | 專案檔（伺服器模式）；刪除的專案移到 `projects/.trash/` |
| `exports/` | 輸出的影片 |
| `.director3d/token` | 本機 API 權杖（僅限你的帳號讀取，勿分享） |
| `schema/project.schema.json` | 專案檔的 JSON Schema（伺服器啟動時產生） |

## 效能建議

- 低階電腦：右上 ⚙ 選「省電」，並關閉預覽陰影與子母畫面。
- 預覽畫質只影響編輯畫面；輸出影片永遠以完整品質逐格計算。
- 人群用「人群」物件（整群只占 1 次繪製），不要放上百個單獨的路人。
- 魚眼與 360° 每格要算 6 個方向，預覽時會用較低解析度。

## 已知限制

- 人物是靜態人偶，只能整體移動並切換姿勢，沒有關節動畫。
- 360° 影片沒有寫入球面中繼資料。若要讓 YouTube 或 VR 播放器辨識為 360°，需另外用工具注入（例如 Google 的 Spatial Media Metadata Injector）。
- 沒有景深與移軸效果（畫面全部清晰）。
- 沒有音訊軌，也沒有轉場（只有硬切）。
- 必須使用支援 WebCodecs 的瀏覽器（Chrome）才能輸出影片；萬一無法編碼 H.264，會自動改用 VP9／AV1 或 WebM。

## 開發

```bash
npm test
```

```bash
npm run typecheck
```

```bash
node scripts/mcp-smoke.ts
```

- `src/core/`：純邏輯（不碰 DOM），包含資料格式、指令、復原、時間求值、鏡頭數學、構圖、運鏡。網頁、伺服器與測試共用。
- `src/assets/`：低多邊形物件的程式建模。
- `src/render/`：Three.js 繪製、攝影機與特殊鏡頭、編輯輔助、離線算圖。
- `src/ui/`：React 介面（繁體中文）。
- `src/agent/`：`window.director` 與 WebSocket 橋接。
- `server/`：本機伴隨伺服器（`index.ts`）與 MCP（`mcp.ts`）。
- 設計文件：[docs/PLAN.md](docs/PLAN.md)
