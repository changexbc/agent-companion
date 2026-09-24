# GitHub Actions 构建

`.github/workflows/build.yml` 支持手动构建和版本标签构建。在 GitHub 仓库的 **Actions → Build desktop app → Run workflow** 中，可选择全部平台或单个平台；安装包保存在该次运行的 Artifacts 中，不会创建 Release。

| 平台 | runner | 产物 |
| --- | --- | --- |
| macOS Apple Silicon | `macos-15` | 包含 `.app` 的 zip |
| macOS Intel | `macos-15-intel` | 包含 `.app` 的 zip |
| Windows x64 | `windows-2025` | NSIS `-setup.exe` |
| Linux x64 | `ubuntu-24.04` | `.deb` 和 `.AppImage` |

推送 `vX.Y.Z` 标签时，工作流会先检查标签版本与 `package.json`、`src-tauri/tauri.conf.json` 的 `version` 一致，再构建全部平台。全部成功后，安装包会进入同名**草稿 Release**，供安装验证后发布。标签构建无需另设发布密钥；Release 使用工作流的 `GITHUB_TOKEN`。

每个平台都在本架构 runner 上执行 Tauri 的 `beforeBuildCommand`，编译并嵌入对应架构的 `agent-studio-runtime`。macOS 包当前没有开发者签名和公证；Windows / Linux 的安装与运行尚未验证。Actions 构建成功只表示产物已生成，不代表目标系统上的 Hooks / Webhook、托盘和透明窗口均已通过验收。
