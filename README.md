# DSH UI 编辑器

在 DeepSeek Harness 桌面版的项目侧栏打开 OpenPencil 画布。画布里的 Agent 可以生成和修改界面，输入框内可选择模型与思考深度；点击对话顶部的向下箭头可以收起聊天框。输入框支持选择或拖入图片/文件作为参考，图片也可以直接放进画布成为图层；画布聊天自带会话切换与「新会话」，不同会话共享同一份设计稿但各自保留对话记录。已保存的画板可以预览，也可以导出为项目内的 React 页面；设计稿和上传资源的目标文件夹可在画布标题栏按项目配置。

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

当前桌面集成基于 `@zseven-w/dsh-openpencil@0.1.0-rc.15`，生成版本为 `0.1.0-rc.15.uic.37`。构建器会校验上游包名、版本及两个入口文件的 SHA-256。运行过 `prepare:demo` 后，在仓库根目录执行以下命令。

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
DSH_DESKTOP_PRIMARY_RUNTIME_DIR="$DSH_RESOURCES/primary-runtime" "$DSH_RESOURCES/cli/bin/dsh" plugin --profile desktop add "file:$PWD/artifacts/dsh-sidebar-button/zseven-w-dsh-openpencil-0.1.0-rc.15.uic.37.tgz" --config.auto-install-peers=false
```

普通项目的设计稿默认保存到 `design/pages/ui.op`，上传资源默认保存到 `design/assets/`。画布标题栏的「目标目录」可以修改这两个相对目录；配置写入项目的 `.dsh/ui-compiler/config.json`，预览和导出跟随同一绑定。上传文件按内容哈希命名，同一文件重复上传不会产生副本。项目侧栏里的「页面预览」读取该项目已保存的画板。导出的 React 页面位于同一项目的 `design/generated/<内容哈希>/UiPage.tsx`。

### 与画布 Agent 协作

在画布聊天输入框底部点模型左侧的分支按钮，选择 1–6 位 Agent。「分工协作」将需求拆成互补的画板，「分别创建版本」让每位 Agent 完成同一个需求，并可分别指定模型。「逐一探索变体」可在初稿之后追加 1–5 轮，每轮基于上一版探索布局、风格或创意。运行中可展开任务计划和每位 Agent 的工具调用。画布上的指针标出 Agent 的工作区域；已绘制的画板可以直接查看。需要调整时，在同一输入框追加要求，处理状态和结果会出现在当前任务里。拖动画布对话框顶边可以调节消息区高度。

画布 Agent 可以查找当前页或选区中的图层，按图层 ID 原位编辑文字、样式和图标，创建可编辑控件，也可以按要求移除指定图层。展开回复下的「工具调用」可查看每次实际读取或编辑的结果。每位 Agent 完成一张画板后就会写入当前页，其余 Agent 可以继续工作。

### 导入 Pencil 稿件

在项目画布顶部点「导入 .pen」，或将一份 Pencil JSON 稿件拖入画布。稿件引用本地配图时，按显示的相对路径选择对应图片。导入会把画板和图层追加到当前页，可继续选中、编辑并保存。要让画布 Agent 分析稿件，可用聊天框的「＋」添加 `.pen`，直接询问画板、图层或文案。

项目画布打开已保存的设计稿时，会按稿件实际用到的字体加载 Noto Sans SC、IBM Plex Mono 或 Newsreader。Pencil 字体变量会关联到对应的字体资源，原稿仍保留变量绑定。字体文件和各自的开源许可随插件提供。

## 画布会话

画布聊天顶部有会话下拉框和「新会话」。每个项目画布各自保存对话记录到 `.dsh/ui-compiler/conversations.json`，切换会话只切换聊天记录和模型的上一版画板引用，不改变当前设计稿；新建会话从空白记录开始，并显示一句引导。旧的 `ui.history.json` 会在首次打开时迁移为第一个会话。每个项目最多创建 20 个会话。达到上限后，新建会话时会收到提示。每个会话保留最近 60 轮记录。

## 画布工具

画布打开后，DSH 主 Agent 可以使用以下工具操作当前项目的画布。

| 工具 | 作用 |
| --- | --- |
| `uic_canvas_select` | 按节点 id 或图层名选中节点，或列出当前页的顶层画板和选区。 |
| `uic_canvas_draw` | 在指定位置画矩形、椭圆、文字或空 frame，支持填充色、圆角和字号。 |
| `uic_canvas_move` | 按节点 id 移动或缩放已有图层。 |
| `uic_canvas_image` | 把用户上传到本项目的图片插入为图片图层。 |
| `uic_canvas_read` | 按选区、节点 ID 或关键词读取图层、文案与样式。 |
| `uic_canvas_edit` | 使用最近读取的页面版本，按图层 ID 批量修改文字、样式或结构。 |

工具要求「UI 设计编译器」画布已在项目侧栏打开；写入先进入实时画布，仍需在画布中点击保存才写入 `.op` 文件。编辑器自身不提供箭头/连线节点，插件也不伪造该类型；需要选择或指向时使用 `uic_canvas_select`。

上游 OpenPencil 插件、DSH UI 原语和主题的许可见 `third-party-licenses/`。第三方运行时依赖按各自软件包附带的条款分发。
