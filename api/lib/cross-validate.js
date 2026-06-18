/**
 * 交叉验证引擎 — 多模型结果合并 + 搜索证据融合
 *
 * 核心算法：
 * 1. 每个模型独立输出结构化分析（评分、维度、可疑点）
 * 2. 评分取中位数（非平均，抗离群值）
 * 3. 共识提取：多数模型一致 → 强信号
 * 4. 分歧标注：模型间差异大 → 标记争议
 * 5. 搜索证据融合：来源数、权威度加权
 */

// ============================================================
// 系统提示词 — 每个模型用相同的 prompt，保证可比性
// ============================================================

export const FACTCHECK_SYSTEM_PROMPT = `你是一个严谨的新闻事实核查分析师。你的任务是对用户提供的新闻内容进行多维度的事实核查分析。

你需要从以下5个维度进行评估：

1. 信息源可靠性（source_reliability）：发布者是否权威？来源是否可追溯？
2. 事实交叉验证（cross_validation）：内容中的关键事实（数据、时间、事件）是否能被独立验证？是否存在明显矛盾？
3. 逻辑一致性（logic_consistency）：文章的论证逻辑是否自洽？因果推理是否合理？是否存在逻辑谬误？
4. 情感偏向（emotional_bias）：文章是否使用了煽动性语言？是否选择性呈现信息？是否有明显的立场偏向？
5. 时效性（timeliness）：信息是否过时？事件的时间线是否合理？

严格按以下JSON格式返回（不要输出任何其他文字，不要用markdown代码块）：
{
  "confidence": <0-100的整数，综合可信度>,
  "summary": "<一句话总结，30字以内>",
  "dimensions": {
    "source_reliability": { "score": <0-100>, "note": "<50字以内分析>" },
    "cross_validation": { "score": <0-100>, "note": "<50字以内分析>" },
    "logic_consistency": { "score": <0-100>, "note": "<50字以内分析>" },
    "emotional_bias": { "score": <0-100>, "note": "<50字以内分析>" },
    "timeliness": { "score": <0-100>, "note": "<50字以内分析>" }
  },
  "suspicions": ["<可疑点1>", "<可疑点2>", "..."],
  "highlights": ["<可信亮点1>", "<可信亮点2>", "..."],
  "claims": ["<文章中的关键事实声明1，用于搜索验证>", "..."],
  "verdict": "<highly_reliable | mostly_reliable | partially_reliable | suspicious | likely_false>"
}

verdict标准：
- highly_reliable: 90+，高度可信，来源权威，事实可验证
- mostly_reliable: 70-89，基本可信，个别细节待验证
- partially_reliable: 50-69，部分可信，存在明显疑点
- suspicious: 30-49，存在疑点，多个维度不可靠
- likely_false: <30，可能不实，存在明显虚假信息

保持客观中立，基于证据分析，不做主观臆断。中文输出。`;

// ============================================================
// 多模型并行分析
// ============================================================

/**
 * 并行调用多个模型分析同一篇新闻
 * @param {object} news - { title, content, source, publishDate, url }
 * @param {Array} modelConfigs - [{ id, apiKey, provider }]
 * @param {string} searchContext - 搜索证据（注入 prompt）
 * @returns {Promise<Array>} 每个模型的分析结果
 */
export async function multiModelAnalyze(news, modelConfigs, searchContext) {
  const userPrompt = buildUserPrompt(news, searchContext);

  // 并行调用所有模型
  const promises = modelConfigs.map(async (cfg) => {
    try {
      const { callModel } = await import('./models.js');
      const result = await callModel(cfg.id, FACTCHECK_SYSTEM_PROMPT, userPrompt, cfg.apiKey);

      let parsed;
      try {
        parsed = JSON.parse(result.content);
      } catch {
        // 尝试提取 JSON
        const m = result.content.match(/\{[\s\S]*\}/);
        if (m) parsed = JSON.parse(m[0]);
        else throw new Error('JSON 解析失败');
      }

      return {
        model: result.model,
        modelLabel: result.modelLabel,
        latency: result.latency,
        success: true,
        analysis: parsed,
      };
    } catch (err) {
      return {
        model: cfg.id,
        modelLabel: cfg.label || cfg.id,
        success: false,
        error: err.message,
      };
    }
  });

  const results = await Promise.all(promises);
  return results.filter(r => r !== null);
}

/**
 * 构建用户提示词
 */
function buildUserPrompt(news, searchContext) {
  let prompt = `【标题】${news.title}
【来源】${news.source || '未知'}
【发布时间】${news.publishDate || '未知'}
【URL】${news.url || ''}
【正文】
${news.content}`;

  if (searchContext && searchContext.results?.length > 0) {
    prompt += `\n\n【搜索引擎相关报道（用于交叉验证）】
${searchContext.results.slice(0, 5).map((r, i) =>
  `[${i+1}] "${r.title}" — ${r.source} (${r.date})
${r.description}`
).join('\n\n')}

请结合以上搜索结果，验证文章中的事实声明。如果搜索结果支持文章内容，提高交叉验证评分；如果搜索结果与文章矛盾，降低评分并标注可疑点。`;
  }

  return prompt;
}

