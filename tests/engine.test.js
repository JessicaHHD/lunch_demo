const vm = require('vm'), fs = require('fs');
const ctx = { window: {}, console, localStorage: null };
vm.createContext(ctx);
for (const f of ['data','engine','ai']) vm.runInContext(fs.readFileSync(`js/${f}.js`,'utf8'), ctx);
const { DISHES } = ctx.window.LunchData, E = ctx.window.LunchEngine, AI = ctx.window.LunchAI;
let fail = 0; const assert = (c,m)=>{ if(!c){fail++;console.log('FAIL',m);} };

(async () => {
  const p = await AI.parsePreference('我不吃香菜和内脏，口味偏咸鲜，能吃一点辣，最近在控油，别给我推油炸的，要有米饭能吃饱');
  console.log('parsed:', JSON.stringify(p));
  assert(p.avoid.includes('香菜') && p.avoid.includes('内脏'), 'parse avoid');
  assert(p.noFried === true && p.lowOil === true && p.wantStaple === true, 'parse bools');

  for (const sameIngr of [false, true]) {
    const prefs = { flavors: ['咸鲜','香辣'], avoid: ['香菜','内脏'], noFried: true, lowOil: true, wantStaple: true, avoidSameIngredient: sameIngr };
    const history = [];
    console.log(`\n--- avoidSameIngredient=${sameIngr}`);
    for (let day = 0; day < 10; day++) {
      const r = E.rank(DISHES, prefs, history, day);
      const picks = E.pick(r.ranked, 3);
      assert(picks.length === 3, `day${day} 3 picks`);
      const y = history.find(h => h.dayIndex === day-1);
      for (const it of picks) {
        const d = it.dish;
        assert(!d.ingredients.some(i => prefs.avoid.includes(i)), `day${day} avoid ${d.name}`);
        assert(!d.fried, `day${day} fried ${d.name}`);
        if (y) assert(d.mainDish !== y.mainDish, `day${day} repeat ${d.name}`);
        if (y && sameIngr) assert(d.mainIngredient !== y.mainIngredient, `day${day} same ingr ${d.name}`);
      }
      assert(new Set(picks.map(x=>x.dish.mainDish)).size === 3, `day${day} distinct`);
      const choice = picks[day % 3].dish;   // 轮流选不同位置
      history.push({ dayIndex: day, mainDish: choice.mainDish, mainIngredient: choice.mainIngredient });
      console.log(`day${day+1}: ${picks.map(x=>`${x.dish.name}(${x.score})`).join(' | ')}  → 选 ${choice.name}`);
    }
  }

  // 跨店同款：昨天吃宫保鸡丁，两家店的宫保鸡丁都应被排除
  const r2 = E.rank(DISHES, { flavors:['麻辣'], avoid:[], noFried:false, lowOil:false, wantStaple:false }, [{dayIndex:0, mainDish:'宫保鸡丁', mainIngredient:'鸡肉'}], 1);
  assert(r2.removed.repeat.length === 2, 'cross-shop repeat');
  assert(!r2.ranked.some(x => x.dish.mainDish === '宫保鸡丁'), 'kungpao gone');

  // 极端忌口 → 放宽油炸
  const r3 = E.rank(DISHES, { flavors:[], avoid:['猪肉','鸡肉','牛肉','鱼','虾','鸡蛋','豆腐','蒜','葱','姜','辣椒','洋葱','香菇'], noFried:true, lowOil:true, wantStaple:true }, [], 0);
  console.log('\nextreme avoid → candidates', r3.ranked.length, r3.relaxed);

  // 换一个：保留另外两道
  const r4 = E.rank(DISHES, { flavors:['清淡'], avoid:[], noFried:true, lowOil:true, wantStaple:true }, [], 0);
  const first = E.pick(r4.ranked, 3).map(x=>x.dish.id);
  const keep = [first[0], first[2]];
  const nxt = E.pick(r4.ranked, 3, keep, [first[1]]).find(x=>!keep.includes(x.dish.id));
  assert(nxt && !first.includes(nxt.dish.id), 'swap gives new');
  console.log('swap', first, '→', nxt && nxt.dish.id);

  const ex = await AI.explain(E.scoreDish(DISHES[0], {flavors:['清淡'],avoid:[],noFried:true,lowOil:true,wantStaple:true}, [], 0), { yesterday: {mainDish:'宫保鸡丁'} });
  console.log('explain:', ex);
  console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
})();
