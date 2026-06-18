/**
 * /api/factcheck — 新闻事实核查主入口
 *
 * 请求: POST { title, content, source, publishDate, url }
 * 响应: { confidence, summary, verdict, dimensions, suspicions, meta }
 *
 * 两种模式：
 * 1. 免费模式（默认）: 用后端配置的模型 + 搜索 API，IP 限流
 * 2. 自带 Key 模式: 用户传自己的 API Key，不限次数
 */

import { getAvailableModels, MODELS, resolveUserModels, getApiKey } from './lib/models.js';
import { searchRelatedNews, assessEvidence, assessSource } from './lib/search.js';
import { multiModelAnalyze, crossValidate } from './lib/cross-validate.js';

// ============================================================
// 限流（内存级，Vercel 实例内有效）
// ============================================================

const FREE_DAILY_LIMIT = 5; // 免费用户每天5次

if (!globalThis._factcheckRateLimit) {
  globalThis._factcheckRateLimit = new Map();
}

function checkRateLimit(ip) {
  const today = new Date().toISOString().slice(0, 10); // 2026-06-18
  const key = `${ip}:${today}`;
  const current = globalThis._factcheckRateLimit.get(key) || 0;

  if (current >= FREE_DAILY_LIMIT) {
    return { allowed: false, remaining: 0, limit: FREE_DAILY_LIMIT };
  }

  return { allowed: true, remaining: FREE_DAILY_LIMIT - current, limit: FREE_DAILY_LIMIT };
}

function incrementRateLimit(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${ip}:${today}`;
  globalThis._factcheckRateLimit.set(key, (globalThis._factcheckRateLimit.get(key) || 0) + 1);
}

// ============================================================
// CORS
// ============================================================

const ALLOWED_ORIGINS = [
  'https://chrome.google.com',
  'chrome-extension://hdgbdbnnoegfagndpnjhllndheleolfi',
];

function setCors(res, origin) {
  // 公开 API，允许所有来源（有限流保护）
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ============================================================
// 主处理函数
// ============================================================

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCors(res, req.headers.origin);
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  setCors(res, req.headers.origin);

  const { title, content, source, publishDate, url } = req.body;

  // 参数校验
  if (!title || !content) {
    return res.status(400).json({ error: '缺少标题或正文' });
  }
  if (content.length < 50) {
    return res.status(400).json({ error: '正文太短，无法有效分析' });
  }
  if (content.length > 10000) {
    return res.status(400).json({ error: '正文过长，请限制在10000字以内' });
  }

  // 判断模式：用户自带 Key 还是免费模式
  const userKeys = req.body.apiKeys; // { zhipu: 'xxx', deepseek: 'xxx', ... }
  const isUserKeyMode = userKeys && Object.keys(userKeys).length > 0;

  // 免费模式限流
  if (!isUserKeyMode) {
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    const rateLimit = checkRateLimit(clientIP);
    if (!rateLimit.allowed) {
      return res.status(429).json({
        error: `今日免费额度已用完（${FREE_DAILY_LIMIT}次/天）`,
        hint: '配置自己的 API Key 可不限次数使用',
        rateLimit,
      });
    }
    res.setHeader('X-RateLimit-Remaining', rateLimit.remaining);
    res.setHeader('X-RateLimit-Limit', rateLimit.limit);
  }

  // 获取可用模型
  let modelConfigs;
  if (isUserKeyMode) {
    modelConfigs = resolveUserModels(userKeys);
    if (modelConfigs.length === 0) {
      return res.status(400).json({ error: '提供的 API Key 无对应可用模型' });
    }
  } else {
    const available = getAvailableModels();
    if (available.length === 0) {
      return res.status(503).json({ error: '服务端未配置可用模型' });
    }
    modelConfigs = available.map(m => ({ id: m.id, apiKey: getApiKey(m.provider) }));
  }

  // 单模型时用便宜快速的，多模型时取前3个（平衡成本和效果）
  if (modelConfigs.length > 3) {
    modelConfigs = modelConfigs.slice(0, 3);
  }

  const news = { title, content, source, publishDate, url };

  try {
    // Step 1: 搜索证据（并行于模型分析之前，因为需要结果注入 prompt）
    const bingKey = process.env.BING_API_KEY || req.body.bingApiKey;
    const searchResult = await searchRelatedNews(title, content, bingKey);
    const searchEvidence = {
      results: searchResult.results,
      evidence: assessEvidence(searchResult),
    };

    // Step 2: 多模型并行分析
    const modelResults = await multiModelAnalyze(news, modelConfigs, searchResult);

    // Step 3: 交叉验证合并
    const finalReport = crossValidate(modelResults, searchEvidence);

    // 附加来源评估
    if (source || url) {
      const domain = url ? safeGetDomain(url) : source;
      finalReport.sourceAssessment = assessSource(domain);
    }

    // 免费模式计数
    if (!isUserKeyMode) {
      const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
      incrementRateLimit(clientIP);
    }

    // 返回结果
    res.status(200).json({
      success: true,
      data: finalReport,
      searchSummary: searchResult.summary,
      rateLimit: isUserKeyMode ? null : {
        remaining: checkRateLimit(req.headers['x-forwarded-for']?.split(',')[0] || 'unknown').remaining,
        limit: FREE_DAILY_LIMIT,
      },
    });

  } catch (err) {
    console.error('Factcheck error:', err);
    res.status(500).json({
      error: '分析失败',
      detail: err.message,
    });
  }
}

function safeGetDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
