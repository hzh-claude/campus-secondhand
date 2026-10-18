// cloudfunctions/favorite/index.js
// 收藏功能：查询收藏状态 / 收藏与取消 / 我的收藏列表
//
// 数据模型：favorites 集合，一条记录 = 一次收藏
//   { _openid: 谁收藏的, goodsId: 收藏了哪个商品, createTime }
//
// 为什么用独立的关联表，而不是在 users 档案里存一个 goodsId 数组？
//   要算「这个商品有多少人收藏」，数组方案得把所有用户的数组扫一遍，不可行；
//   关联表按 goodsId 一 count 就出来了。而且数组会随收藏数无限增长。
//   这是「一对多用关联表、不用数组」的经典取舍。
//
// 关于「N人收藏」这个数字：这里用实时 count，【不做】goods.favorites 冗余计数字段。
//   冗余的代价是两份数据可能不一致（插入记录成功但计数+1失败、用户连点两次插了
//   两条记录……），而这类不一致没有任何机制能自动发现。
//   只有当「每次 count」变成性能问题时（比如列表页要显示 10 个商品的收藏数），
//   才值得付这个代价。现在只有详情页显示，实时 count 完全够用。
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const FAVORITES = 'favorites';
const GOODS = 'goods';

// 每次改动 +1。用来一眼确认云端跑的是哪个版本 ——
// 云函数没部署成功时，行为异常但不会明说，版本号能让它自己招供。
//
// v6：list 不再把陌生人的 _openid 带回给调用者（原来会带 5 个）。
//     这次尤其要把它顶上去 —— 泄露是「行为少了一部分」而不是「功能报错」，
//     部署没生效时界面一切正常，只有这个数字能证明新的真的上去了。
const CODE_VERSION = 6;
const MAX_LIST = 100;

// 某个商品被收藏的总数
async function countByGoods(goodsId) {
  const res = await db.collection(FAVORITES).where({ goodsId }).count();
  return res.total || 0;
}

