# dsh-permanent-delete

DeepSeek Harness 插件与命令行工具，用于从磁盘上**永久删除**基于 JSONL 存储的 DSH 会话。

这**不是**归档操作。它会删除 JSONL 会话根目录下该会话所属的整个目录。

## 在 DeepSeek Harness 桌面版中安装

打开桌面端的「添加插件」对话框，在输入框中粘贴本包的本地目录路径：

```text
E:\dsh删除插件
```

然后点击**安装**。

除非本包已发布到 npm，否则不要在桌面端界面中填写 `dsh-permanent-delete`。该包目前仅存在于本地，因此正确的值是本地目录路径。

安装源镜像只对 npm 包安装有效。对于本地目录安装，关键在于该路径必须指向**包含 `package.json` 的那个文件夹**。

## 通过命令行安装

在本包目录下执行：

```powershell
.\scripts\install-desktop.ps1
```

如果脚本无法自动定位桌面端 CLI，请从桌面端诊断页面复制 `dsh` CLI 的路径并显式传入：

```powershell
.\scripts\install-desktop.ps1 -DshCli "C:\path\to\dsh.cmd"
```

也可以使用桌面端 profile 手动安装：

```powershell
dsh plugin --profile desktop add .
dsh --profile desktop --dump-config
```

DeepSeek Harness 桌面版与 CLI／源码启动方式使用的是同一套可安装 bundle 机制。Harness 通过 `package.json` 中的 `dsh.bundle.patch` 加载可安装 bundle；本包提供 `cordis.patch.yml`，用于插入插件条目。

## 从 GitHub 仓库地址安装

如果你把这个仓库 fork 到了别的账号下，把下面的 `maoyu691` 换成你自己的用户名。

桌面端「添加插件」输入框，填下面任意一个：

```text
https://github.com/maoyu691/dsh-permanent-delete.git
```

或 npm 简写：

```text
github:maoyu691/dsh-permanent-delete
```

命令行：

```powershell
dsh plugin --profile desktop add https://github.com/maoyu691/dsh-permanent-delete.git
```

只想装 CLI 可执行文件的话，用 npm：

```sh
npm i -g github:maoyu691/dsh-permanent-delete
```

要锁定版本，在末尾加上 `#main`、标签（如 `#v0.2.1`）或完整 commit SHA。

几点说明：

- **安装时不会跑任何构建步骤。** `lib/client.js` 已提交进仓库，并且本包**故意不提供** `prepare` / `install` 脚本。这是刻意为之：DeepSeek Harness 的 `desktop` profile 使用 pnpm，而 pnpm 默认禁止 git 依赖执行构建脚本——除非在 `pnpm-workspace.yaml` 的 `allowBuilds` 里显式放行，否则会直接报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 导致安装失败。
- 如果你改了 `client.js`，请执行 `node build.mjs`（或 `npm run build`），并把重新生成的 `lib/client.js` 一起提交。
- 公开仓库安装无需凭证；私有仓库需要在执行安装的机器上准备 PAT 或 SSH 密钥。

## 配置会话根目录

JSONL 持久化后端将会话存储在以下路径结构中：

```text
<root>/<project-directory>/<encoded-session-id>/
```

在桌面端中，请先打开诊断页面并复制 `dshHome` 的值。如果从设置中无法直接看出会话根目录，请将 `DSH_HOME` 设为该诊断值，然后以 dry-run 模式运行 CLI。

如果你的 Harness profile 使用了非默认位置，请在桌面端 profile 覆盖配置中设置根目录：

```yaml
- id: dsh-permanent-delete
  name: dsh-permanent-delete
  config:
    root: /absolute/path/to/session-logs
```

若未配置 `root`，插件与 CLI 会按顺序尝试以下位置：

1. `DSH_SESSION_ROOT`
2. `DSH_SESSIONS_ROOT`
3. `$DSH_HOME/sessions`
4. `~/.dsh/sessions`

## 在左侧会话列表里直接删除（桌面端）

插件加载后，左侧会话列表每一行的「⋯」菜单最下方会多一条：

```text
删除会话
```

点开后会先做一次 dry run，把「将要删掉哪个目录、多少文件、多大」摆出来，确认后才真正删除。

几点说明：

- 菜单行通过客户端插槽 `sidebar.workspaces.session.menu.item` 注入，确认弹窗走 `shell.overlay`，二者都在 `lib/client.js` 里。
- 删除成功后，正在运行的 Harness 里已加载的那条会话可能仍显示在列表中，切换一次会话或重启 DeepSeek Harness 即会刷新 —— 磁盘上的文件已经删掉了。
- 宿主半边提供 `POST /plugins/dsh-permanent-delete/session`；删除必须带完全一致的确认识别串，不带就只是 dry run。

## 使用命令行

先执行 dry run：

```sh
dsh-delete-session <session-id> --root /absolute/path/to/session-logs
```

然后使用**完全一致的确认字符串**执行永久删除：

```sh
dsh-delete-session <session-id> --root /absolute/path/to/session-logs --yes "PERMANENTLY DELETE <session-id>"
```

若希望将搜索范围限定在单个项目目录，请使用 `--cwd /absolute/project/path`。

在 Windows 桌面端，如果你只知道 `dshHome` 而不知道会话根目录，可尝试：

```powershell
$env:DSH_HOME = "<dshHome from Desktop diagnostics>"
node .\bin\dsh-delete-session.js <session-id>
```

## 在 Harness 内部使用

该插件注册了以下工具：

```text
dsh_delete_session_permanently
```

推荐流程：

1. 以 `dryRun: true` 调用，或省略 `dryRun` 参数。
2. 确认匹配到的路径确实是你想删除的会话。
3. 停止正在使用该会话的其他 DSH 进程。
4. 以 `dryRun: false` 并传入 `confirm: "PERMANENTLY DELETE <session-id>"` 调用。

除非显式设置 `allowCurrentSession: true`，否则该工具拒绝删除当前正在运行的会话。

## 重要安全说明

- 本工具目前面向 `@deepseek-ai/dsh-session-persistence-jsonl` 所定义的第一方 JSONL 持久化目录结构。
- 它会删除会话所属的整个目录，包含该目录下的所有附属产物。
- 它不会调用 Harness 的归档 API，也不会保留任何可恢复的副本。
- 若在多个项目目录下发现同一 session id 的重复目录，除非 `allowMultipleMatches` 为 true，否则删除操作会被拒绝。
- 删除端点挂在 Harness 本地 web 服务上；删除仍然必须带完全一致的确认识别串，否则一律按 dry run 处理。

## 测试

```sh
npm test
```

## 重新构建浏览器端产物

桌面端加载的是 `lib/client.js`，不是 `client.js`。改完 `client.js` 后执行：

```sh
node build.mjs
```

然后重启 DeepSeek Harness。
