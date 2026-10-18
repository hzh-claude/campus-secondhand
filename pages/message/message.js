// pages/message/message.js
// 「消息」页，分两段：聊天（会话列表）/ 通知（站内通知）
//
// ============================================================
// 为什么把通知并进这一页，而不是单独开一个页面
// ============================================================
//
// 「消息」这个地方在用户心里就是「别人找我 / 系统找我」的收件箱。
// 站内通知（有人买了你的东西、你的订单有结果了）正是这一类。
// 单独开一个页面的话，用户得先知道它存在才会去找 ——
// 而它存在的全部意义恰恰是【兜底】：订阅消息没送到的时候，
// 用户进小程序要能一眼看见。藏在一个没人知道的入口里就白做了。
//
// 所以是同一页的两个分段，不是两个功能。
//
// ============================================================
// 为什么用「分段」而不是把两种东西混在一个列表里
// ============================================================
//
// 两种条目的长相、点击去处、已读语义都不一样：
//   会话 → 点进去是一段可以继续的对话，未读按【会话】算
//   通知 → 点进去是订单列表，一条就是一条，读过就完了
// 混在一条时间轴上，用户分不清哪条点进去会开始打字。
const { formatChatTime, formatPrice } = require('../../utils/util');
const { DEFAULT_AVATAR } = require('../../utils/cloud-config');
const { refreshUnreadBadge } = require('../../utils/unread');

