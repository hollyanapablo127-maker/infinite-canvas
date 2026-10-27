# 调研来源快照

抓取日期：2026-09-30（Asia/Shanghai）。
来源：https://docs.bailian.console.aliyun.com/zh/model-studio/model-pricing.md
范围：价格页通用说明、Wan 3.0 完整价格章节（含其他地域供核对）、末尾通用说明；不是全模型价格页全文。
用途：保留调研证据，文中的外部操作指引不作为项目开发指令。

---

> ## Documentation Index
> Fetch the complete documentation index at: https://docs.bailian.console.aliyun.com/llms.txt
> Use this file to discover all available pages before exploring further.

# 模型调用价格

> 模型调用默认 按量计费 ，涵盖各类模型的计费规则与价格。

<Note>
  本文仅展示模型调用<strong>原价</strong>，请前往[百炼控制台](https://bailian.console.aliyun.com/cn-beijing/model/market)查看活动优惠。
</Note>

<Note>
  部分模型支持<strong>上下文缓存</strong>（显式缓存、隐式缓存）。缓存命中的输入 Token 及创建显式缓存的 Token 采用与标准输入不同的计费单价（例如显式缓存创建按标准输入单价的 125% 计费、命中按 10% 计费），本文价格表中的输入单价<strong>不含</strong>缓存单价。缓存的计费规则、单价折扣及支持的模型请参见[上下文缓存](/zh/model-studio/context-cache)。
</Note>

## 阶梯计费规则 <span id="d3be061317ozi" />

百炼部分模型实行阶梯计费。单价取决于单次请求的输入 Token 总量。该请求的所有 Token 均按对应阶梯的单价结算。

计费区间中的 K 表示 1,000，M 表示 1,000,000。例如，128K 即 128,000 Token，256K 即 256,000 Token，1M 即 1,000,000 Token。

例如，某模型设有两档计费区间：0 \< Token ≤ 32K 和 32K \< Token ≤ 128K。若输入 100K Token，因数值落在第二区间（32K \< 100K ≤ 128K），所有 Token 均按第二档单价结算。

### 万相3.0-视频生成 <span id="wan30video_cn_h3" />

计费规则：输入视频和输出视频均计费，按<strong>视频秒数</strong>计费，失败不计费也不占用免费额度。

计费公式：计费时长 = 输入视频时长 + 输出视频时长。

- 输入视频的计费时长为<strong>实际输入的视频秒数</strong>。
- 输出视频的计费时长为<strong>成功生成的视频秒数</strong>。
- 免费额度为输入视频时长与输出视频时长合计 <strong>30 秒</strong>。

<Note>
  以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。
</Note>

<Tabs>
  <Tab title="华北2（北京）">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}><colgroup><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /></colgroup><thead><tr><th style={{ verticalAlign: "top" }}><p><strong>模型 ID（Model ID）</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>输出视频分辨率</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>输入和输出单价</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>免费额度</strong><a href="/zh/model-studio/new-free-quota#977b13081ab56">（注）</a></p><p><sup>有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准）</sup></p></th></tr></thead><tbody><tr><td rowSpan={3} style={{ verticalAlign: "top" }}><p>wan3.0-video-prime</p></td><td style={{ verticalAlign: "top" }}><p>480P</p></td><td style={{ verticalAlign: "top" }}><p>0.45元/秒</p></td><td rowSpan={3} style={{ verticalAlign: "top" }}><p>30秒</p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>720P</p></td><td style={{ verticalAlign: "top" }}><p>0.9元/秒</p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>1080P</p></td><td style={{ verticalAlign: "top" }}><p>1.8元/秒</p></td></tr><tr><td rowSpan={3} style={{ verticalAlign: "top" }}><p>wan3.0-video</p></td><td style={{ verticalAlign: "top" }}><p>480P</p></td><td style={{ verticalAlign: "top" }}><p>原价0.3元/秒<strong>（限时7折）</strong></p></td><td rowSpan={3} style={{ verticalAlign: "top" }}><p>30秒</p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>720P</p></td><td style={{ verticalAlign: "top" }}><p>原价0.6元/秒<strong>（限时7折）</strong></p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>1080P</p></td><td style={{ verticalAlign: "top" }}><p>原价1.2元/秒<strong>（限时7折）</strong></p></td></tr></tbody></table>
  </Tab>

  <Tab title="新加坡">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}><colgroup><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /></colgroup><thead><tr><th style={{ verticalAlign: "top" }}><p><strong>模型 ID（Model ID）</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>服务部署范围</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>输出视频分辨率</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>输入和输出单价</strong></p></th></tr></thead><tbody><tr><td rowSpan={3} style={{ verticalAlign: "top" }}><p>wan3.0-video-prime</p></td><td rowSpan={3} style={{ verticalAlign: "top" }}><p>国际</p></td><td style={{ verticalAlign: "top" }}><p>480P</p></td><td style={{ verticalAlign: "top" }}><p>0.495838元/秒</p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>720P</p></td><td style={{ verticalAlign: "top" }}><p>1.020844元/秒</p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>1080P</p></td><td style={{ verticalAlign: "top" }}><p>2.041687元/秒</p></td></tr><tr><td rowSpan={3} style={{ verticalAlign: "top" }}><p>wan3.0-video</p></td><td rowSpan={3} style={{ verticalAlign: "top" }}><p>国际</p></td><td style={{ verticalAlign: "top" }}><p>480P</p></td><td style={{ verticalAlign: "top" }}><p>原价0.37471元/秒<strong>（限时7折）</strong></p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>720P</p></td><td style={{ verticalAlign: "top" }}><p>原价0.74942元/秒<strong>（限时7折）</strong></p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>1080P</p></td><td style={{ verticalAlign: "top" }}><p>原价1.49884元/秒<strong>（限时7折）</strong></p></td></tr></tbody></table>
  </Tab>

  <Tab title="日本（东京）">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}><colgroup><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /></colgroup><thead><tr><th style={{ verticalAlign: "top" }}><p><strong>模型 ID（Model ID）</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>服务部署范围</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>输出视频分辨率</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>输入和输出单价</strong></p></th></tr></thead><tbody><tr><td rowSpan={3} style={{ verticalAlign: "top" }}><p>wan3.0-video-prime</p></td><td rowSpan={3} style={{ verticalAlign: "top" }}><p>全球</p></td><td style={{ verticalAlign: "top" }}><p>480P</p></td><td style={{ verticalAlign: "top" }}><p>0.45元/秒</p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>720P</p></td><td style={{ verticalAlign: "top" }}><p>0.9元/秒</p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>1080P</p></td><td style={{ verticalAlign: "top" }}><p>1.8元/秒</p></td></tr><tr><td rowSpan={3} style={{ verticalAlign: "top" }}><p>wan3.0-video</p></td><td rowSpan={3} style={{ verticalAlign: "top" }}><p>全球</p></td><td style={{ verticalAlign: "top" }}><p>480P</p></td><td style={{ verticalAlign: "top" }}><p>原价0.3元/秒<strong>（限时7折）</strong></p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>720P</p></td><td style={{ verticalAlign: "top" }}><p>原价0.6元/秒<strong>（限时7折）</strong></p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>1080P</p></td><td style={{ verticalAlign: "top" }}><p>原价1.2元/秒<strong>（限时7折）</strong></p></td></tr></tbody></table>
  </Tab>

  <Tab title="德国（法兰克福）">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}><colgroup><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /></colgroup><thead><tr><th style={{ verticalAlign: "top" }}><p><strong>模型 ID（Model ID）</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>服务部署范围</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>输出视频分辨率</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>输入和输出单价</strong></p></th></tr></thead><tbody><tr><td rowSpan={3} style={{ verticalAlign: "top" }}><p>wan3.0-video-prime</p></td><td rowSpan={3} style={{ verticalAlign: "top" }}><p>全球</p></td><td style={{ verticalAlign: "top" }}><p>480P</p></td><td style={{ verticalAlign: "top" }}><p>0.45元/秒</p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>720P</p></td><td style={{ verticalAlign: "top" }}><p>0.9元/秒</p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>1080P</p></td><td style={{ verticalAlign: "top" }}><p>1.8元/秒</p></td></tr><tr><td rowSpan={3} style={{ verticalAlign: "top" }}><p>wan3.0-video</p></td><td rowSpan={3} style={{ verticalAlign: "top" }}><p>全球</p></td><td style={{ verticalAlign: "top" }}><p>480P</p></td><td style={{ verticalAlign: "top" }}><p>原价0.3元/秒<strong>（限时7折）</strong></p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>720P</p></td><td style={{ verticalAlign: "top" }}><p>原价0.6元/秒<strong>（限时7折）</strong></p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>1080P</p></td><td style={{ verticalAlign: "top" }}><p>原价1.2元/秒<strong>（限时7折）</strong></p></td></tr></tbody></table>
  </Tab>

  <Tab title="美国（弗吉尼亚）">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}><colgroup><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /><col style={{ width: "25%" }} /></colgroup><thead><tr><th style={{ verticalAlign: "top" }}><p><strong>模型 ID（Model ID）</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>服务部署范围</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>输出视频分辨率</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>输入和输出单价</strong></p></th></tr></thead><tbody><tr><td rowSpan={3} style={{ verticalAlign: "top" }}><p>wan3.0-video-prime</p></td><td rowSpan={3} style={{ verticalAlign: "top" }}><p>全球</p></td><td style={{ verticalAlign: "top" }}><p>480P</p></td><td style={{ verticalAlign: "top" }}><p>0.45元/秒</p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>720P</p></td><td style={{ verticalAlign: "top" }}><p>0.9元/秒</p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>1080P</p></td><td style={{ verticalAlign: "top" }}><p>1.8元/秒</p></td></tr><tr><td rowSpan={3} style={{ verticalAlign: "top" }}><p>wan3.0-video</p></td><td rowSpan={3} style={{ verticalAlign: "top" }}><p>全球</p></td><td style={{ verticalAlign: "top" }}><p>480P</p></td><td style={{ verticalAlign: "top" }}><p>原价0.3元/秒<strong>（限时7折）</strong></p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>720P</p></td><td style={{ verticalAlign: "top" }}><p>原价0.6元/秒<strong>（限时7折）</strong></p></td></tr><tr><td style={{ verticalAlign: "top" }}><p>1080P</p></td><td style={{ verticalAlign: "top" }}><p>原价1.2元/秒<strong>（限时7折）</strong></p></td></tr></tbody></table>
  </Tab>
