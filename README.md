# DSH UI 编辑器

在 DeepSeek Harness 桌面版的项目侧栏打开 OpenPencil 画布。画布里的 Agent 可以生成和修改界面，输入框内可选择模型与思考深度；点击对话顶部的向下箭头可以收起聊天框。已保存的画板可以预览，也可以导出为项目内的 React 页面。

## 准备开发环境

使用 Node.js 24 和 pnpm 11。在仓库根目录安装锁定依赖，生成校准页及其依赖的组件清单和主题 token。

```sh
pnpm install --frozen-lockfile
pnpm run prepare:demo
pnpm run check
pnpm exec tsc --noEmit -p harness/tsconfig.json
pnpm test
```

`examples/mcp-center.op` 是用于测试的合成 MCP 中心示例，涵盖默认、加载、空和错误状态。首次运行 `prepare:demo` 时，脚本将示例复制到 `design/pages/mcp-center.op`。如果已有同名稿件，脚本会保留并使用现有稿件。

用以下命令启动示例预览，或者用 `pnpm uic --help` 查看编译器命令。

```sh
pnpm exec vite --config harness/vite.config.ts
```

## 构建桌面插件

当前桌面集成基于 `@zseven-w/dsh-openpencil@0.1.0-rc.15`，生成版本为 `0.1.0-rc.15.uic.18`。构建器会校验上游包名、版本及两个入口文件的 SHA-256。运行过 `prepare:demo` 后，在仓库根目录执行以下命令。

```sh
mkdir -p artifacts/upstream
npm pack @zseven-w/dsh-openpencil@0.1.0-rc.15 --ignore-scripts --pack-destination artifacts/upstream
tar -xzf artifacts/upstream/zseven-w-dsh-openpencil-0.1.0-rc.15.tgz -C artifacts/upstream
node dsh-entry/build.mjs artifacts/upstream/package
```

产物会出现在 `artifacts/dsh-sidebar-button/`。该构建为本机使用，会记录构建目录来识别校准项目。预览工作进程使用 macOS DSH 应用包附带的 Node.js。适配所用 DSH UI 依赖版本为 `0.2.2-alpha.2`。

在 macOS 上，保存工作并退出 DSH，然后在同一目录使用桌面版自带的 CLI 安装。安装后重新打开 DSH，在本地磁盘项目的侧栏点击「UI 设计编译器」。

```sh
DSH_RESOURCES="/Applications/DeepSeek Harness.app/Contents/Resources/runtime"
DSH_DESKTOP_PRIMARY_RUNTIME_DIR="$DSH_RESOURCES/primary-runtime" "$DSH_RESOURCES/cli/bin/dsh" plugin --profile desktop add "file:$PWD/artifacts/dsh-sidebar-button/zseven-w-dsh-openpencil-0.1.0-rc.15.uic.18.tgz" --config.auto-install-peers=false
```

普通项目的设计稿保存到 `design/pages/ui.op`。项目侧栏里的「页面预览」读取该项目已保存的画板。导出的 React 页面位于同一项目的 `design/generated/<内容哈希>/UiPage.tsx`。

上游 OpenPencil 插件、DSH UI 原语和主题的许可见 `third-party-licenses/`。第三方运行时依赖按各自软件包附带的条款分发。
