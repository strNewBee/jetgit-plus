# Changelog / 更新日志

## [0.4.2] - 2026-05-27

### Added / 新增
- Clicking Commit icon in Activity Bar now opens both sidebar and bottom Git Log panel simultaneously / 点击 Activity Bar 的 Commit 图标同时打开侧边栏和底部 Git Log 面板
- Clicking again to collapse also closes the bottom panel / 再次点击收起时同时关闭底部面板
- Custom larger SVG icon for Commit in Activity Bar / Activity Bar 使用更大的自定义 SVG 图标

## [0.4.1] - 2026-05-26

### Added / 新增
- **Next/Previous File Diff Navigation** — jump between file diffs with keyboard shortcuts
  **下一个/上一个文件 Diff 导航** — 用快捷键在文件 diff 之间跳转
  - Cmd+F7: next file diff / 下一个文件 diff
  - Cmd+Shift+F7: previous file diff / 上一个文件 diff
  - Status bar shows current position (e.g. "File 2/5: filename.tsx") / 状态栏显示当前位置
  - Commands: `git-brains.nextDiff` / `git-brains.prevDiff` (rebindable in Keyboard Shortcuts) / 可在键盘快捷键设置中自定义绑定
- **Directory node checkboxes** in tree view / 目录树视图中的文件夹复选框
  - Check/uncheck recursively selects/deselects all files under a directory / 勾选/取消勾选递归选中/取消目录下所有文件
  - Indeterminate state when partially selected / 部分选中时显示半选状态
- **Keyboard arrow navigation** — Up/Down arrows move highlight between files / 上下箭头键在文件间移动高亮

### Fixed / 修复
- Directory tree expanded state now persists across tab switches / 目录树展开状态在切换标签页后保持不变
- Show all individual untracked files (use `git status -uall`) instead of directory summaries / 显示所有未跟踪文件而非目录摘要
- Directory tree indentation matches IDEA style with proper nesting / 目录树缩进匹配 IDEA 风格
- Chevron arrow placed before checkbox in directory rows (matches IDEA) / 文件夹行中箭头在复选框前面

## [0.4.0] - 2026-05-26

### Added / 新增
- **IDEA-style Commit Panel** — new sidebar panel (Activity Bar) replicating IntelliJ's commit workflow
  **IDEA 风格 Commit 面板** — 新增侧边栏面板，复刻 IntelliJ 的提交工作流
  - File changes grouped by Changes / Staged / Unversioned Files / 文件变更按 Changes / Staged / Unversioned Files 分组
  - Checkbox-based file selection for partial commits / 基于复选框的文件选择，支持部分提交
  - Commit message input with Ctrl+Enter shortcut / 提交信息输入框，支持 Ctrl+Enter 快捷提交
  - Commit / Commit and Push buttons / Commit 和 Commit and Push 按钮
  - Amend commit support (auto-loads previous message) / Amend 提交支持（自动加载上次提交信息）
  - Right-click context menu: Show Diff, Jump to Source, Add to VCS/Unstage, Rollback, Shelve Changes / 右键菜单：查看差异、跳转源码、暂存/取消暂存、回滚、搁置变更
  - Cmd+Click multi-select for batch operations / Cmd+点击多选，支持批量操作
  - Group by Directory toggle with tree view (collapsible folders) / 按目录分组切换，支持树形视图（可折叠文件夹）
  - View Options menu (eye icon): Group By Directory, Show Unversioned Files / 视图选项菜单（眼睛图标）：按目录分组、显示未跟踪文件
  - Expand All / Collapse All toolbar buttons / 展开全部/折叠全部工具栏按钮
