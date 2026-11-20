/**
 * AI 服务层（预留接口）
 *
 * 页面只调用 LunchAI 的三个方法，不关心背后是本地模拟还是大模型：
 *   - parsePreference(text)        一句话描述口味 → 结构化偏好
 *   - explain(item, context)       为一道推荐菜生成一句推荐理由
 *   - adjustToday(text)            （预留）当天临时需求，如“今天想喝点汤” → 打分调整
 *
 * 切换方式：把 AI_CONFIG.provider 从 'mock' 改成 'remote'，
 * 前端会请求同域名下的 /api/ai（Vercel 后端函数，见 api/ai.js），
 * 并在环境变量里配置大模型 API Key。远程调用失败时自动回退到本地模拟，页面不会坏。
 */
(function () {
  const AI_CONFIG = {
    provider: 'mock',       // 'mock' | 'remote'
    endpoint: '/api/ai',
    timeoutMs: 8000,
  };

  const { FLAVOR_OPTIONS, AVOID_OPTIONS } = window.LunchData;

  // ---------------- 本地模拟实现 ----------------
  const mock = {
    async parsePreference(text) {
      const t = (text || '').trim();
      const clauses = t.split(/[，,。；;！!\n]/).filter(Boolean);
      const negWords = /(不吃|不要|不能吃|别|忌|讨厌|过敏|受不了|不爱|不喜欢)/;
      const avoid = new Set();
      const flavors = new Set();
      let noFried = null, lowOil = null, wantStaple = null;

      for (const c of clauses) {
        const negative = negWords.test(c);
        if (negative) {
          AVOID_OPTIONS.forEach((a) => { if (c.includes(a)) avoid.add(a); });
          if (/海鲜/.test(c)) { avoid.add('虾'); avoid.add('鱼'); }
          if (/(下水|杂碎|牛杂)/.test(c)) avoid.add('内脏');
          if (/辣/.test(c)) { avoid.add('辣椒'); flavors.add('清淡'); }
          if (/(炸|油炸)/.test(c)) noFried = true;
          if (/(油腻|太油)/.test(c)) { lowOil = true; noFried = true; }
        } else {
          if (/麻辣/.test(c)) flavors.add('麻辣');
          else if (/酸辣/.test(c)) flavors.add('酸辣');
          else if (/辣/.test(c)) flavors.add('香辣');
          if (/酸甜|甜/.test(c)) flavors.add('酸甜');
          if (/清淡/.test(c)) flavors.add('清淡');
          if (/鲜|咸/.test(c)) flavors.add('咸鲜');
          if (/酱/.test(c)) flavors.add('酱香');
        }
        if (/(少油|控油|减脂|健康|轻食)/.test(c)) { lowOil = true; noFried = true; }
        if (/(主食|米饭|吃饱|顶饱|面|碳水)/.test(c) && !/(不要主食|不吃主食|少碳水|戒碳水)/.test(c)) wantStaple = true;
        if (/(不要主食|不吃主食|戒碳水)/.test(c)) wantStaple = false;
      }

      return {
        flavors: [...flavors].filter((f) => FLAVOR_OPTIONS.includes(f)),
        avoid: [...avoid],
        noFried, lowOil, wantStaple,   // null 表示文本里没提到，页面保持原设置
        source: 'mock',
      };
    },

    async explain(item, ctx) {
      // 模拟大模型：口味一句 + 这道菜最突出的一个特点 + 收尾（不重样 / 主食），避免三张卡片千篇一律
      const d = item.dish;
      const seed = [...d.id].reduce((a, c) => a + c.charCodeAt(0), 0);
      const flavorHit = item.hits.find((h) => h.startsWith('口味'));
      const idx = ctx.index || 0;
      const fl = flavorHit ? flavorHit.replace('口味：', '').split('、')[0] : '';
      const openers = fl
        ? [`${fl}口，对你胃口`, `偏${fl}，是你喜欢的味道`, `${fl}味的${d.mainIngredient === '蔬菜' ? '素菜' : d.mainIngredient}，合你口味`]
        : [`${d.shop}的招牌菜`, `今天换个新口味试试`, `${d.shop}的人气款`];
      const first = openers[idx % openers.length];

      const facts = [];
      if (['蒸', '煮', '炖'].includes(d.method)) facts.push(`${d.method}的做法，油不重`);
      else if (d.oil === 1) facts.push('整体很清爽');
      if (d.rating >= 4.7) facts.push(`店铺评分 ${d.rating}，口碑稳`);
      if (d.eta <= 25) facts.push(`约 ${d.eta} 分钟送到，不耽误午休`);
      if (d.price <= 22) facts.push(`才 ¥${d.price}，很实惠`);
      if (!facts.length) facts.push(`${d.method}出来的${d.mainIngredient === '蔬菜' ? '时蔬' : d.mainIngredient}，分量足`);
      // 同一批推荐里尽量不用重复的卖点（ctx.usedFacts 由页面传入）
      const used = ctx.usedFacts || new Set();
      const rotated = facts.map((_, i) => facts[(seed + i) % facts.length]);
      const fact = rotated.find((f) => !used.has(f.slice(0, 4))) || rotated[0];
      used.add(fact.slice(0, 4));

      let tail;
      if (ctx.yesterday) tail = `跟昨天的${ctx.yesterday.mainDish}换个口味`;
      else if (d.staple) tail = '自带主食，一份就能吃饱';
      else tail = '可以加一份米饭';
      return `${first}，${fact}，${tail}。`;
    },

    async adjustToday(text) {
      // 预留：返回对打分的临时调整，例如 { boostMethods: ['煮','炖'], boostFlavors: [] }
      const t = text || '';
      return {
        boostMethods: /汤|暖|热乎/.test(t) ? ['煮', '炖'] : [],
        boostFlavors: /辣/.test(t) ? ['香辣', '麻辣'] : /清淡/.test(t) ? ['清淡'] : [],
      };
    },
  };

  // ---------------- 远程实现（调用 /api/ai） ----------------
  async function callRemote(task, payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_CONFIG.timeoutMs);
    try {
      const res = await fetch(AI_CONFIG.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, payload }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  // 只把必要字段发给后端，不发整份菜品库
  function slimItem(item) {
    const d = item.dish;
    return {
      name: d.name, shop: d.shop, method: d.method, oil: d.oil, fried: d.fried,
      staple: d.staple, flavors: d.flavors, hits: item.hits, warns: item.warns,
    };
  }

  async function withFallback(task, payload, mockFn) {
    if (AI_CONFIG.provider !== 'remote') return mockFn();
    try {
      const r = await callRemote(task, payload);
      if (r == null) throw new Error('empty');
      return r;
    } catch (e) {
      console.warn('[LunchAI] 远程调用失败，回退到本地模拟：', e.message);
      return mockFn();
    }
  }

  const LunchAI = {
    config: AI_CONFIG,
    parsePreference: (text) =>
      withFallback('parsePreference', { text, flavorOptions: FLAVOR_OPTIONS, avoidOptions: AVOID_OPTIONS },
        () => mock.parsePreference(text)),
    explain: (item, ctx) =>
      withFallback('explain', { item: slimItem(item), yesterday: ctx.yesterday ? ctx.yesterday.mainDish : null, index: ctx.index || 0 },
        () => mock.explain(item, ctx)),
    adjustToday: (text) =>
      withFallback('adjustToday', { text }, () => mock.adjustToday(text)),
  };

  window.LunchAI = LunchAI;
})();
