# GitHub Actions 构建与发布

`.github/workflows/build.yml` 支持手动构建和版本标签构建。在 GitHub 仓库的 **Actions → Build desktop app → Run workflow** 中，可选择全部平台或单个平台；安装包保存在该次运行的 Artifacts 中，不会创建 Release。

| 平台 | runner | 安装包 | 应用内更新包 |
| --- | --- | --- | --- |
| macOS Apple Silicon | `macos-15` | 包含 `.app` 的 zip | `Agent-Companion_macos_aarch64.app.tar.gz` |
| macOS Intel | `macos-15-intel` | 包含 `.app` 的 zip | `Agent-Companion_macos_x86_64.app.tar.gz` |
| Windows x64 | `windows-2025` | NSIS `Agent-Companion_windows_x86_64-setup.exe` | 同一个安装包 |
| Linux x64 | `ubuntu-24.04` | `.deb`、`Agent-Companion_linux_x86_64.AppImage` | 同一个 AppImage |

推送 `vX.Y.Z` 标签时，工作流会先检查标签版本与 `package.json`、`src-tauri/tauri.conf.json` 的 `version` 一致，再构建全部平台。全部成功后，安装包、更新包、`.sig` 与合并出的 `latest.json` 会进入同名**草稿 Release**，供安装验证后发布。标签构建无需另设发布密钥；Release 使用工作流的 `GITHUB_TOKEN`。

每个平台都在本架构 runner 上执行 Tauri 的 `beforeBuildCommand`，编译并嵌入对应架构的 `agent-studio-runtime`。macOS 包当前没有开发者签名和公证；Windows / Linux 的安装与运行尚未验证。Actions 构建成功只表示产物已生成，不代表目标系统上的 Hooks / Webhook、托盘和透明窗口均已通过验收。

## 更新签名密钥

应用内更新只信任**构建时**写入的 minisign 公钥，签名私钥只存在于 CI 机密与你自己备份的离线副本中，绝不进入仓库、日志或产物。

首次配置：

1. 在可信机器上生成一对本应用专用密钥（不要复用 wb-switch 或其他应用的密钥）：
   ```sh
   npx tauri signer generate -w ~/.tauri/agent-companion.key
   ```
2. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中配置：
   - **Variables**：`TAURI_UPDATER_PUBKEY` = 公钥内容（`~/.tauri/agent-companion.pub`）
   - **Secrets**：`TAURI_SIGNING_PRIVATE_KEY` = 私钥内容（`~/.tauri/agent-companion.key`）
   - **Secrets**（仅当私钥有密码）：`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
3. 离线备份私钥并记录口令。私钥丢失后只能用一对新密钥重签，旧版本不会信任新密钥：用户需要手动安装一次新版本，或继续用旧密钥签名一个过渡版本。

CI 行为：

- 标签构建带 `--require-signing`：公钥缺失会立即失败，不会创建不可更新的 Release；私钥缺失时 Tauri 打包也会失败（`A public key has been found, but no private key`）。
- 手动构建带 `--optional-signing`：未配置公钥时把 `bundle.createUpdaterArtifacts` 改为 `false`，只产出用于试装的安装包。
- `scripts/configure-updater.mjs` 只把公钥写进构建检出中的 `src-tauri/tauri.conf.json`，并校验 `plugins.updater.endpoints` 指向本仓库的 `latest.json`；私钥从不经过该脚本，也不打印。

仓库内的 `src-tauri/tauri.conf.json` 刻意保留 `"pubkey": ""`：本地 `npm run desktop:build` 通过 `--config` 关闭更新产物（不需要任何密钥），开发构建因此只显示「当前构建未配置更新签名公钥」，不会误报可更新。发布构建由 CI 注入公钥。

## 更新清单与发布门禁

每个矩阵任务在打包后由 `scripts/update-manifest.mjs collect` 断言该平台**恰好一个**签名更新包及其 `.sig`，把更新包改名为固定的发布资产名，并写出 `update-fragment-<平台>.json`。Release 任务运行 `node scripts/update-manifest.mjs merge`，只有全部条件成立才会生成 `latest.json`：

- 四个平台片段齐全，且版本与标签一致；
- 平台键恰好为 `darwin-aarch64`、`darwin-x86_64`、`windows-x86_64-nsis`、`windows-x86_64`、`linux-x86_64`；
- 每个地址都是本 Release 资产（`https://github.com/changexbc/agent-companion/releases/latest/download/<资产名>`），且资产确实存在于产物目录；
- 每个更新包都有非空签名，不同更新包的签名不重复。

`latest.json` 与更新包一起进入**草稿** Release。`/releases/latest/download/latest.json` 指向最近一个已发布版本，所以草稿期间线上客户端看到的仍是上一个稳定版；发布后才会切换到新版本。

发布前需要人工验证（每个平台都要做）：

1. 在干净系统或干净用户目录安装本次草稿中的安装包；
2. 把上一稳定版升级到本次草稿版本：打开设置 → 更新，确认状态从「发现新版本」走到下载完成，点击「重启并安装」后版本号更新；
3. 确认升级失败、断网、代理无效等情况下界面显示错误且可重试，且不会自动安装或重启；
4. 全部通过后再发布草稿。任一平台失败：修复并重建同一候选版本，或保留草稿不发布。

> 可选加固（本轮不启用）：首次签名发布时评估 Tauri updater 2.12+ 的 `requireSignedVersion`——它要求清单声明的版本号与更新包内已签名版本一致，防止 `latest.json` 被换成「更高版本号 + 旧的已签名包」来阻断升级。评估通过前不启用，也不修改配置。

## 平台注意事项

- **macOS**：当前 `.app` 未做开发者签名与公证，Gatekeeper 首次启动的提示见 [README](../README.md#macos-注意事项)。更新签名只保证更新包来源可信，不替代系统代码签名/公证；升级后的新版本仍会走同样的 Gatekeeper 流程。升级需要应用有写权限（`/Applications` 下由用户确认授权）。
- **Windows**：更新包就是 NSIS 安装器。安装器运行时应用会退出，属于预期行为；卸载或管理员安装模式请按 NSIS 的提示处理。Windows 尚未做过实机验收。
- **Linux**：只有 AppImage 支持应用内更新，且必须从 AppImage 启动（`$APPIMAGE` 指向自身）；`.deb` 安装的版本请手动下载新包升级。Linux 尚未做过实机验收。

## 本地验证

```sh
npm test                                                  # 含更新契约与发布清单用例
cargo test --manifest-path src-tauri/Cargo.toml           # 更新状态机、代理校验、配置读写
node scripts/update-manifest.mjs merge --dir <产物目录> --version <版本>   # 用真实产物复核清单
```

没有签名私钥时无法在本地产出可被信任的更新包；请在草稿 Release 的安装验证中完成签名链路验收。
