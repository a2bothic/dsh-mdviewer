# Markdown Viewer

[English](README.md) | **中文**

[![CI](https://github.com/a2bothic/dsh-mdviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/a2bothic/dsh-mdviewer/actions/workflows/ci.yml)

一个轻量的桌面文档浏览器：打开一个文件夹，浏览其中的文档并做全文搜索，
排版沿用 DeepSeek Harness Web GUI 的阅读样式。Markdown 按正文阅读，
shell 脚本、源码与配置文件则以高亮源码的形式阅读。

基于 **Tauri v2**（Rust 后端 + 系统自带 WebView）构建，因此安装包只有几 MB，
而 Electron 方案需要约 100 MB。

![阅读界面](docs/images/screenshot-light.png)

## 功能

- **文件夹浏览** —— 打开一个文件夹，其下所有文档都会按目录分组显示在侧边栏。
  包括 Markdown（`.md`、`.markdown`、`.mdx` 等）、纯文本（`.txt`、`.log`、
  `.rst`、`.csv`）、脚本（`.sh`、`.bash`、`.zsh`、`.fish`、`.ps1`、`.bat`）、
  源码（`.py`、`.rs`、`.go`、`.ts` 等）以及配置与标记文件（`.json`、`.yaml`、
  `.toml`、`.html`、`.css` 等）。
- **各类文件都能正确阅读** —— Markdown 按正文解析；其余受支持的格式则以
  语法高亮的源码视图呈现，因此 shell 脚本的 `#!`、`#` 注释和 `$` 变量都会
  原样保留，不会被 Markdown 的标题、强调规则误伤。超长行会按阅读栏宽度
  自动折行并带悬挂缩进，不会在整块区域下面压出一条横向滚动条。
- **多标签页** —— 每打开一个文档都会新增一个页签，而不是覆盖掉正在看的那篇，
  因此可以同时开着多篇随时切换。页签会记住各自的滚动位置和大纲；
  `Ctrl+W` 关闭当前页签，`Ctrl+Tab` 循环切换，`Ctrl+Shift+T` 恢复刚关掉的页签，
  中键点击也可关闭。页签过多时标签栏会横向滚动。
  页签仅在本次运行期间有效：关闭软件再打开时，页签是空的。
- **全文搜索** —— 一个输入框搜索整个文件夹，结果带上文件名、行号和匹配行高亮。
- **阅读排版** —— 行宽、间距节奏和字体栈移植自 DeepSeek Harness 前端
  （见[排版](#排版)）。
- **大纲导航** —— 根据文档标题自动生成，点击跳转。
- **侧边栏可收起** —— 点 *Sidebar* 按钮或按 `Ctrl+B` 收起整个左侧面板，
  文档区会在整个窗口宽度内重新居中。
- **两个面板都可整体隐藏** —— 点 *Outline* 或 *Documents* 按钮（或 `Ctrl+O` / `Ctrl+D`）
  可让该面板整体消失；隐藏文件列表后大纲会占满整个左栏，阅读时更清爽。
- **可拖动分割** —— 左栏是一个整体，被分隔条分为上下两块；拖动分隔条即可决定各自占比。
  分割比例会被记住，方向键可微调，双击恢复默认。
- **代码高亮、公式、表格、任务列表** —— 通过 marked、Shiki（明暗双主题）
  和 KaTeX 支持 GitHub 风格 Markdown。
- **阅读控制** —— 列宽、字号、明暗主题。
- **可从外部打开文件** —— 可设为 `.md`、`.sh` 及大多数源码与配置类型的默认
  打开方式，或把文件拖入窗口。文件所在目录会成为工作区，因此侧栏和搜索覆盖同
  目录的其他文档。

偏好设置（主题、侧边栏状态、分隔条位置、工作区文件夹）保存在 `localStorage`
中。打开的页签**刻意不做**持久化：每次启动都是空标签栏，新会话不会残留上次
正在读的内容。

**刻意不做**的功能：编辑、笔记双链、同步、插件、Agent、终端。这是一个纯粹的阅读器。

## 界面一览

**多标签页** —— 每个文档各占一个页签，可以同时打开多篇并在其间切换，
各自保留阅读位置。

![以页签展示多个打开的文档](docs/images/screenshot-tabs.png)

**全文搜索** —— 结果带上文件名、行号和高亮片段，点击即可打开。

![侧边栏搜索结果](docs/images/screenshot-search.png)

**代码与公式** —— Shiki 高亮，明暗双主题；公式由 KaTeX 渲染。

![代码块与公式渲染](docs/images/screenshot-code.png)

**面板可整体隐藏** —— 隐藏文件列表后大纲占满整个左栏，恢复时保持原有分割比例。

![Documents 分区收起](docs/images/screenshot-sections.png)

**暗色主题**与**可收起的侧边栏** —— 收起后文档区在整个窗口宽度内重新居中。

| 暗色主题 | 侧边栏收起 |
|---|---|
| ![暗色主题](docs/images/screenshot-dark.png) | ![侧边栏收起](docs/images/screenshot-collapsed.png) |

## 安装

从 [Releases 页面](https://github.com/a2bothic/dsh-mdviewer/releases/latest)
下载对应平台的安装包：

| 平台 | 文件 | 大小 |
|---|---|---|
| Windows（安装包） | `Markdown.Viewer_0.1.0_x64-setup.exe` | 2.2 MB |
| Windows（MSI） | `Markdown.Viewer_0.1.0_x64_en-US.msi` | 2.7 MB |
| Windows（免安装） | `dsh-mdviewer.exe` | 4.2 MB |
| macOS（通用二进制） | `Markdown.Viewer_0.1.0_universal.dmg` | 5.0 MB |
| Linux（Debian） | `Markdown.Viewer_0.1.0_amd64.deb` | 2.9 MB |
| Linux（AppImage） | `Markdown.Viewer_0.1.0_amd64.AppImage` | 78 MB |

Windows 可执行文件未做代码签名，首次运行可能触发 SmartScreen 警告：
点「更多信息」→「仍要运行」即可。

## 环境要求

| | |
|---|---|
| Node.js | 20.19 或更高（推荐 24 LTS） |
| pnpm | 9 或更高 |
| Rust | stable，1.77+ |
| Windows | WebView2 运行时（Windows 11 及较新的 Windows 10 已预装） |

## 开发

```bash
pnpm install
pnpm dev:desktop     # 启动 Tauri 窗口，支持热重载
```

> **贡献者请注意：每次变更完成后都必须重装本机。** 浏览器测试跑的是构建产物，
> 且 Tauri 桥接是**模拟**的，因此抓不到真实 IPC 接口、插件装配、窗口创建
> 等环节的故障。只有重新构建并重装，才能证明交付给用户的程序仍然可用——
> 完成检查清单见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

## 构建

```bash
pnpm build:desktop
```

产物位于 `src-tauri/target/release/bundle/`：

- Windows —— `nsis/*.exe`（安装包）和 `msi/*.msi`，另有免安装 exe 在
  `target/release/`
- macOS —— `dmg/*.dmg`
- Linux —— `deb/*.deb`、`appimage/*.AppImage`

构建 **Windows** 版本必须在 Windows 上进行；从 WSL 交叉编译 Tauri 应用需要
MSVC 工具链，开箱不支持。新机器上会踩的坑——`cargo` 不在 `PATH`、crates.io
镜像过期、`pnpm` 拒绝执行构建脚本——统一收集在
[CONTRIBUTING.zh.md](CONTRIBUTING.zh.md#windows-注意事项)。

## 排版

## 排版

阅读区没有沿用浏览器默认样式，而是复刻了 DeepSeek Harness 的 markdown token，
因为这些参数才是"读着舒服"的关键。具体值在 `src/styles/tokens.css` 和
`src/styles/typography.css`：

| 项目 | 取值 | 原因 |
|---|---|---|
| 正文行高 | 固定 `24px` | 用固定像素而非比例，改字号时节奏整体等比缩放 |
| 段间距 | `16px` | 行高的三分之二 —— 段落成组，而不是散开 |
| 标题边距 | 上 `32px`、下 `16px` | 非对称，让标题归属于其下方的内容 |
| 列表缩进 | `18px` | 比浏览器默认的约 40px 紧凑很多 |
| 列表项间距 | `6px` | 很小，但明显提升扫读效率 |
| 分隔线 | `0.5px` | 发丝线，而不是一道分割 |
| 加粗字重 | `600` | 不用 `700`，后者在正文里显得过重 |
| 行内代码 | `.875em` | 等宽字体在同样字号下视觉偏大，缩到 87.5% 才等重 |

字体栈还把中文字体放在 `sans-serif` **之前**，这样中英文基线保持一致：

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
             "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue",
             Helvetica, Arial, sans-serif;
```

调整 `--base-size` 和 `--measure` 即可改变默认字号和列宽，
派生出的整套节奏会自动重算。

## 架构

```
src/
  main.ts             应用外壳：页签栏、侧边栏、工具栏、搜索界面
  lib/api.ts          Rust 命令的类型化封装
  lib/render.ts       渲染管线（marked + Shiki + KaTeX + DOMPurify）
  styles/tokens.css   设计 token（字体、颜色、节奏）
  styles/typography.css  阅读区规则
  styles/app.css      外壳布局
src-tauri/
  src/lib.rs          scan_folder / read_document / search_documents / pick_folder
```

页签保存的是文档渲染后的快照，而不是重新读取文件，因此切换是瞬时的，
每个页签也都保留自己的滚动位置和大纲。打开一个已经打开的路径时，
会激活它已有的页签，而不会再开一份副本。页签不写入存储，所以每次启动
都是空标签栏。

所有文件系统访问都在 Rust 侧完成，WebView 不直接接触磁盘，
因此 CSP 可以保持严格，IPC 层也不存在任何写接口。

### 文件走哪条管线

`render.ts` 只暴露一个入口 `renderDocument(path, text)`，按扩展名选择管线：

- **Markdown**（`.md`、`.markdown`、`.mdx` 等）走下面这套完整管线。
- **其余受支持的格式**按源码高亮：整个文件成为单个 Shiki 代码块，
  并标注语言。扩展名通过 `EXTENSION_LANGUAGES` 映射到 Shiki 语言 id；
  未知扩展名退化为无色纯文本，而不是报错。

哪些文件会被扫描由后端决定（`src-tauri/src/lib.rs` 中的 `DOC_EXTENSIONS`），
每个被接受的文件如何显示则由前端决定。

### 渲染顺序

`render.ts` 中的顺序是刻意安排的：

1. 先把围栏代码块提取出来，代码里的 `$` 才不会被当成数学公式。
2. 把 `$…$` 和 `$$…$$` 渲染成 KaTeX HTML 并替换为占位符，
   避免强调语法吃掉公式字符。
3. marked 解析剩余内容。
4. DOMPurify 净化，同时放行 KaTeX 所需的标签和属性。
5. 把 KaTeX HTML 还原回去。

## 测试

```bash
bash scripts/check.sh                     # 类型检查 + 构建 + Rust 单测 + 浏览器测试
node test/visual-check.mjs                # 在真实 Chromium 中针对构建产物跑 93 项检查
python3 src-tauri/test-search-window.py   # 搜索高亮偏移的正确性
```

浏览器测试用模拟的 Tauri 桥接驱动**真实的生产构建产物**，同时断言 DOM 和
**计算后的排版值**（行高、间距、列表缩进、列宽），所以 CSS 一旦回归就会失败。
它同时覆盖两处最容易回归的行为：重启后回到空标签栏，以及非 Markdown 文件
按源码高亮而不是被当成 Markdown 解析。截图输出到 `test-output/`。

Rust 单测覆盖搜索逻辑：扫描过滤、目录跳过、相对路径、行号、**高亮偏移**
（含中文与超长行截断）、结果数量上限，以及扩展名识别（含大小写不敏感）。

## 许可证

MIT