// ============================================================
// 交叉验证合并算法
// ============================================================

/**
 * 合并多个模型的分析结果 + 搜索证据
 * @param {Array} modelResults - 多模型的独立分析
 * @param {object} searchEvidence - 搜索证据评估
 * @returns {object} 合并后的最终报告
 */
export function crossValidate(modelResults, searchEvidence) {
  const valid = modelResults.filter(r => r.success && r.analysis);

  if (valid.length === 0) {
    return {
      confidence: 0,
      summary: '所有模型分析均失败',
      verdict: 'unknown',
      error: 'no_valid_results',
    };
  }

  if (valid.length === 1) {
    // 单模型结果，直接返回（附加搜索证据调整）
    return enrichSingleModel(valid[0], searchEvidence);
  }

  // 多模型交叉验证
  return mergeMultipleModels(valid, searchEvidence);
}

/**
 * 单模型结果 + 搜索证据增强
 */
function enrichSingleModel(result, searchEvidence) {
  const analysis = result.analysis;
  let adjustedScore = analysis.confidence;
  let adjustments = [];

  // 搜索证据微调
  if (searchEvidence && searchEvidence.evidence) {
    const evi = searchEvidence.evidence;
    if (evi.strength === 'strong') {
      adjustedScore = Math.min(100, adjustedScore + 5);
      adjustments.push('多源权威验证 (+5)');
    } else if (evi.strength === 'very_weak' || evi.strength === 'none') {
      adjustedScore = Math.max(0, adjustedScore - 10);
      adjustments.push('缺乏交叉验证 (-10)');
    }
  }

  return {
    confidence: Math.round(adjustedScore),
    summary: analysis.summary,
    verdict: analysis.verdict,
    dimensions: formatDimensions(analysis.dimensions),
    suspicions: analysis.suspicions || [],
    highlights: analysis.highlights || [],
    meta: {
      mode: 'single_model',
      model: result.modelLabel,
      latency: result.latency,
      adjustments,
      evidence: searchEvidence?.evidence || null,
      crossValidationCount: 1,
    },
  };
}

/**
 * 多模型交叉验证合并
 */
function mergeMultipleModels(results, searchEvidence) {
  // 1. 提取所有评分
  const confidenceScores = results.map(r => r.analysis.confidence).filter(s => typeof s === 'number');
  const finalConfidence = median(confidenceScores);

  // 2. 维度评分合并
  const allDimensions = results.map(r => r.analysis.dimensions).filter(d => d);
  const mergedDimensions = mergeDimensions(allDimensions);

  // 3. 共识 / 分歧分析
  const verdicts = results.map(r => r.analysis.verdict);
  const verdictConsensus = assessConsensus(verdicts);

  // 4. 可疑点合并（去重 + 计数）
  const allSuspicions = results.flatMap(r => r.analysis.suspicions || []);
  const suspicionConsensus = findConsensus(allSuspicions);

  // 5. 亮点合并
  const allHighlights = results.flatMap(r => r.analysis.highlights || []);
  const highlightConsensus = findConsensus(allHighlights);

  // 6. 搜索证据融合
  let adjustedScore = finalConfidence;
  let adjustments = [];

  if (searchEvidence && searchEvidence.evidence) {
    const evi = searchEvidence.evidence;
    if (evi.strength === 'strong') {
      adjustedScore = Math.min(100, adjustedScore + 8);
      adjustments.push(`搜索证据：${evi.label} (+8)`);
    } else if (evi.strength === 'moderate') {
      adjustedScore = Math.min(100, adjustedScore + 4);
      adjustments.push(`搜索证据：${evi.label} (+4)`);
    } else if (evi.strength === 'very_weak' || evi.strength === 'none') {
      adjustedScore = Math.max(0, adjustedScore - 8);
      adjustments.push(`搜索证据：${evi.label} (-8)`);
    }
  }

  // 7. 模型一致性调整（模型间分歧大 → 降低置信度）
  const scoreSpread = Math.max(...confidenceScores) - Math.min(...confidenceScores);
  if (scoreSpread > 25) {
    adjustedScore = Math.max(0, adjustedScore - 5);
    adjustments.push(`模型间分歧较大（差${scoreSpread}分）(-5)`);
  }

  // 8. 生成综合 summary
  const summary = results[0].analysis.summary; // 用响应最快的模型的 summary

  return {
    confidence: Math.round(adjustedScore),
    summary,
    verdict: mapScoreToVerdict(adjustedScore),
    verdictConsensus, // 共识情况
    dimensions: mergedDimensions,
    suspicions: suspicionConsensus.consensus,
    uniqueSuspicions: suspicionConsensus.unique, // 仅一个模型发现的
    highlights: highlightConsensus.consensus,
    meta: {
      mode: 'multi_model',
      modelCount: results.length,
      models: results.map(r => ({ label: r.modelLabel, score: r.analysis.confidence, verdict: r.analysis.verdict })),
      confidenceRange: { min: Math.min(...confidenceScores), max: Math.max(...confidenceScores), median: finalConfidence },
      scoreSpread,
      adjustments,
      evidence: searchEvidence?.evidence || null,
      crossValidationCount: results.length,
    },
  };
}

