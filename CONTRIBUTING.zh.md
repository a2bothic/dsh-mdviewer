# 贡献指南

[English](CONTRIBUTING.md) | **中文**

## 规则：每次变更完成后，都必须重装本机

**本项目的任何变更，在判定"完成"之前，都必须重新构建并重装到本机。**
测试全绿不算完成——安装这一步才算。

原因是自动化测试**并没有跑到真实的运行时**：

| 测试 | 实际跑的是什么 |
|---|---|
| `test/visual-check.mjs` | Chromium 里的生产**构建产物**，Tauri 桥接是**模拟**的 |
| `test/open-external.mjs` | 同上，桥接同样是模拟的，包括拖拽与二次启动路径 |
| `cargo test` | 只有 Rust 逻辑；没有窗口、没有 WebView、没有 IPC |

所以这些测试**抓不到**只存在于真实程序里的问题：真实 IPC 接口、插件装配、
窗口创建、文件关联、单实例转发、WebView2 行为。这些地方以前就出现过
"所有检查都通过、但程序实际是坏的"的情况。只有重装并真的打开一次，
才能证明用户双击的那个程序还能用。

### 完成前检查清单

每一步都要执行。只要还有一步没做，就不能说这项工作完成了。

1. **类型检查与单元测试**

   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   node_modules\.bin\tsc.cmd --noEmit
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

2. **浏览器测试**（需要 4173 端口的预览服务器）

   ```powershell
   node_modules\.bin\vite.cmd preview --port 4173 --strictPort   # 后台运行
   $env:MDREADER_HEADLESS_OLD = "1"
   node test/visual-check.mjs
   node test/open-external.mjs
   ```

3. **构建安装包**

   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   node_modules\.bin\tauri.cmd build
   ```

4. **重装到本机** —— 不可跳过，而且必须是刚构建出来的那个产物，
   不是磁盘上原有的旧版本。

   ```powershell
   Get-Process -Name dsh-mdviewer -ErrorAction SilentlyContinue | Stop-Process -Force
   $setup = Get-ChildItem "src-tauri\target\release\bundle\nsis\*-setup.exe" |
     Sort-Object LastWriteTime -Descending | Select-Object -First 1
   Start-Process $setup.FullName -ArgumentList "/S" -Wait
   ```

   安装器成功时会立刻返回，所以**不要只看退出码**，要确认已安装程序确实被刷新：

   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\Markdown Viewer" |
     Select-Object Name, LastWriteTime
   ```

   **不要拿它和 `target/release/dsh-mdviewer.exe` 比哈希。** Tauri 会按打包类型
   打标记，因此免安装版与已安装版**故意**有几字节差异：独立二进制读作
   `UNK`（unknown），NSIS 安装版读作 `NSS`。两者大小相同，只有该标记不同，
   位置大致在文件末尾前 230 KB 处。

   请检查该标记，而不是比对哈希：

   ```powershell
   $exe = "$env:LOCALAPPDATA\Markdown Viewer\dsh-mdviewer.exe"
   $b = [System.IO.File]::ReadAllBytes($exe)
   $start = $b.Length - 300000
   for ($i = $start; $i -lt $b.Length - 2; $i++) {
     if ($b[$i] -eq 0x4E -and $b[$i+1] -eq 0x53 -and $b[$i+2] -eq 0x53) {
       "NSIS 安装已确认"; break
     }
   }
   ```

   另外，**同版本**的安装包可能拒绝覆盖它认为相同的安装，所以时间戳没变
   并不能直接判定安装失败。需要确凿结论时请检查上述标记，或同时提升
   `src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 里的版本号。

5. **启动并实际验证本次改动**

   ```powershell
   Start-Process "$env:LOCALAPPDATA\Markdown Viewer\dsh-mdviewer.exe"
   ```

   打开这次改动涉及的东西并亲眼看一遍。改的是文件格式，就打开一个该类型的
   真实文件；改的是界面，就看一眼窗口。

6. **清理** —— 关掉程序与预览服务器，删除临时测试文件和截图。

### 如果改动影响了程序接受的格式或界面外观

必须在同一次变更中一并更新：

- `README.md` 与 `README.zh.md`（两个都要，否则会不一致）
- `src-tauri/tauri.conf.json` 的 `fileAssociations`——当新支持的扩展名
  也需要能从资源管理器直接打开时
- `test/visual-check.mjs`，让新行为有回归测试覆盖

## Windows 文件关联与安装包

两条规则可以避免"打开方式"里出现两个同样的图标。

**不要手工注册程序。** 把 Windows 指向一个免安装 exe（或安装目录之外的任何
副本）会在 `HKCU\Software\Classes\Applications` 下多出一条记录，资源管理器
随后就会为同一个程序显示两个一模一样的图标。如果已经出现，删掉该键，并把
对应字母从 `.sh` 的 `OpenWithList` 的 `MRUList` 值里去掉。

**让安装包独占关联。** `bundle.fileAssociations` 会为配置里的每一组注册一个
progid；如果新增的一组与已占用扩展名重叠（例如把 `sh` 同时放进
"Shell Script" 和一个大而全的 "Source File"），同一个扩展名就会被注册两次。

升级行为取决于安装模式。`bundle.windows.nsis.installMode` 为 `currentUser`，
并由 `src-tauri/nsis/hooks.nsh` 在 `NSIS_HOOK_PREINSTALL` 阶段先卸载旧副本——
包括 `HKCU` 与 `HKLM` 下的记录，以及安装目录里的残留文件——然后再写入新文件。
这个钩子就是"升级即覆盖"而不是"新旧并存"的原因。若你改动了安装目录、安装模式
或产品名，请回头检查该钩子：它依赖 `${PRODUCTNAME}` 与 `$INSTDIR`。

## Windows 注意事项

在全新的 Windows 机器上有两个坑，都不是代码问题：

1. **`cargo` 必须在 `PATH` 里。** Tauri 会调用 `cargo metadata`，而 rustup
   安装器不一定会把 `%USERPROFILE%\.cargo\bin` 加进每个 shell 的环境变量。
   如果构建报错：

   ```
   failed to run 'cargo metadata' ... program not found
   ```

   在当前会话里临时加上：

   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   ```

2. **`bundle.targets` 必须是 `"all"`**，不能写成显式的跨平台列表。
   在 Windows 上写 `dmg`、`deb`、`appimage` 会让 Tauri 中断整个打包步骤。

3. **过期的 crates.io 镜像会破坏依赖解析。** `cargo` 会读取
   `%USERPROFILE%\.cargo\config.toml`。如果它把 crates.io 替换成了镜像，
   而该镜像对 Tauri 插件的同步滞后，升级就会失败并报
   `no matching package named ... found`。此时改为直连 crates.io：

   ```toml
   [net]
   git-fetch-with-cli = true
   ```

4. **`pnpm` 可能拒绝执行构建脚本**（`esbuild` 报 `ERR_PNPM_IGNORED_BUILDS`）。
   这不影响 `vite build` 与 `tauri build`；直接调用 `node_modules\.bin`
   下的可执行文件即可绕过。

## 在其他平台构建

要构建 **Windows** 二进制必须在 Windows 上构建；从 WSL 交叉编译 Tauri 应用
需要 MSVC 工具链，开箱即用是不支持的。
