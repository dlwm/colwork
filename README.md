# Colwork

基于 Yjs 的多人协作表格前端库，使用原生 DOM 渲染，提供 Vue / React 演示页。

## 开发

```sh
npm ci
npm run dev
```

- Vue：<http://127.0.0.1:5173/test/vue.html>
- React：<http://127.0.0.1:5173/test/react.html>
- 快照与更新日志工具：<http://127.0.0.1:5173/test/index.html>

`npm run build` 执行 TypeScript 检查并构建 ES / UMD 库。

## 工具栏与菜单

工具栏按用途分为两排：上排是历史、单元格、保护和显示，下排是文字、对齐和格式；窄屏按组换行。右键菜单按编辑/行列操作、固定、保护分组，支持方向键移动、Enter 执行和 Esc 关闭，窗口空间不足时菜单内部滚动。

固定行的下边缘、固定列的右边缘显示分隔线和轻阴影；即使隐藏网格线，固定边界仍然可见，取消固定后消失。

## 行列选择

按住鼠标左键拖过行号或列字母，可连续选择整行或整列，支持反向拖动；松开鼠标结束。选中的行列头会高亮，仍支持 Shift 点击扩选。拖动期间可滚动视口继续选择，选区在松开鼠标后同步给协作者。

## 固定与锁定

- **固定**：选中单元格或行列，在「视图」或右键菜单中选择「固定至选中行/列」。从首行/首列固定到选区末端，可同时固定两个方向；「取消固定」恢复滚动。此设置仅影响当前客户端，不写入快照。所选行列集合或固定边界包含不完整的合并块时，会提示并拒绝固定，原固定范围保持不变。合并范围同时包含固定区和非固定区时，也会提示并拒绝合并。
- **锁定**：选中区域后打开工具栏「保护」菜单，统一选择「锁定选区」「密码锁定选区」或「解锁选区」，右键菜单也提供相同操作。密码锁定，需要输入两次密码；解锁密码区域时会弹出密码校验。普通锁定和密码锁定均显示相同的透明斜线遮罩，保留内容和格式可见，状态同步给协作者，随快照和更新日志保存。锁定覆盖选区当时的单元格，不自动覆盖以后新增的行列。
- 选区包含锁定单元格时，清空、格式、合并/拆分操作整体拒绝；粘贴目标包含锁定单元格时，整次粘贴拒绝。会移动或删除锁定单元格的行列操作，以及涉及锁定单元格的行高列宽调整也被拒绝。
- 锁定/解锁发生变化时清空当前客户端的撤销历史，避免旧操作改写锁定内容。远端锁定编辑中的单元格时，丢弃尚未提交的输入。
- 无密码锁定可直接解锁；密码锁定必须通过密码验证，普通锁定不能覆盖密码锁。混合选区需同一密码验证所有保护记录，否则整次解锁不生效，不同密码的区域应分别解锁。
- 密码采用 Web Crypto PBKDF2-HMAC-SHA-256（600,000 次迭代），每次密码锁定生成随机 16 字节盐，保存 32 字节派生验证值和版本参数，不保存明文密码。参数参考 [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。需要 HTTPS 或 localhost；密码无法通过界面找回。
- 密码保护仍属于客户端协作防误改，不是服务端鉴权，也没有加密表格内容。旧客户端或直接修改 Yjs 的代码仍可能绕过保护；存档包含盐和验证值，应避免使用弱密码。

实例 API：

```ts
table.setFrozenPanes(1, 2)       // 固定前 1 行、前 2 列；若切开合并块则返回 false
table.setFrozenPanes(0, 0)       // 取消固定
await table.setSelectionLocked(true)                // 无密码锁定当前选区
await table.setSelectionLocked(true, 'your-password') // 密码锁定（选区不能已有密码锁）
await table.setSelectionLocked(false, 'your-password') // 验证密码并解锁
await table.setSelectionLocked(false)               // 解锁无密码区域
```

`setFrozenPanes()` 成功返回 `true`；合并块不完整时返回 `false` 并显示提示。固定是本地视图设置，其他客户端的合并若与本地固定边界冲突，会提示并取消受影响方向的固定。

`setSelectionLocked()` 现在返回 Promise；密码错误、保护记录无效、校验期间文档改变时会拒绝 Promise，调用方需捕获错误。取消密码对话框不会修改锁定状态；处理期间禁用重复提交和取消。

## 浏览器测试

```sh
npx playwright install chromium
npm run test:e2e
```

测试自动启动独立的 Vite 和临时 WebSocket 服务，覆盖固定、锁定、跨客户端同步和存档恢复。也可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定本机 Chrome 可执行文件。

核心代码阅读说明见 [CORE.md](CORE.md)，方案讨论见 [DESIGN.md](DESIGN.md)。
