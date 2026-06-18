/**
 * 搜索证据链 — 用搜索引擎验证新闻中的事实声明
 *
 * 流程：
 * 1. 从新闻中提取关键事实声明（数据、事件、人物）
 * 2. 用 Bing 搜索每个声明的相关报道
 * 3. 对比来源数量、来源权威度、时间线
 * 4. 返回结构化证据链
 */

// ============================================================
// Bing News Search
// ============================================================

/**
 * 搜索相关新闻报道
 * @param {string} title - 新闻标题
 * @param {string} content - 新闻正文（用于提取关键词）
 * @param {string} bingApiKey - Bing API Key
 * @returns {Promise<{query: string, results: Array, summary: string}>}
 */
export async function searchRelatedNews(title, content, bingApiKey) {
  if (!bingApiKey) {
    return { query: '', results: [], summary: '未配置搜索 API，跳过证据验证' };
  }

  const keywords = extractKeywords(title, content);
  const query = keywords.slice(0, 5).join(' ');

  const url = `https://api.bing.microsoft.com/v7.0/news/search?q=${encodeURIComponent(query)}&count=10&mkt=zh-CN&freshness=month`;

  try {
    const response = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': bingApiKey },
    });

    if (!response.ok) throw new Error(`Bing API ${response.status}`);

    const data = await response.json();
    const results = (data.value || []).map(item => ({
      title: item.name || '',
      source: item.provider?.[0]?.name || '未知',
      date: item.datePublished || '',
      description: item.description || '',
      url: item.url || '',
      category: item.category?.[0] || '',
    }));

    // 构建搜索摘要
    const sourceCount = new Set(results.map(r => r.source)).size;
    const summary = sourceCount > 0
      ? `找到 ${results.length} 篇相关报道，来自 ${sourceCount} 个不同来源`
      : '未找到相关报道，可能是未经广泛传播的信息';

    return { query, results, summary, sourceCount };

  } catch (err) {
    return { query, results: [], summary: `搜索失败: ${err.message}`, sourceCount: 0 };
  }
}

/**
 * Web 搜索（非新闻）— 用于验证具体事实声明
 */
export async function searchWeb(claim, bingApiKey) {
  if (!bingApiKey) return null;

  const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(claim)}&count=5&mkt=zh-CN`;

  try {
    const response = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': bingApiKey },
    });
    if (!response.ok) return null;

    const data = await response.json();
    return (data.webPages?.value || []).map(item => ({
      title: item.name,
      source: item.siteName || new URL(item.url).hostname,
      snippet: item.snippet,
      url: item.url,
    }));
  } catch {
    return null;
  }
}

// ============================================================
// 关键词提取
// ============================================================

const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都',
  '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会',
  '着', '没有', '看', '好', '自己', '这', '他', '她', '它', '们',
  '对', '与', '或', '但', '而', '从', '被', '把', '让', '等',
  '以及', '因为', '所以', '如果', '虽然', '但是', '还是', '已经',
  '可以', '这个', '那个', '什么', '怎么', '为什么', '哪里', '哪些',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'this',
  'that', 'these', 'those', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'and', 'or', 'but', 'not', 'news',
  'report', 'said', 'says', 'according',
]);

export function extractKeywords(title, content) {
  const text = (title + ' ' + content).substring(0, 1500);

  const words = [
    ...(text.match(/[\u4e00-\u9fa5]{2,4}/g) || []),
    ...(text.match(/[a-zA-Z]{3,}/g) || []).map(w => w.toLowerCase()),
  ];

  const freq = {};
  words.forEach(w => {
    if (!STOP_WORDS.has(w) && w.length > 1) freq[w] = (freq[w] || 0) + 1;
  });

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);
}

// ============================================================
// 来源信誉评估
// ============================================================

// 权威新闻来源域名（中国主要媒体）
const AUTHORITY_DOMAINS = new Set([
  // 中央级媒体
  'xinhuanet.com', 'people.com.cn', 'cctv.com', 'chinanews.com',
  'china.com.cn', 'gmw.cn', 'cri.cn', 'cyol.com',
  // 主流商业媒体
  'thepaper.cn', 'caixin.com', 'bjnews.com.cn', 'jiemian.com',
  'ifeng.com', 'sina.com.cn', 'sohu.com', '163.com', 'qq.com',
  'hexun.com', '21jingji.com', 'yicai.com',
  // 专业技术媒体
  'cnbeta.com', '36kr.com', 'leiphone.com', 'ifanr.com',
  // 国际媒体
  'reuters.com', 'bbc.com', 'apnews.com', 'bloomberg.com',
]);

// 低信誉来源特征
const LOW_CREDIBILITY_PATTERNS = [
  /自媒体/i, /营销号/i, /unknown/i,
];

// 权威来源名称（用于匹配 source 字段，非域名）
const AUTHORITY_NAMES = [
  '新华社', '人民日报', '中央电视台', '央视', 'CCTV', '中国新闻网', '中新社',
  '光明日报', '环球时报', '中国经济网', '中国日报', '科技日报', '参考消息',
  '澎湃新闻', '财新', '界面新闻', '第一财经',
];

/**
 * 评估来源域名/名称信誉
 */
export function assessSource(domain) {
  if (!domain) return { level: 'unknown', score: 50 };

  const d = domain.toLowerCase().replace(/^www\./, '');

  // 检查是否在权威列表
  for (const auth of AUTHORITY_DOMAINS) {
    if (d.includes(auth)) {
      return { level: 'authority', score: 90 };
    }
  }

  // 检查权威来源名称（新华社、人民日报等）
  for (const name of AUTHORITY_NAMES) {
    if (d.includes(name)) {
      return { level: 'authority', score: 90 };
    }
  }

  // 检查低信誉特征
  for (const pattern of LOW_CREDIBILITY_PATTERNS) {
    if (pattern.test(d)) {
      return { level: 'low', score: 25 };
    }
  }

  return { level: 'normal', score: 60 };
}

/**
 * 评估搜索证据的整体强度
 */
export function assessEvidence(searchData) {
  if (!searchData || !searchData.results || searchData.results.length === 0) {
    return {
      strength: 'none',
      score: 40,
      label: '无交叉验证',
      detail: '未找到其他来源的相关报道，信息未经广泛传播验证',
    };
  }

  const { results, sourceCount } = searchData;

  // 统计权威来源数量
  let authorityCount = 0;
  for (const r of results) {
    const domain = r.url ? (() => { try { return new URL(r.url).hostname } catch { return '' } })() : '';
    const assessment = assessSource(domain);
    if (assessment.level === 'authority') authorityCount++;
  }

  // 证据强度评估
  if (sourceCount >= 5 && authorityCount >= 3) {
    return {
      strength: 'strong',
      score: 90,
      label: '多源权威验证',
      detail: `${sourceCount}个来源报道，其中${authorityCount}个权威媒体`,
    };
  }
  if (sourceCount >= 3 && authorityCount >= 1) {
    return {
      strength: 'moderate',
      score: 70,
      label: '多源验证',
      detail: `${sourceCount}个来源报道，其中${authorityCount}个权威媒体`,
    };
  }
  if (sourceCount >= 2) {
    return {
      strength: 'weak',
      score: 55,
      label: '少量来源',
      detail: `仅${sourceCount}个来源报道，交叉验证不足`,
    };
  }

  return {
    strength: 'very_weak',
    score: 35,
    label: '单一来源',
    detail: '仅单一来源，信息可靠性存疑',
  };
}
