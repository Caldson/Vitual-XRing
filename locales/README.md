# Crowdin 语言文件

给 `https://crowdin.com/project/xsmmccaldsonusci` 用的第一份源语言文件。

## 文件

- `en.json`：扁平 JSON，`key → English`，适合 Crowdin 的 **JSON** 项目。
- `xring-en.csv`：两列 CSV，`key,English`，适合 Crowdin 的 **CSV** 项目。

这两个文件内容一致，共 **112 个 key**：

```text
document.index
document.settings
brand
nav.home
nav.xos
nav.shop
nav.chat
nav.viratch
nav.vitualgit
nav.vuolingo
nav.settings
...
```

## 在 Crowdin 上传

### 如果项目是 CSV

1. 打开 Crowdin 项目 → **Sources / 源文件**。
2. **Upload file**。
3. 选择 `xring-en.csv`。
4. 文件类型选 **CSV**。
5. 列设置：
   - 第一列：**Identifier (Key)**
   - 第二列：**Source string**
6. 源语言选 **English**。
7. 上传后，Crowdin 会把 `xring-en.csv` 里的 112 个 key 作为源字符串。

> `xring-en.csv` 第一行不是表头，直接是 `"key","English"`。如果 Crowdin 要求表头，请在导入设置里把第一行标记为内容，不要当成 header。

### 如果项目是 JSON

1. 同样在 **Sources** 上传 `en.json`。
2. 文件类型选 **JSON**。
3. 源语言选 **English**。
4. Crowdin 会自动识别扁平 key。

## 目标语言

Crowdin 项目里已经配置了很多目标语言（English 变体、中文变体、French、Japanese、Korean、Spanish 等）。源文件只需要上传一次；之后在 Crowdin 里给各语言翻译即可。

## 注意

- 不要把这些文件当成“中文翻译文件”上传；它们是 **English 源文件**。
- 翻译时保留 `{theme}`、`{count}` 这类占位符，不要翻译或删除。
- `key` 不要改；只翻译第二列 / JSON 的 value。
- 当前网站实际内置了 `zh-CN`、`zh-TW`、`en`、`ja` 四种语言；Crowdin 下载后的文件可以再接入网站。