- **IDEA-compatible Shelf** — real shelf stored in `.idea/shelf/` (compatible with IntelliJ IDEA)
  **IDEA 兼容 Shelf** — 真正的 shelf 功能，存储在 `.idea/shelf/`（与 IntelliJ IDEA 完全兼容）
  - Patch-based storage format matching IDEA's XML + unified diff / 基于 patch 的存储格式，匹配 IDEA 的 XML + unified diff
  - Expandable shelf entries showing individual file changes / 可展开的 shelf 条目，显示每个文件的变更
  - Right-click context menu: Unshelve, Restore, Create Patch, Copy as Patch to Clipboard, Import Patches, Delete / 右键菜单：取消搁置、恢复、创建补丁、复制补丁到剪贴板、导入补丁、删除
  - Show Diff opens side-by-side diff editor (base vs modified) / Show Diff 打开左右对比差异编辑器（原始 vs 修改后）
  - Import Patches from external .patch/.diff files / 从外部 .patch/.diff 文件导入补丁
  - Right-click on empty area to Import Patches / 空白区域右键可导入补丁
- **Stash Tab** — git stash management (renamed from previous "Shelf")
  **Stash 标签页** — git stash 管理（从之前的 "Shelf" 重命名）
  - Expandable stash entries with file details / 可展开的 stash 条目，显示文件详情
  - Right-click context menu: Unshelve, Restore, Delete / 右键菜单：弹出、应用、删除
  - Per-file context menu: Show Diff, Jump to Source, Copy Path / 单文件右键菜单：查看差异、跳转源码、复制路径
