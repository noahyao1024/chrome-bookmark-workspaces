# Bookmark Workspaces

在 Alfred 中按自定义书签名搜索 Chrome 页面，优先切换到已打开的标签，并根据 Work、Personal 收藏夹自动分组。项目包含 Chrome 扩展、本地通信程序和独立的 Alfred 工作流。

[English](README.md) · [下载](https://github.com/noahyao1024/chrome-bookmark-workspaces/releases) · [MIT 许可](LICENSE)

## 使用方式

| 操作 | 行为 |
| --- | --- |
| `t 关键词` | 搜索书签名、目录、已打开标签和本地历史 |
| Chrome 前台按 ⌘T | 唤起同一搜索框，其他应用不受影响 |
| Return | 复用匹配的标签，或打开页面 |
| ⌘Return | 刻意另开一个标签 |
| ⌃Return | 复制完整网址 |
| 输入 `1+2` | 按原文进行 Google 搜索，保留加号 |

搜索过程在本地执行。选择网址或 Google 搜索后，Chrome 才会访问对应页面。扩展只读取书签，不改名、不移动、不删除书签。

## 安装

需要 macOS 14 或更新版本、Chrome 121 或更新版本、Alfred 5 Powerpack，以及 Python 3.9 或更新版本。发布包同时包含 Apple Silicon 和 Intel 架构。

发布程序使用临时签名，尚未通过 Apple 公证。如果 macOS 阻止运行下载的程序，可按下方步骤从源码构建，无须关闭系统安全设置。

从旧的本地版本迁移时，先停用旧分组扩展和旧 Alfred 工作流。同一套标签组只使用一个自动分组扩展。

1. 从 [Releases](https://github.com/noahyao1024/chrome-bookmark-workspaces/releases) 下载 `bookmark-workspaces-macos-universal.zip`，解压到长期保留的目录。
2. 在选定的 Chrome Profile 中打开 `chrome://extensions`，开启「开发者模式」，选择「加载已解压的扩展程序」，选中解压后的 `extension` 目录。
3. 复制扩展卡片上的 ID。在解压目录执行以下命令，将 `YOUR_EXTENSION_ID` 替换为该 ID：

   ```sh
   python3 native-bridge/install.py --extension-id YOUR_EXTENSION_ID --profile Default
   ```

4. 在扩展管理页重新加载扩展，使它连接本地通信程序。
5. 打开 `Bookmark-Workspaces.alfredworkflow`，导入 Alfred。若已有其他工作流占用 `t` 或 Chrome 的 ⌘T，先处理快捷键冲突。
6. 在 Chrome 书签栏下建立 `Work`、`Personal` 文件夹，把相应书签放入其中。子目录同样有效。

预编译包使用 `Default` Profile 目录。若使用 `Profile 1` 等其他目录，需要按英文说明生成匹配的自定义包。本地通信程序和扩展只支持同时服务一个 Profile。目录名可在 `chrome://version` 的「Profile Path」中查看，它不一定等于界面中的 Profile 名称。

如果历史记录或备用书签读取失败，为 Alfred 开启「完全磁盘访问权限」。如果备用标签切换提示无法控制 Chrome，为 Alfred 开启相应「自动化」权限。普通搜索不需要屏幕录制或输入监控权限，也不需要开启 Chrome 的「JavaScript from Apple Events」。

## 自动分组与复用

- Work、Personal 书签进入相应的同窗口标签组。没有任何已打开的同类组时，扩展创建一个；其他窗口已有同类组时，保持标签原位，不再复制组。
- 已固定、无痕和已手动分组的标签保持原状。Chrome 已保存但关闭的组无法通过普通标签组 API 查询。
- 普通链接按完整网址匹配。可通过 `config.local.json` 配置特定站点、路径范围的工作区入口复用，具体格式见 [英文配置说明](README.md#configure-app-entry-reuse)。
- Gmail 邮箱复用区分账号编号。多个尚未绑定的工作区页面会显示为独立结果，选择后记住该标签。
- `Archive`、`Archived` 下的书签排在现用书签之后，仍可输入 `archive` 或「归档」搜索。同名异址书签在副标题显示地区、方向或视图区别，名称保持原样。
- 历史结果最多显示 10 条。最近标签往返命令可在 `chrome://extensions/shortcuts` 绑定 Chrome 允许的快捷键；Control-Tab 等保留组合可能无法绑定。

## 从源码构建

源码构建还需要 Xcode Command Line Tools。测试需要 Node.js 20 或更新版本，无须安装 npm 运行时依赖。

```sh
python3 build.py
npm test
python3 build_launcher.py --universal
python3 scripts/package.py --skip-build
```

产物位于 `dist/`。自定义配置应保存为 Git 忽略的 `config.local.json`，再执行 `python3 scripts/package.py --config config.local.json`。包含私人配置的产物只用于本机，不应公开发布。

默认安装不包含按键采集程序。确有真实按键耗时诊断需求时，再按 [诊断说明](timing/README.md) 单独安装并授权。缓存、权限和数据边界见 [SECURITY.md](SECURITY.md)。

## 卸载

移除 Alfred 工作流和 Chrome 扩展后，执行：

```sh
python3 native-bridge/install.py --uninstall
```

卸载保留书签、标签、分组、缓存和日志。可选诊断程序需单独卸载。
