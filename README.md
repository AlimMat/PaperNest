# PaperNest

PaperNest 是一个面向 Windows 的本地论文阅读与写作工具：把 PDF 阅读、批注、笔记、文献整理和 Markdown／Word／LaTeX 写作放在同一个界面中。数据默认保存在本机，阅读和写作都不需要上传到第三方服务。

## 核心功能

- **论文管理**：导入 PDF，使用自定义分组整理；一篇论文可以属于多个分组。
- **原始 PDF 阅读**：保持 PDF 原始版式，支持缩放、连续阅读、文字选择、高亮、定位笔记和图片笔记。
- **阅读设置**：支持主题、字号、PDF 背景、侧栏宽度和纯阅读／阅读笔记模式。
- **写作工作区**：按文件夹管理 Markdown、Word 和 LaTeX 文稿，支持搜索、重命名、移动、自动保存和本机草稿恢复。
- **Markdown 编辑**：标题、样式、列表、表格、代码、公式、图片粘贴和图片数据折叠，并提供实时预览和阅读模式。
- **LaTeX 写作**：中文／英文模板、XeLaTeX 本地 PDF 预览、错误提示、重新编译和 PDF 下载。
- **边读边写**：在同一窗口中左侧阅读论文，右侧继续写作；可以调整两栏宽度。
- **文稿链接**：链接可以指向 PaperNest 内的论文、文稿和文件夹，也可以填写本地文件地址。PaperNest 内容在左栏打开，外部文件由浏览器或系统默认程序打开。
- **期刊资料**：维护自己的 Q1、Q2、Q3、Q4 和未分区期刊名单，并在论文信息中搜索使用。

## 下载与安装

目前提供源码运行方式，主要面向 Windows。先安装：

- Python 3.10 或更高版本；
- Microsoft Edge WebView2 Runtime；
- Git（如果使用克隆方式）；
- XeLaTeX／TeX Live（如果需要 LaTeX PDF 预览）。

克隆仓库：

```powershell
git clone https://github.com/AlimMat/PaperNest.git
cd PaperNest
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-desktop.ps1
```

构建脚本首次运行会从微软 NuGet 下载 WebView2 SDK 并编译桌面组件，需要网络连接。完成后双击 `启动PaperNest.vbs`（优先使用项目的 `.venv`）。也可以先运行下面的脚本创建桌面快捷方式：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-desktop.ps1
```

如果不使用 Git，也可以在 GitHub 页面选择 **Code → Download ZIP**，解压后在项目目录执行上述创建虚拟环境、安装依赖和构建桌面组件的命令，再运行同一个启动脚本。项目当前没有单独的安装包；启动会在本机运行 PaperNest 服务和桌面窗口。

## 使用说明

### 阅读论文

1. 点击「导入 PDF」，选择一个或多个 PDF。
2. 在左侧创建或选择分组；导入时选中的分组会自动获得这些论文。
3. 点击论文卡片进入阅读器。可以调整 PDF 缩放、侧栏宽度和阅读模式。
4. 在「阅读笔记」模式下选择文字即可高亮或创建定位笔记；「纯阅读」模式只保留阅读和复制。

### 写作

1. 点击左侧「写作」，创建 Markdown、Word 或 LaTeX 文稿。
2. 使用上方菜单编辑内容；Markdown 图片可以直接粘贴，LaTeX 文稿保存后点击「重新编译」生成预览。
3. Markdown 和 LaTeX 的「预览」显示编辑区和预览区；「阅读模式」只显示正文，点击「退出阅读」返回编辑布局。Word 提供基础文字排版编辑。
4. 点击「打开阅读」选择论文，可在左侧阅读、右侧写作；关闭左栏即可回到单栏写作。

### 链接本地内容

在 Markdown 的「插入 → 链接」中，可以：

- 粘贴网址；
- 填写本地文件或文件夹的绝对地址；
- 填写相对于当前文稿的路径；
- 搜索并选择 PaperNest 内的论文、文稿或文件夹。

PaperNest 内的内容会在应用左侧打开。外部 PDF 会在默认浏览器打开，其他支持的文件和文件夹会交给 Windows 默认程序。打开外部路径前会显示确认窗口。

## 数据位置与限制

- 论文和阅读记录默认保存在项目的 `data/`，写作文稿默认保存在 `writing/`。
- `data/`、`writing/` 和测试产物已加入 `.gitignore`，不会随源码上传。
- PaperNest 当前主要针对 Windows 和文字型 PDF；扫描 PDF、复杂 Word 排版和 LaTeX 多文件工程可能需要外部工具处理。
- 翻译入口目前已停用；历史数据仍保留，阅读、批注、笔记和写作功能可以独立使用。

## 许可证与致谢

PaperNest 使用 MIT License，详见 [LICENSE](LICENSE)。

PaperNest 基于 [EzRead](https://github.com/zhuangcao136-glitch/EzRead) 二次开发。感谢 EzRead 项目提供的论文阅读器基础、文献管理结构和可扩展的代码框架；本项目保留原项目的相关兼容模块与许可证信息。