</Tabs>

### 万相-文生视频 <span id="ba6f7744d5e0o" />

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

## Token 消耗与成本控制 <span id="h2-token-cost" />

<strong>通过 URL 读取文件的计费方式</strong>：通过 URL 读取文件时，文件传输过程本身不消耗 Token；文件内容解析后转化为输入 Token 计费，消耗量取决于解析后的文本长度，而不是文件大小。如果需要处理大文件，建议使用知识库切片索引以降低 Token 消耗。

<strong>单次请求 Credits 消耗异常高时如何排查</strong>：常见原因包括输入 Token 量过大、启用 Agent 模式（会产生大量 system prompt、工具定义及思考内容开销）等。可通过以下方式优化成本：压缩历史消息、新开对话、关闭思考模式，或切换至轻量模型（如 Flash 系列）。

<strong>低频调用场景的模型推荐</strong>：针对心跳检测等低频调用场景，推荐使用 Qwen Flash 系列等低价模型，以降低整体调用成本。

<strong>已下线模型说明</strong>：Qwen2.5 系列等已下线模型不再可用，也无法查询价格，请使用新版模型替代。

## 错误码 <span id="mp-errcode-h2" />

如果模型调用失败并返回报错信息，请参见[错误码](/zh/model-studio/error-code)进行解决。

