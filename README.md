# factcheck-api

新闻事实核查 API — 多模型交叉验证 + 搜索证据链

## 架构

```
新闻内容
   │
   ├──→ 模型A (智谱 GLM) ──┐
   ├──→ 模型B (DeepSeek) ──┤──→ 交叉验证合并
   ├──→ 模型C (通义千问) ──┤
   ├──→ Bing 搜索证据 ─────┤──→ 来源权威度评估
   └──→ 域名信誉评估 ──────┘
         │
    最终报告：评分 + 置信区间 + 争议点 + 证据链
```

## API

### POST /api/factcheck

请求体：
```json
{
  "title": "新闻标题",
  "content": "新闻正文（50-10000字）",
  "source": "来源（可选）",
  "publishDate": "发布时间（可选）",
  "url": "原始URL（可选）",
  "apiKeys": {  // 可选，自带 Key 模式
    "zhipu": "your-key",
    "deepseek": "your-key"
  }
}
```

免费模式（不带 apiKeys）：每 IP 每天 5 次
自带 Key 模式：不限次数

## 环境变量

```
ZHIPU_API_KEY=xxx      # 智谱 API Key
DEEPSEEK_API_KEY=xxx   # DeepSeek API Key（可选）
DASHSCOPE_API_KEY=xxx  # 通义千问 API Key（可选）
MOONSHOT_API_KEY=xxx   # Kimi API Key（可选）
BING_API_KEY=xxx       # Bing Search API Key（可选）
```

## 部署

```bash
vercel --prod
```
