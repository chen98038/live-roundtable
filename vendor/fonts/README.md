# 随项目分发的字体

和 AFFiNE 的自定义字体设置保持一致：英文 Montserrat，中文 Noto Sans SC。这里放的是子集化后的 woff2，所以没装这两个字体的电脑也能按同样的字体显示。

| 文件 | 来源 | 子集范围 | 授权 |
|---|---|---|---|
| `Montserrat-subset.woff2` | Montserrat 9.000 可变字体（字重 100–900） | 拉丁字母及扩展、常用标点和符号 | SIL OFL 1.1，见 `OFL-Montserrat.txt` |
| `NotoSansSC-subset.woff2` | Noto Sans SC 2.004 可变字体（字重 100–900） | GB2312 全部 6763 个汉字和符号，加上项目文案、提示词里用到的字符，以及 ASCII、全角和中文标点 | SIL OFL 1.1，见 `OFL-NotoSansSC.txt` |

子集外的生僻字会依次退回本机的 Noto Sans SC、苹方、冬青黑体、微软雅黑。

## 重新生成

改了界面文案或提示词、新增了 GB2312 以外的字时，用 fontTools 重新生成：

```bash
pip install fonttools brotli
```

```bash
pyftsubset NotoSansSC-VF.ttf --text-file=chars.txt \
  --unicodes='U+0020-007E,U+00A0-00FF,U+2000-206F,U+3000-303F,U+FF00-FFEF' \
  --layout-features='*' --flavor=woff2 --output-file=NotoSansSC-subset.woff2
```

```bash
pyftsubset Montserrat-VF.ttf \
  --unicodes='U+0000-024F,U+0300-036F,U+1E00-1EFF,U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2212,U+2215,U+FEFF,U+FFFD' \
  --layout-features='*' --flavor=woff2 --output-file=Montserrat-subset.woff2
```

`chars.txt` 是 GB2312 的全部字符，加上 `src/`、`bin/`、`prompts/`、`README.md` 里出现过的所有非 ASCII 字符。