- All icons sourced from [JetBrains IntelliJ Icons](https://intellij-icons.jetbrains.design/) (Apache 2.0)
  所有图标来源于 [JetBrains IntelliJ Icons](https://intellij-icons.jetbrains.design/)（Apache 2.0 许可）
- Unified design language: 6px border-radius, consistent hover colors (#ededed), IDEA blue focus (#3574f0)
  统一设计语言：6px 圆角、一致的悬浮颜色（#ededed）、IDEA 蓝色聚焦（#3574f0）
- File status colors matching IDEA: green (added), blue (modified), red (unversioned), gray (deleted)
  文件状态颜色匹配 IDEA：绿色（新增）、蓝色（修改）、红色（未跟踪）、灰色（删除）
- Unknown file types use IDEA-style three-line text icon / 未知文件类型使用 IDEA 风格三横线文本图标

### Changed / 变更
- Tab order: Commit | Shelf | Stash (matches IDEA layout) / 标签页顺序：Commit | Shelf | Stash（匹配 IDEA 布局）
- Global button/input border-radius unified to 6px via `--radius` CSS variable / 全局按钮/输入框圆角统一为 6px
- Tab hover/active styles match IDEA (rounded, light blue active state #dfe7f5) / 标签页悬浮/选中样式匹配 IDEA（圆角、淡蓝色选中状态）
- Context menu hover color matches existing branch panel (#e8f0fe) / 右键菜单悬浮颜色与分支面板一致
- Commit message textarea focus border uses IDEA blue (#3574f0) / 提交信息输入框聚焦边框使用 IDEA 蓝色

### Fixed / 修复
- Binary files (zip, png) now open correctly via Jump to Source / 二进制文件（zip、png）现在可以通过"跳转源码"正确打开
- Single-file shelve no longer pulls in unrelated staged files / 单文件搁置不再连带其他已暂存文件
- Shelf/Stash lists auto-refresh after operations / Shelf/Stash 列表在操作后自动刷新

## [0.3.5] - 2025-05-25

### Added
- Status bar button "IDEA Git" at the bottom to quickly open/focus the Git Graph panel

## [0.3.4] - 2025-05-25

### Fixed
- Input hover/focus border now uses hardcoded IDEA blue (#3574f0) instead of VS Code theme variable which was overriding it

## [0.3.3] - 2025-05-25

### Changed
- User and Date filter dropdowns now also have search input (same as Branch)
- Removed unused FilterDropdown component

## [0.3.2] - 2025-05-25

### Added
- Branch filter dropdown now has a search input for quick filtering when there are many branches

## [0.3.1] - 2025-05-25

### Fixed
- Filter dropdowns (Branch/User/Date) now close when clicking anywhere outside, scrolling, or window blur

## [0.3.0] - 2025-05-25

### Changed
- Input border colors match IDEA: default `#c4c4c4`, focus/hover `#3574f0`

## [0.2.9] - 2025-05-25

### Fixed
- Refresh button (built-in) also respects minimum 1s progress bar display

## [0.2.8] - 2025-05-25

### Fixed
- Progress bar shows for minimum 1 second, ensuring animation is always visible even for fast operations

## [0.2.7] - 2025-05-25

### Fixed
- Remove duplicate refresh button from panel title (keep VS Code's built-in one)

## [0.2.6] - 2025-05-25

### Fixed
- Progress bar animation improved: thicker (3px), faster (1s), gradient glow effect for better visibility

## [0.2.5] - 2025-05-25

### Fixed
- Progress bar now shows immediately when clicking git operations (checkout, push, pull, merge, rebase, cherry-pick, reset, revert, delete) instead of waiting for server response

## [0.2.4] - 2025-05-25

### Added
- Auto-maximize editor when opening Diff viewer (same as Merge editor)

## [0.2.3] - 2025-05-25

### Added
- Auto-maximize editor when opening 3-Way Merge Editor for full-screen experience

## [0.2.2] - 2025-05-25

### Added
- IDEA-style blue progress bar during async git operations (checkout, push, pull, merge, rebase, cherry-pick, reset, revert)

## [0.2.1] - 2025-05-25

### Added
- **Show File History command** — right-click a file in editor or Explorer → "IDEA Git: Show File History"
- Also available from Command Palette
- Triggers file history view in the Git Log panel

### Changed
- Command category renamed to "IDEA Git" for easy recognition

## [0.1.9] - 2025-05-25

### Added
- **Show in Git Log** — when viewing file history, right-click a commit to jump back to full log view at that commit
- **Tab-style file history** — file filter displays as a closeable tab (`History: filename.tsx ×`)

## [0.1.8] - 2025-05-25

### Fixed
- Changed Files panel now only shows the filtered file when "History Up to Here" is active

## [0.1.7] - 2025-05-25

### Added
- **History Up to Here** — right-click a file → show only commits that modified it (`git log -- <file>`)
- File filter indicator in toolbar with clear button

## [0.1.6] - 2025-05-25

### Added
- SEO keywords for Marketplace discoverability
- Improved description with more searchable terms

## [0.1.4] - 2025-05-25

### Fixed
- Repository URL now points to the correct fork

## [0.1.3] - 2025-05-25

### Added
- Chinese README (简体中文文档)
- GIF demos for branch checkout and commit context menu

## [0.1.1] - 2025-05-25

### Added
- **Branch Context Menu** — Checkout, New Branch, Checkout and Rebase, Rebase, Merge, Rename, Delete, Update, Push
- **Commit Context Menu** — Copy Revision Number, Cherry-Pick, Checkout Revision, Reset (Mixed/Soft/Hard), Revert, New Branch, New Tag
- **Changed Files Context Menu** — Show Diff, Edit Source, Open Repository Version, Revert Selected Changes, Cherry-Pick Selected Changes, Copy Path, Copy File Name
- **Branch search** — filter branches and tags by name
- **Commit filters** — filter by Branch, User, Date range
- **Resizable columns** — drag to adjust Author, Date, Hash column widths
- **Hash column** — short commit hash in dedicated column
- **Current branch indicator** — shows name next to "Current Branch"
- **IntelliJ IDEA icons** — official SVG icons from intellij-icons.jetbrains.design (Apache 2.0)
- **Context menu icons** — Cherry-Pick (cherry), Revert (undo arrow), Copy, Edit, Diff, Branch, Tag
- **IDEA-style menu colors** — light background, soft shadow, subtle borders

### Changed
- Search inputs match IDEA style with search icon and clear button
- Filter dropdowns use stroke-based chevron icons
- Folder icons use official IntelliJ folder SVG (light fill + stroke)
- Context menus render via React portal for proper positioning
- Menu auto-adjusts position to stay within viewport
- Menu dismisses on outside click, scroll, blur, and resize

## [0.0.4] - Original

- Git Graph visualization
- 3-Way Merge Editor
- Conflict List management
- Diff Editor
