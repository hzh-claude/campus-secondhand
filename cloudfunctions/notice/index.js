// cloudfunctions/notice/index.js
// 站内通知：列表 / 未读数 / 标记已读
//
// ============================================================
// 这个云函数为什么存在（而不是让前端直连数据库）
// ============================================================
//
// notifications 集合的权限必须设成「仅管理端可读写」——
// 和 users / orders / messages 一样。理由：
//   ① 前端直连的话，改 read 字段就是在客户端做的，
//      意味着「已读」这个状态可以被随便伪造（改成本地的 false 反复看红点，
//      或者更实际的问题：客户端要能更新文档，就得给它写权限，
//      而写权限是按【整个集合】给的，一个人就写得到别人的通知）；
//   ② 查询要按 _openid 过滤。云函数里用 getWXContext 拿到的 OPENID
//      是【微信认证过的】，客户端传什么参数都伪造不了它。
//      这条比第①条重要得多 —— 它就是这一整套的锁。
//
// 所以：这个函数里每一个查询的 where 都带 _openid，没有例外。
//
// 统一返回格式：{ code: 0, message: 'ok', ... }，code !== 0 表示失败
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// ⚠️ 集合名要和 utils/cloud-config.js 的 COLLECTION.NOTIFICATIONS、
//    以及 cloudfunctions/order/index.js 里的 NOTIFICATIONS 三处一致。
//    搜索 NOTIFICATIONS 能同时找到这三个地方。
//    云函数之间 require 不到，只能各写一份，这是项目已知的两端分叉。
const NOTIFICATIONS = 'notifications';

// 部署版本号：每次改动 +1。
// 「不支持的操作：xxx」这个报错九成是云函数没部署成功、云端还跑着旧代码。
// 版本号必须出现在【失败】路径上 —— 装在成功返回里等于失明，
// 因为部署没生效时你恰恰在失败那一边，根本看不到它。
const CODE_VERSION = 1;

const LIST_LIMIT = 30; // 单次拉取条数

// 通知列表
//
// 按 createTime 倒序 —— 通知和聊天不一样，永远只看最新的。
// 不做增量拉取（没有 since）：通知量小，而且不像聊天那样有
// 「页面开着的时候对面还在发」的场景，整段重拉就够了。
async function listNotifications(openid) {
  const res = await db
    .collection(NOTIFICATIONS)
    // ⚠️ 这个 where 不能省，也不能改成从 event 里取 openid。
    //    它就是「只能看到自己的通知」这条规则本身。
    .where({ _openid: openid })
    .orderBy('createTime', 'desc')
    .limit(LIST_LIMIT)
    .get();

  const list = (res.data || []).map((n) => ({
    id: n._id,
    type: n.type || 'system',
    title: n.title || '',
    body: n.body || '',
    page: n.page || '',
    orderId: n.orderId || '',
    read: !!n.read,
    createTime: n.createTime
  }));

  return { code: 0, message: 'ok', list };
}

// 未读数（「消息」页的角标用）
//
// 用 count() 而不是把列表拉回来数长度：列表有 LIST_LIMIT 上限，
// 超过 30 条以后数出来的数就不对了 —— 而且「999+ 变成 30」这种错，
// 用户不一定看得出来，只会觉得红点偶尔跳一下。
async function unreadTotal(openid) {
  const res = await db
    .collection(NOTIFICATIONS)
    .where({ _openid: openid, read: false })
    .count();

  return { code: 0, message: 'ok', unreadTotal: res.total || 0 };
}

// 标记单条已读
//
// 【为什么还要 where _openid】
//   已经知道 _id 了，doc(id).update() 更省事 —— 但那样就等于
//   「拿到（或者猜到）别人的通知 id 就能改别人的数据」。
//   这里走 where 而不是 doc：where 里带上 _openid，
//   别人的 id 传进来匹配不到任何记录，更新 0 条，静默失败，正好。
async function markRead(openid, event) {
  const id = String(event.id || '').trim();
  if (!id) return { code: 1, message: '缺少通知 ID' };

  const res = await db
    .collection(NOTIFICATIONS)
    .where({ _id: id, _openid: openid })
    .update({ data: { read: true } });

  // updated 为 0 有两种可能：本来就已读，或者这条根本不是你的。
  // 两种都不该报错 —— 对用户来说结果一样（这条不会再有红点），
  // 报错反而会让他以为「点了没反应」。前端拿 updated 只用于打日志。
  return { code: 0, message: 'ok', updated: (res.stats || {}).updated };
}

// 全部标记已读
//
// 这里【不加 limit】是故意的：云函数端的 where().update() 会更新
// 所有匹配的文档，不受客户端 20 条/次的限制。
// 加了 limit 反而会留下几条没清掉，用户点完「全部已读」还剩个红点，
// 会以为按钮坏了。
async function markAllRead(openid) {
  const res = await db
    .collection(NOTIFICATIONS)
    .where({ _openid: openid, read: false })
    .update({ data: { read: true } });

  return { code: 0, message: 'ok', updated: (res.stats || {}).updated };
}

// 删除单条通知
//
// 通知列表要是只能进不能出，攒到几十条以后这一页就没法看了。
// 和 markRead 同样的道理：走 where 带 _openid，不用 doc(id)。
async function remove(openid, event) {
  const id = String(event.id || '').trim();
  if (!id) return { code: 1, message: '缺少通知 ID' };

  const res = await db
    .collection(NOTIFICATIONS)
    .where({ _id: id, _openid: openid })
    .remove();

  return { code: 0, message: 'ok', removed: (res.stats || {}).removed };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = (event && event.action) || '';

  try {
    switch (action) {
      case 'list':
        return await listNotifications(OPENID);
      case 'unreadTotal':
        return await unreadTotal(OPENID);
      case 'markRead':
        return await markRead(OPENID, event);
      case 'markAllRead':
        return await markAllRead(OPENID);
      case 'remove':
        return await remove(OPENID, event);
      default:
        return {
          code: -1,
          message: '不支持的操作：' + action + '（云端版本 v' + CODE_VERSION + '）'
        };
    }
  } catch (err) {
    console.error('notice error:', action, err);
    return { code: -1, message: '操作失败：' + err.message };
  }
};