Page({

  data: {
    // 'chat' | 'notice'
    tab: 'chat',

    // ---- 聊天段 ----
    list: [],
    chatLoading: true,
    emptyText: '还没有聊过天',

    // ---- 通知段 ----
    notices: [],
    noticeLoading: true,
    noticeUnread: 0,

    // 默认头像。对方没设头像时由 WXML 兜底显示。
    // WXML 里读不到 require 进来的常量，只能挂到 data 上再引用
    defaultAvatar: DEFAULT_AVATAR
  },

  onLoad() {
    // 两段各自加载，不串行 —— 用户默认只看聊天段，
    // 那一段先出来就行，没必要等通知那边。
    this.loadList();
    this.loadNotices();
  },

  // 每次显示都重拉。
  // 不放在 onLoad 是因为从聊天页 / 订单页返回时 onLoad 不会再触发，
  // 那样列表上的「最后一条消息」和未读红点就会停在进去之前的样子 ——
  // 用户会以为消息没发出去、或者通知没读掉。
  onShow() {
    if (this.data.chatLoading) return; // 首次由 onLoad 负责，避免开局拉两次
    this.loadList();
    this.loadNotices();
  },

  // 切段
  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab });

    // 切到通知段时才清未读。
    // 【不能一进页面就清】—— 用户压根没看通知那一栏，
    // 红点就没了，那这个红点等于没起到提示作用。
    if (tab === 'notice') this.markAllRead();
  },

  // ============================================================
  // 聊天段
  // ============================================================
  loadList() {
    return wx.cloud
      .callFunction({ name: 'chat', data: { action: 'listConversations' } })
      .then((res) => {
        const r = (res && res.result) || {};
        if (r.code !== 0) {
          this.setData({ chatLoading: false });
          wx.showToast({ title: r.message || '加载失败', icon: 'none' });
          return;
        }
        // 时间在这儿就算好：WXML 里没法调 JS 函数
        this.setData({
          chatLoading: false,
          list: (r.list || []).map((c) =>
            Object.assign({}, c, {
              timeText: formatChatTime(c.lastTime),
              preview: c.lastMessage || '（还没有消息）',
              // 会话里记的是【创建那一刻的商品快照】，商品后来被改成
              // 1e25 这类脏数据也不影响它 —— 但快照本身也可能就是脏的。
              goodsPrice: formatPrice(c.goodsPrice),
              // 未读红点超过 99 就不再显示具体数字，否则会把头像挤变形
              badge: c.unread > 99 ? '99+' : String(c.unread)
            })
          )
        });
      })
      .catch((err) => {
        console.error('加载会话列表失败：', err);
        this.setData({ chatLoading: false });
        wx.showToast({ title: '网络异常，请下拉重试', icon: 'none' });
      });
  },

  // 进聊天页
  onOpenChat(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: '/pages/chat/chat?id=' + id });
  },

  // ============================================================
  // 通知段
  // ============================================================
  loadNotices() {
    return wx.cloud
      .callFunction({ name: 'notice', data: { action: 'list' } })
      .then((res) => {
        const r = (res && res.result) || {};
        if (r.code !== 0) {
          this.setData({ noticeLoading: false });
          // 这里【不弹 toast】。通知那一栏是兜底渠道，
          // 它挂了不该在用户一进页面时就糊他一脸错误 ——
          // 聊天段是好的，还能正常用。
          console.warn('加载通知失败：', r.message);
          return;
        }

        const list = r.list || [];
        this.setData({
          noticeLoading: false,
          notices: list.map((n) =>
            Object.assign({}, n, {
              timeText: formatChatTime(n.createTime),
              // 图标在 JS 里定好 —— WXML 里没法做这种映射。
              // 名字用 Vant 图标名，见 message.wxml 的 van-icon。
              icon: n.type === 'order_new' ? 'shopping-cart-o' : 'orders-o'
            })
          ),
          noticeUnread: list.filter((n) => !n.read).length
        });
      })
      .catch((err) => {
        console.error('加载通知失败：', err);
        this.setData({ noticeLoading: false });
      });
  },

  // 点通知 → 去对应的地方，并把这条标为已读
  onOpenNotice(e) {
    const index = Number(e.currentTarget.dataset.index);
    const notice = this.data.notices[index];
    if (!notice) return;

    this.readOne(notice);

    // page 由云函数决定，客户端只认白名单内的前缀。
    // 【不能直接 navigateTo(notice.page)】：page 存在数据库里，
    // 虽然目前只有我们自己写，但它是数据不是代码 ——
    // 将来有人能手改库里的字段，就变成了一个任意跳转的口子。
    // 这里只允许跳到项目自己的页面。
    const page = String(notice.page || '');
    if (page.indexOf('pages/') === 0) {
      wx.navigateTo({ url: '/' + page });
    }
  },

  // 删一条通知
  onRemoveNotice(e) {
    const index = Number(e.currentTarget.dataset.index);
    const notice = this.data.notices[index];
    if (!notice) return;

    wx.showModal({
      title: '删除通知',
      content: '删掉这条通知？',
      confirmText: '删除',
      confirmColor: '#ee0a24',
      success: (res) => {
        if (!res.confirm) return;
        wx.cloud
          .callFunction({ name: 'notice', data: { action: 'remove', id: notice.id } })
          .then((r) => {
            const result = (r && r.result) || {};
            if (result.code !== 0) {
              wx.showToast({ title: result.message || '删除失败', icon: 'none' });
              return;
            }

            // 本地先删掉，不等重新拉列表 —— 一次网络往返才消失的话，
            // 用户会以为没删掉，然后再点一次。
            const notices = this.data.notices.slice();
            notices.splice(index, 1);
            this.setData({
              notices,
              noticeUnread: notices.filter((n) => !n.read).length
            });
            this.refreshBadge();
          })
          .catch((err) => {
            console.error('删除通知失败：', err);
            wx.showToast({ title: '删除失败，请重试', icon: 'none' });
          });
      }
    });
  },

  // 标一条已读。已经是已读的就不再打云函数
  readOne(notice) {
    if (notice.read) return;

    // 本地先改，别等云函数回来 —— 点进去之后那个圆点还亮着，
    // 看着像没点上。
    const notices = this.data.notices.slice();
    const at = notices.findIndex((n) => n.id === notice.id);
    if (at >= 0) {
      notices[at] = Object.assign({}, notices[at], { read: true });
      this.setData({
        notices,
        noticeUnread: notices.filter((n) => !n.read).length
      });
    }
    this.refreshBadge();

    wx.cloud
      .callFunction({ name: 'notice', data: { action: 'markRead', id: notice.id } })
      .catch((err) => console.warn('标记通知已读失败：', err));
  },

  // 全部标为已读
  markAllRead() {
    if (!this.data.noticeUnread) return;

    const notices = this.data.notices.map((n) => Object.assign({}, n, { read: true }));
    this.setData({ notices, noticeUnread: 0 });
    this.refreshBadge();

    wx.cloud
      .callFunction({ name: 'notice', data: { action: 'markAllRead' } })
      .catch((err) => console.warn('全部标记已读失败：', err));
  },

  // 重算 tabBar 红点
  refreshBadge() {
    refreshUnreadBadge(this);
  },

  // 空状态时的「去逛逛」
  onGoHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  onPullDownRefresh() {
    const task = this.data.tab === 'notice' ? this.loadNotices() : this.loadList();
    task.then(() => wx.stopPullDownRefresh());
  }
});
