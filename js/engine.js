/**
 * 推荐引擎：规则过滤 + 打分排序（纯函数，不依赖页面，方便测试）
 *
 * 设计原则
 * - 硬约束（忌口、连续两天不重复）用确定性规则执行，永不放宽，也不交给大模型判断
 * - 软偏好（口味、少油、主食）用打分体现，影响排序但不直接排除
 * - “不要油炸”默认算过滤条件；候选不足时会自动放宽，并明确告诉用户放宽了什么
 */
(function () {
  // 打分权重，集中放在这里方便调参
  const W = {
    flavorHit: 18,       // 每命中一个偏好口味
    flavorMissAll: -10,  // 设置了口味偏好但一个都没命中
    oilLow: 16, oilMid: 4, oilHigh: -18,  // 开启“少油优先”时
    stapleYes: 12, stapleNo: -14,         // 开启“要有主食”时
    recentSameDish: -14,                  // 近 7 天每吃过一次同一道菜（昨天的已被硬性排除）
    recentSameIngredient: -6,             // 近 7 天每吃过一次同主料
    rating: 20,                           // (评分 - 4.5) * 20
    jitter: 12,                           // 按日期变化的小扰动，避免每天推荐完全一样
  };

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  }

  function yesterdayRecord(history, dayIndex) {
    return history.find((h) => h.dayIndex === dayIndex - 1) || null;
  }

  /** 第一步：硬约束 + 油炸过滤，返回候选与每条规则排除的数量 */
  function filterDishes(dishes, prefs, history, dayIndex, opts = {}) {
    const allowFried = !!opts.allowFried;
    const y = yesterdayRecord(history, dayIndex);
    const avoidSet = new Set(prefs.avoid || []);
    const removed = { avoid: [], repeat: [], fried: [] };
    const candidates = [];

    for (const d of dishes) {
      const hitAvoid = d.ingredients.filter((i) => avoidSet.has(i));
      if (hitAvoid.length) { removed.avoid.push({ dish: d, reason: hitAvoid }); continue; }

      if (y) {
        const sameDish = d.mainDish === y.mainDish;
        const sameIngr = prefs.avoidSameIngredient && d.mainIngredient === y.mainIngredient;
        if (sameDish || sameIngr) {
          removed.repeat.push({ dish: d, reason: sameDish ? '同一道主菜' : '同一种主料' });
          continue;
        }
      }

      if (prefs.noFried && d.fried && !allowFried) { removed.fried.push({ dish: d }); continue; }
      candidates.push(d);
    }
    return { candidates, removed, yesterday: y };
  }

  /** 第二步：给单道菜打分，同时生成“命中了什么 / 需要注意什么”，供界面和推荐理由使用 */
  function scoreDish(d, prefs, history, dayIndex) {
    let score = 0;
    const hits = [];
    const warns = [];

    const prefFlavors = prefs.flavors || [];
    if (prefFlavors.length) {
      const matched = d.flavors.filter((f) => prefFlavors.includes(f));
      if (matched.length) { score += matched.length * W.flavorHit; hits.push('口味：' + matched.join('、')); }
      else score += W.flavorMissAll;
    }

    if (prefs.lowOil) {
      if (d.oil === 1) { score += W.oilLow; hits.push('少油'); }
      else if (d.oil === 2) score += W.oilMid;
      else { score += W.oilHigh; warns.push('油量偏高'); }
    }
    if (prefs.noFried && !d.fried) hits.push('非油炸');
    if (d.fried) warns.push('油炸');

    if (prefs.wantStaple) {
      if (d.staple) { score += W.stapleYes; hits.push('含主食'); }
      else { score += W.stapleNo; warns.push('不含主食，可加一份米饭'); }
    }

    const av = prefs.avoid || [];
    if (av.length) hits.push('不含' + av.slice(0, 2).join('/') + (av.length > 2 ? '等' : ''));

    const recent = history.filter((h) => h.dayIndex < dayIndex && h.dayIndex >= dayIndex - 7);
    const sameIngrCount = recent.filter((h) => h.mainIngredient === d.mainIngredient).length;
    score += sameIngrCount * W.recentSameIngredient;
    const sameDishCount = recent.filter((h) => h.mainDish === d.mainDish).length;
    score += sameDishCount * W.recentSameDish;

    score += (d.rating - 4.5) * W.rating;
    score += hash(d.id + ':' + dayIndex) * W.jitter;

    return { dish: d, score: Math.round(score * 10) / 10, hits, warns };
  }

  /**
   * 完整排序：过滤 → 打分 → 排序
   * 候选不足 3 道时，放宽“不要油炸”（只放宽软条件，忌口和不重复永远不放宽）
   */
  function rank(dishes, prefs, history, dayIndex) {
    let result = filterDishes(dishes, prefs, history, dayIndex);
    const relaxed = [];
    if (result.candidates.length < 3 && prefs.noFried) {
      result = filterDishes(dishes, prefs, history, dayIndex, { allowFried: true });
      relaxed.push('符合条件的菜太少，已放宽“不要油炸”');
    }
    const ranked = result.candidates
      .map((d) => scoreDish(d, prefs, history, dayIndex))
      .sort((a, b) => b.score - a.score);

    return {
      ranked,
      removed: result.removed,
      yesterday: result.yesterday,
      relaxed,
      total: dishes.length,
    };
  }

  /**
   * 从排序结果里挑 n 道：优先保证主料不同（避免三道都是鸡肉）
   * keep: 已经在页面上、需要保留的菜 id（用于“换一个”时只替换一张卡片）
   * exclude: 本日已被“换掉”的菜 id
   */
  function pick(ranked, n = 3, keep = [], exclude = []) {
    const chosen = keep.map((id) => ranked.find((r) => r.dish.id === id)).filter(Boolean);
    const blocked = new Set([...keep, ...exclude]);
    const pool = ranked.filter((r) => !blocked.has(r.dish.id));

    for (const r of pool) {
      if (chosen.length >= n) break;
      const usedIngr = chosen.map((c) => c.dish.mainIngredient);
      const usedDish = chosen.map((c) => c.dish.mainDish);
      if (!usedIngr.includes(r.dish.mainIngredient) && !usedDish.includes(r.dish.mainDish)) chosen.push(r);
    }
    // 多样性要求太严导致不够时，再按分数补齐（仍然不放同一道主菜）
    for (const r of pool) {
      if (chosen.length >= n) break;
      if (!chosen.includes(r) && !chosen.some((c) => c.dish.mainDish === r.dish.mainDish)) chosen.push(r);
    }
    return chosen;
  }

  window.LunchEngine = { rank, pick, filterDishes, scoreDish, WEIGHTS: W };
})();
