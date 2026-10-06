# dsh-permanent-delete

DeepSeek Harness plugin and CLI for permanently deleting JSONL-backed DSH sessions from disk.

This is intentionally not an archive operation. It removes the matched session-owned directory under the JSONL session root.

## Install for DeepSeek Harness Desktop UI

Open Desktop's **Add plugin** dialog and paste this local package directory into the input:

```text
E:\dsh删除插件
```

Then click **Install**.

Do not enter `dsh-permanent-delete` in the Desktop UI unless this package has been published to npm. The package exists locally, so the correct value is the local directory path.

The install source mirror only matters for npm package installs. For this local directory install, the important part is that the path points at the folder containing `package.json`.

## Install from command line

From this package directory:

```powershell
.\scripts\install-desktop.ps1
```

If the script cannot find the desktop CLI automatically, copy the `dsh` CLI path from the Desktop diagnostics page and pass it explicitly:

```powershell
.\scripts\install-desktop.ps1 -DshCli "C:\path\to\dsh.cmd"
```

You can also install manually with the Desktop profile:

```powershell
dsh plugin --profile desktop add .
dsh --profile desktop --dump-config
```

DeepSeek Harness Desktop uses the same installable bundle system as the CLI/source launches. Harness loads installable bundles from `package.json` via `dsh.bundle.patch`; this package contributes `cordis.patch.yml`, which inserts the plugin row.

## Install from a GitHub repository

Replace `maoyu691` below if you fork this repo under a different account.

Desktop UI — paste one of these into the **Add plugin** input:

```text
https://github.com/maoyu691/dsh-permanent-delete.git
```

or the npm shorthand:

```text
github:maoyu691/dsh-permanent-delete
```

Command line:

```powershell
dsh plugin --profile desktop add https://github.com/maoyu691/dsh-permanent-delete.git
```

Plain npm, if you only want the CLI binary:

```sh
npm i -g github:maoyu691/dsh-permanent-delete
```

To pin a revision, append a committish: `#main`, a tag such as `#v0.2.1`, or a full commit SHA.

Notes:

- **No build step runs at install time.** `lib/client.js` is committed to the repo and the package deliberately ships **no** `prepare` or `install` script. This is deliberate: pnpm — which the DeepSeek Harness `desktop` profile uses — refuses to run build scripts for git-hosted packages unless they are allowlisted under `allowBuilds` in `pnpm-workspace.yaml`, and fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` otherwise.
- If you edit `client.js`, run `node build.mjs` (or `npm run build`) and commit the regenerated `lib/client.js`.
- A public repo installs without credentials. A private repo needs a PAT or SSH key on the machine doing the install.

## Configure the session root

The JSONL persistence backend stores sessions under:

```text
<root>/<project-directory>/<encoded-session-id>/
```

In Desktop, open the diagnostics page first and copy the `dshHome` value. If the session root is not obvious from your settings, run the CLI in dry-run mode with `DSH_HOME` set to that diagnostics value.

Set the root in your desktop profile override if your Harness profile uses a non-default location:

```yaml
- id: dsh-permanent-delete
  name: dsh-permanent-delete
  config:
    root: /absolute/path/to/session-logs
```

If `root` is not configured, the plugin and CLI try these in order:

1. `DSH_SESSION_ROOT`
2. `DSH_SESSIONS_ROOT`
3. `$DSH_HOME/sessions`
4. `~/.dsh/sessions`

## Delete from the sidebar (Desktop UI)

Once the plugin is loaded, every row in the left session list gets one extra entry at the bottom of its `...` menu:

```text
删除会话 / Delete session
```

Clicking it opens a confirm dialog that first dry-runs and shows the exact directory, file count and size that will go away; confirming calls the plugin's host endpoint and removes the directory from disk.

Notes:

- The menu row is contributed through the `sidebar.workspaces.session.menu.item` client slot, and the confirm dialog through `shell.overlay`. Both come from `lib/client.js`.
- After a successful delete, a session that is still loaded in the running Harness may stay visible in the list until you switch sessions or restart DeepSeek Harness. The files are gone either way.
- The host half serves `POST /plugins/dsh-permanent-delete/session`. Deleting requires the exact `confirm` string, so a stray request without it is only a dry run.

## Use the CLI

Dry run first:

```sh
dsh-delete-session <session-id> --root /absolute/path/to/session-logs
```

Then delete permanently with the exact confirmation string:

```sh
dsh-delete-session <session-id> --root /absolute/path/to/session-logs --yes "PERMANENTLY DELETE <session-id>"
```

Use `--cwd /absolute/project/path` if you want to narrow the search to one project directory.

On Windows Desktop, if you know `dshHome` but not the session root, try:

```powershell
$env:DSH_HOME = "<dshHome from Desktop diagnostics>"
node .\bin\dsh-delete-session.js <session-id>
```

## Use inside Harness

The plugin registers this tool:

```text
dsh_delete_session_permanently
```

Recommended flow:

1. Call it with `dryRun: true` or omit `dryRun`.
2. Confirm the matched path is the session you want gone.
3. Stop other DSH processes using that session.
4. Call it with `dryRun: false` and `confirm: "PERMANENTLY DELETE <session-id>"`.

The tool refuses to delete the currently running session unless `allowCurrentSession: true` is set.

## Important safety notes

- This currently targets the first-party JSONL persistence layout documented by `@deepseek-ai/dsh-session-persistence-jsonl`.
- It deletes the whole session-owned directory, including side artifacts inside that directory.
- It does not call a Harness archive API and does not preserve a recoverable copy.
- If duplicate directories for the same session id are found under multiple project directories, deletion is refused unless `allowMultipleMatches` is true.
- The delete endpoint is served by the local Harness web server. Deletion still requires the exact `confirm` string, so anything else is answered as a dry run.

## Test

```sh
npm test
```

## Rebuild the browser bundle

The Desktop serves `lib/client.js`, not `client.js`. After editing `client.js`, rebuild and restart DeepSeek Harness:

```sh
node build.mjs
```