// ============================================================
// 辅助函数
// ============================================================

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function mergeDimensions(allDimensions) {
  const DIM_META = {
    source_reliability: { label: '信息源可靠性', icon: '📰' },
    cross_validation: { label: '事实交叉验证', icon: '🔍' },
    logic_consistency: { label: '逻辑一致性', icon: '🧠' },
    emotional_bias: { label: '情感偏向', icon: '🎭' },
    timeliness: { label: '时效性', icon: '⏰' },
  };

  const merged = {};
  for (const [key, meta] of Object.entries(DIM_META)) {
    const scores = allDimensions
      .map(d => d[key]?.score)
      .filter(s => typeof s === 'number');

    if (scores.length === 0) continue;

    // 取所有模型该维度 note 中最详细的一个
    const notes = allDimensions.map(d => d[key]?.note).filter(n => n);
    const bestNote = notes.sort((a, b) => b.length - a.length)[0] || '';

    merged[key] = {
      label: meta.label,
      icon: meta.icon,
      score: median(scores),
      scoreRange: scores.length > 1 ? { min: Math.min(...scores), max: Math.max(...scores) } : null,
      note: bestNote,
    };
  }

  return merged;
}

/**
 * 评估 verdict 共识度
 */
function assessConsensus(verdicts) {
  const valid = verdicts.filter(v => v);
  if (valid.length === 0) return { level: 'unknown', agree: 0, total: 0 };

  const counts = {};
  valid.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const maxCount = Math.max(...Object.values(counts));
  const agreeRatio = maxCount / valid.length;

  let level;
  if (agreeRatio === 1) level = 'unanimous';      // 全部一致
  else if (agreeRatio >= 0.67) level = 'strong';   // 强共识
  else if (agreeRatio >= 0.5) level = 'moderate';  // 中等共识
  else level = 'divided';                           // 分歧大

  return { level, agree: maxCount, total: valid.length };
}

/**
 * 从多个模型的列表中找共识项
 * 简化版：用关键词相似度判断是否是同一个点
 */
function findConsensus(items) {
  if (!items || items.length === 0) return { consensus: [], unique: [] };

  // 简单聚类：按前10个字的相似度
  const clusters = [];
  for (const item of items) {
    const prefix = item.substring(0, 10);
    const existing = clusters.find(c =>
      c.items.some(ci => textSimilarity(prefix, ci.substring(0, 10)) > 0.5)
    );
    if (existing) {
      existing.items.push(item);
    } else {
      clusters.push({ items: [item] });
    }
  }

  const consensus = clusters
    .filter(c => c.items.length >= 2)
    .map(c => ({
      text: c.items[0],
      count: c.items.length,
      consensus: c.items.length >= 2 ? '多模型一致' : null,
    }));

  const unique = clusters
    .filter(c => c.items.length === 1)
    .map(c => ({
      text: c.items[0],
      note: '仅单一模型发现',
    }));

  return { consensus: consensus.map(c => c.text), unique: unique.map(u => u.text) };
}

/**
 * 简单文本相似度（Jaccard on characters）
 */
function textSimilarity(a, b) {
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function mapScoreToVerdict(score) {
  if (score >= 90) return 'highly_reliable';
  if (score >= 70) return 'mostly_reliable';
  if (score >= 50) return 'partially_reliable';
  if (score >= 30) return 'suspicious';
  return 'likely_false';
}

function formatDimensions(dimensions) {
  if (!dimensions) return {};
  const DIM_META = {
    source_reliability: { label: '信息源可靠性', icon: '📰' },
    cross_validation: { label: '事实交叉验证', icon: '🔍' },
    logic_consistency: { label: '逻辑一致性', icon: '🧠' },
    emotional_bias: { label: '情感偏向', icon: '🎭' },
    timeliness: { label: '时效性', icon: '⏰' },
  };

  const formatted = {};
  for (const [key, val] of Object.entries(dimensions)) {
    const meta = DIM_META[key] || { label: key, icon: '📊' };
    formatted[key] = {
      label: meta.label,
      icon: meta.icon,
      score: typeof val === 'number' ? val : val.score,
      note: typeof val === 'object' ? val.note : '',
    };
  }
  return formatted;
}
