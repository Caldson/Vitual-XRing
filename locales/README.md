# Crowdin 语言文件

给 `https://crowdin.com/project/xsmmccaldsonusci` 用。项目源语言：**简体中文（zh-CN）**。

## 源语言文件（上传这个）

- `xring-zh-CN.csv`：两列 CSV，`key,简体中文`，用于 **CSV** 项目。
- `zh-CN.json`：扁平 JSON，`key: 简体中文`，用于 **JSON** 项目。

共 **112 个 key**，例如：

```text
document.index
nav.home
nav.xos
nav.shop
nav.chat
nav.vitualgit
nav.vuolingo
settings.title
...
```

## 英文翻译文件（可选）

- `xring-en.csv`
- `en.json`

这两个是英文翻译，不是源文件。源文件上传成功后，可以在 Crowdin 里作为 **English** 翻译上传；不要把它们设成源语言。

## 在 Crowdin 上传源文件

### CSV 项目

1. 打开 Crowdin 项目 → **Sources / 源文件**。
2. **Upload file**。
3. 选择 `xring-zh-CN.csv`。
4. 文件类型选 **CSV**。
5. 列设置：
   - 第一列：**Identifier (Key)**
   - 第二列：**Source string**
6. 源语言选 **Chinese Simplified（zh-CN）**。
7. 上传。

`xring-zh-CN.csv` 第一行不是表头，直接是：

```csv
"document.index","Vitual XRing · 虚拟云电脑与作品社区"
"nav.home","首页"
```

如果 Crowdin 的导入界面要求表头，请把第一行标记为内容，不要当成 header。

### JSON 项目

1. 同样在 **Sources** 上传 `zh-CN.json`。
2. 文件类型选 **JSON**。
3. 源语言选 **Chinese Simplified（zh-CN）**。
4. Crowdin 会自动识别扁平 key。

## 目标语言

项目里已经配置了很多目标语言，例如：

- English / English 变体
- Chinese Traditional / Hong Kong / Macau
- French、Italian、Japanese、Korean、Latin、LOLCAT、Russian、Spanish、Thai、Turkish 等

源文件只上传一次；之后在 Crowdin 里逐语言翻译，完成后下载对应语言文件。

## 注意

- `key` 不要改，只翻译第二列 / JSON 的 value。
- 保留 `{theme}`、`{count}` 等占位符。
- 英文文件仅作为英文翻译，不要设成源语言。
- 网站当前内置 `zh-CN`、`zh-TW`、`en`、`ja`；Crowdin 下载文件后可再接入网站。