// 我有没有收藏这个商品，返回那条记录或 null
async function findMine(openid, goodsId) {
  const res = await db
    .collection(FAVORITES)
    .where({ _openid: openid, goodsId })
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

// 查收藏状态（详情页加载时调）
async function check(openid, goodsId) {
  if (!goodsId) return { code: 1, message: '缺少商品 ID' };

  // 顺带判断「这商品是不是我自己发的」。
  // 放在服务端算，前端只负责展示；否则前端得先知道自己 openid 再比对，
  // 多一次请求还容易被绕过。
  const goodsRes = await db.collection(GOODS).doc(goodsId).get().catch(() => null);
  const goods = goodsRes && goodsRes.data;

  const [mine, count] = await Promise.all([
    findMine(openid, goodsId),
    countByGoods(goodsId)
  ]);

  return {
    code: 0,
    message: 'ok',
    isFavorite: !!mine,
    count,
    isOwner: !!(goods && goods._openid === openid)
  };
}

// 收藏 / 取消收藏
async function toggle(openid, goodsId) {
  if (!goodsId) return { code: 1, message: '缺少商品 ID' };

  // 先确认商品还在，否则会收藏到一个已经被删除的 ID 上
  const goodsRes = await db.collection(GOODS).doc(goodsId).get().catch(() => null);
  if (!goodsRes || !goodsRes.data) {
    return { code: 1, message: '商品不存在或已删除' };
  }

  // 必须「先查再写」：直接插入的话，用户连点两次就会出现两条记录，
  // 商品上的收藏数直接虚高。
  //
  // 注意这里仍有竞态：两个请求同时到达、都查到「不存在」、都插入，还是两条。
  // 根治办法是给 (_openid, goodsId) 建唯一索引，让数据库层兜底
  // （云开发控制台 → 数据库 → favorites → 索引管理）。
  // 前端还有一层防抖，三层一起才稳。
  const existed = await findMine(openid, goodsId);

  if (existed) {
    await db.collection(FAVORITES).doc(existed._id).remove();
  } else {
    await db.collection(FAVORITES).add({
      data: {
        // 云函数 add 不会自动写 _openid，必须手动带上
        _openid: openid,
        goodsId,
        createTime: new Date()
      }
    });
  }

  const count = await countByGoods(goodsId);

  return {
    code: 0,
    message: existed ? '已取消收藏' : '收藏成功',
    isFavorite: !existed,
    count
  };
}

// 我的收藏列表
async function list(openid) {
  // 诊断信息：把「查到几条收藏 / 解析出几个商品 / 跳过几个」一路带回去。
  //
  // 为什么要有这个？因为原来的版本在商品查不到时用 `if (!g) return` 直接跳过，
  // 结果「一条收藏都没匹配到」和「收藏的商品被删了」两种完全不同的原因，
  // 全都表现为页面一片空白、且一句报错都没有，排查时无从下手。
  // 静默吞掉失败信息是坏设计 —— 出了事，代码得会说话。
  //
  // ⚠️【这个对象只允许带调用者自己的数据回去】
  //   它曾经把陌生人的 _openid 原文也带了回去（见下面 favs.length === 0
  //   那一段里记的经过）。往这里加字段之前先问一句：
  //   这个值是「调用者自己的」还是「从别人记录里读来的」？
  //   后者一个都不能加 —— 这是个面向任意用户的返回体，不是服务端日志。
  const diag = {
    openid,        // 当前调用者的 openid，用来和数据库里的记录逐字符比对
    favCount: 0,   // where({_openid}) 匹配到几条收藏
    goodsFound: 0, // 其中几个商品还存在于 goods 集合
    ids: []        // 收藏记录里存的 goodsId 原值
  };

  const favRes = await db
    .collection(FAVORITES)
    .where({ _openid: openid })
    .orderBy('createTime', 'desc')
    .limit(MAX_LIST)
    .get();

  const favs = favRes.data || [];
  diag.favCount = favs.length;
  diag.ids = favs.map((f) => f.goodsId);

  if (favs.length === 0) {
    // 【这一段原来会把陌生人的 openid 原样发回给调用者，已经删掉了】
    //
    // 原来的做法：不带条件地从收藏集合捞 5 条记录，把它们的 _openid
    // 原文塞进返回值（diag.storedOpenids[].value），再把其中第一条
    // 和调用者的 openid 逐字符比对、连码点差异一起返回（diag.charDiff）。
    //
    // 那 5 条【不是调用者的】—— 他自己的查询刚刚返回 0 条，
    // 库里剩下的全都是别人的收藏。于是任何一个刚注册、还没收藏过东西的人，
    // 只要调一次 list，就能拿到 5 个陌生人的 openid 原文。
    // 前端还把它整个 JSON.stringify 打进了 Console
    // （见 pages/my_favorite/my_favorite.js），这个口子就摆在了明面上。
    // 这不是「附带了一些调试信息」，是隐私泄露。
    //
    // 更要紧的是：它其实【没用】。调用者查到 0 条时，被抽样的那条记录
    // 按定义就是别人的 —— 拿它和调用者自己的 openid 逐字符比对，
    // 永远「不相等」。这个诊断在多人共用的库里报出来的差异全是噪声，
    // 只会把人往错的方向带。
    //
    // 它当初是为「同形异码」那次事故造的，那次是【手抄】28 位 openid 抄错一位。
    // 但那个前提已经不存在了：造数据的 seed 动作已经删掉（见文件末尾），
    // 现在 _openid 只由 toggle 写入、值直接取自 cloud.getWXContext()，
    // 而这里的查询条件也来自同一个 getWXContext()。
    // 同一个权威来源，两端不可能对不上 —— 它一直在为一个不可能发生的 bug
    // 翻别人的数据。
    //
    // 保留下来的只有不碰任何个人数据的那部分：集合里总共有多少条。
    // 它够区分「库是空的」和「库有数据、但我一条都没有」，
    // 而且是个聚合数字，不指向任何个人 ——
    // 详情页本来就公开展示「N 人收藏」这个量级的信息。
    const totalRes = await db.collection(FAVORITES).count();
    diag.totalInCollection = totalRes.total;

    return { code: 0, message: 'ok', list: [], skipped: 0, diag };
  }

  // 一次查回所有商品，避免逐个查询
  const goodsRes = await db
    .collection(GOODS)
    .where({ _id: _.in(favs.map((f) => f.goodsId)) })
    .get();

  const goodsMap = {};
  (goodsRes.data || []).forEach((g) => {
    goodsMap[g._id] = g;
  });

  // 按收藏时间倒序重新拼装（_.in 查询不会保持传入的顺序），
  // 顺带跳过已经被卖家删除的商品
  const list = [];
  favs.forEach((f) => {
    const g = goodsMap[f.goodsId];
    if (!g) return;
    list.push({
      _id: g._id,
      title: g.title,
      price: g.price,
      image: (g.images && g.images[0]) || '',
      campus: g.campus || '',
      // 带上状态：收藏的商品可能已经被下架或卖掉了，界面要能标出来
      status: g.status,
      favTime: f.createTime
    });
  });

  diag.goodsFound = list.length;

  return {
    code: 0,
    message: 'ok',
    list,
    // 被跳过几件（商品已被删除）—— 前端据此给出提示，而不是默默少显示几条
    skipped: favs.length - list.length,
    diag
  };
}

// ============================================================
// 【已删除】seed —— 开发期用来造测试收藏的动作
// ============================================================
//
// 它当初为什么存在：正常流程下你没法收藏自己的商品（这是对的），
// 所以开发阶段要测收藏，就得手动往数据库插记录 —— 而手抄 28 位 openid
// 抄错一个字符就前功尽弃（那次同形异码事故就是这么来的），
// 而且这种错误在数据库界面上的表现和「字符完全一样」，肉眼根本查不出来。
// 让代码去构造数据，人只负责点按钮，这类问题才会绝迹。
//
// 为什么现在必须删：它【没有任何权限校验】，谁调用都能给任意账号写收藏记录。
// 开发期只有一个人用，看不出来；上线后就是一个可被滥用的写接口。
//
// 留下的教训：造测试数据的正确做法是「让代码写」而不是「让人抄」，
// 但这类口子用完必须收回 —— 两者不矛盾，是两步。

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = (event && event.action) || 'check';

  try {
    switch (action) {
      case 'check':
        return await check(OPENID, event.goodsId);
      case 'toggle':
        return await toggle(OPENID, event.goodsId);
      case 'list':
        return await list(OPENID);
      default:
        return {
          code: 1,
          message: '不支持的操作：' + action + '（云端版本 v' + CODE_VERSION + '）'
        };
    }
  } catch (err) {
    console.error('favorite error:', action, err);
    return { code: -1, message: '操作失败：' + err.message };
  }
};
