// utils/unread.js
// 未读消息红点。
//
// ============================================================
// 为什么「有人给你发消息」只能靠红点，不能推送
// ============================================================
//
// 小程序的一次性订阅消息，用户授权一次【只能收到一条】。
// 而聊天是连续多条的 —— 授权一次收到第一条之后，后面全都没了，
// 用户会以为对方不回了。这条路根本走不通。
// （长期订阅只对特定类目开放，校园二手交易拿不到。）
//
// 所以聊天通知只能反过来做：等用户自己打开小程序时，用红点告诉他。
// 能真正推送的只有「有人下单」，那个已经在 order 云函数里做了。
//
// ============================================================
// 为什么每个 tab 页都要各自刷一次
// ============================================================
//
// 本项目用的是自定义 tabBar（app.json 里 "custom": true）。
// 自定义 tabBar 的组件实例是【每个 tab 页各自一个】——
// 首页那份实例和「我的」那份互不相干，setData 也各改各的。
// 所以每换一个 tab 页，都得让它自己那份 tabBar 重新知道未读数，
// 否则会出现「在首页看不到红点、切到我的才有」这种半死不活的状态。
//
// 这也是为什么这里要显式接收页面实例：只有页面才拿得到
// 「自己那份」tabBar（page.getTabBar()），组件自己拿不到。

// 取某个云函数返回的 unreadTotal，失败给 0
//
// 单独 catch 而不是在外面统一 catch：两个渠道要【各自失败】。
// 统一 catch 的话，站内通知那个云函数（比如还没部署）一挂，
// 聊天未读数也一起变成 0 —— 一个没上线的新功能，把上线很久的
// 红点弄灭了。这种连带故障最难查，因为坏的看起来是好的那个。
function fetchUnread(name) {
  return wx.cloud
    .callFunction({ name, data: { action: 'unreadTotal' } })
    .then((res) => Number(((res && res.result) || {}).unreadTotal) || 0)
    .catch((err) => {
      // 红点刷不出来这件事，用户不需要知道，也不该弹提示打扰他。
      // 但控制台必须留一行 —— 否则「红点永远不出现」会变成一个
      // 完全无从下手的现象（没有报错、没有提示、就是不亮）。
      console.warn('未读数查询失败 name=' + name + '：', err);
      return 0;
    });
}

// 刷新当前页面所属 tabBar 的未读红点。
//
// page 传页面实例（在 onShow 里传 this）。
// 返回 Promise<{ chat, notice, total }>，失败时三个都是 0
// （两个渠道各自 catch，见 fetchUnread）。
//
// 【为什么返回细分，而不是只返回一个数字】
//   只返回 total 的话，「我的」页那个「我的消息」条目拿不到条数 ——
//   而它就是要显示条数的地方（2026-10-10 用户反馈：tabBar 上有红点，
//   进了「我的」却不知道点哪儿、也不知道有几条）。
//   这里反正已经查了两次，把两个数一起带出去，页面就不必再查第二遍。
//
// 【total 仍然是 tabBar 用的那个数】所有调用方都只关心它。
//
// 【红点为什么要算上站内通知】
//   站内通知是订阅消息的兜底渠道 —— 用户收不到微信推送时，
//   靠的就是「进小程序能看见」。如果它不计进这个红点，
//   用户就没有任何理由点进「消息」页，兜底等于没兜。
//   所以红点的含义是「有事情等着你看」，不是「有人给你发消息」，
//   聊天和通知都算。
//
// 【故意不做节流】onShow 触发很频繁（从详情页返回也算一次），
// 这里每触发一次就查一次云函数。加个「60 秒内不重复查」能省调用量，
// 但会带来一个更糟的问题：用户刚在聊天页把消息读完、返回时红点不消失，
// 他还以为没读掉。省调用量和「点进去读完红点就该灭」之间，选后者。
function refreshUnreadBadge(page) {
  return Promise.all([fetchUnread('chat'), fetchUnread('notice')]).then(
    ([chatUnread, noticeUnread]) => {
      const counts = {
        chat: chatUnread,
        notice: noticeUnread,
        total: chatUnread + noticeUnread
      };

      const tabBar =
        typeof page.getTabBar === 'function' && page.getTabBar();
      if (tabBar && typeof tabBar.setUnread === 'function') {
        tabBar.setUnread(counts.total);
      }
      return counts;
    }
  );
}

module.exports = { refreshUnreadBadge };
