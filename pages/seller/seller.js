// pages/seller/seller.js
//
// 卖家主页：点商品详情页的卖家那一行进来，看这个人发布的【全部在售商品】。
//
// 【数据从哪来 —— 只查 goods 集合，不查 users】
//   全项目没有任何一处从客户端读 users 集合（已 grep 确认）。
//   users 里存着手机号、微信号、学号，它的读权限一定收得很紧，
//   硬要去读只会拿到一个「没有权限」的错误。
//
//   好在不需要：发布商品时，卖家的头像和昵称已经【抄了一份】
//   写进商品文档的 publisher 字段里了（见云函数 publishGoods 的
//   buildPublisher）。所以拿这个人的商品列表，顺便就知道了他是谁。
//
// 【这也决定了「这个人没有在售商品」时的样子】
//   那时候一行都查不到，也就拿不到 publisher ——
//   头像昵称只能用详情页跳过来时塞在 URL 里的那份占位。
//   所以那一屏会是「真名字 + 一个商品都没有」，而不是空白或报错。
//
// 【隐私边界】
//   这一页展示的字段和首页卡片完全一样：标题、价格、图、交易地点、浏览量。
//   没有手机号、没有收货地址、没有详细住址 —— 卖家主页不是「人肉页」，
//   只是把他的商品换个角度再列一遍。

const { COLLECTION, GOODS_STATUS, PAGE_SIZE, DEFAULT_AVATAR } = require('../../utils/cloud-config');
const { consumeGoodsChanged } = require('../../utils/goods-refresh');

// URL 参数解码
//
// 【为什么要包 try】
//   微信在 onLoad 的 options 里给的值，多数基础库已经帮你解码过一次了。
//   再解一次，遇到值里带孤立 % 的（昵称就叫「全场100%新」）会抛 URIError，
//   整个 onLoad 挂掉、页面白屏。
//   抛了就说明它已经是明文，原样用即可 —— 这里宁可少解一层，
//   也不能让一个昵称把页面弄崩。反正这只是占位，真值以数据库查到的为准。
function safeDecode(value) {
  const raw = String(value == null ? '' : value);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    return raw;
  }
}

Page({

  data: {
    // 默认头像。WXML 读不到 require 进来的常量，只能挂到 data 上引用
    defaultAvatar: DEFAULT_AVATAR,

    seller: {
      openid: '',
      nickname: '校园用户',
      avatar: '',
      publishCount: 0, // 累计发布（含已卖出）
      soldCount: 0     // 已卖出
    },

    goodsList: [],
    page: 0,
    isEnd: false,
    loading: true,   // 首屏加载中
    empty: false     // 加载完了，但这个人一件在售的都没有
  },

  onLoad(options) {
    const openid = safeDecode(options.openid);

    // 没有 openid 就没有主角，这一页没有任何东西可以查。
    // 正常路径上不会发生（详情页拿不到 _openid 时就不跳了），
    // 但用户可以手改 URL、或者从旧分享进来 —— 兜一下，别白屏。
    if (!openid) {
      this.setData({ loading: false, empty: true });
      wx.showToast({ title: '卖家信息不完整', icon: 'none' });
      return;
    }

    // 先用详情页带过来的昵称头像把首屏撑起来，别让页面先空一下。
    // 这只是占位，下面 loadGoods 查到东西会用数据库那份覆盖，见 applyGoods。
    const nickname = safeDecode(options.nickname) || '校园用户';
    const avatar = safeDecode(options.avatar);

    this.setData({
      'seller.openid': openid,
      'seller.nickname': nickname,
      'seller.avatar': avatar
    });

    // 标题跟着名字走，让人一眼知道在看谁
    wx.setNavigationBarTitle({ title: nickname + ' 的主页' });

    this.loadGoods(true);
    this.loadStats(openid);
  },

  // 拉这个卖家【在售】的商品
  //
  // 只查 ON_SALE：已卖出的东西摆在主页上没有意义，
  // 点进去也是个不能买的详情页，只会让人以为还有货。
  // 卖了多少件是另一个数，由 loadStats 单独给，走页头的「卖出 N」。
  loadGoods(reset) {
    if (this.data.loading && !reset) return Promise.resolve();
    if (!reset && this.data.isEnd) return Promise.resolve();

    this.setData({ loading: true });
    const page = reset ? 0 : this.data.page;
    const db = wx.cloud.database();

    return db
      .collection(COLLECTION.GOODS)
      .where({ _openid: this.data.seller.openid, status: GOODS_STATUS.ON_SALE })
      .orderBy('createTime', 'desc')
      .skip(page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .get()
      .then((res) => {
        const list = (res.data || []).map((item) => ({
          id: item._id,
          title: item.title,
          // price 传【原始值】不预格式化：goods-card 组件内部自己会调
          // formatPrice（见组件 index.js 的 observers），而且 card 是
          // 首页/分类页/搜索页共用的，格式化规则必须只有一个出处。
          price: item.price,
          image: (item.images && item.images[0]) || '',
          campus: item.campus,
          views: item.views || 0,
          publisher: item.publisher || { avatar: '', nickname: '校园用户' }
        }));

        // 查到东西了，用数据库那份刷新页头的昵称头像
        if (list.length) this.applyGoods(list[0].publisher);

        this.setData({
          goodsList: reset ? list : this.data.goodsList.concat(list),
          page: page + 1,
          isEnd: list.length < PAGE_SIZE,
          loading: false,
          // 只有「第一页就没有东西」才算空。
          // 翻到后面某一页刚好查完（list 为空但前面有货）不能显示空状态 ——
          // 那时页面下半部分还挂着上面几屏商品呢。
          empty: reset && list.length === 0
        });
      })
      .catch((err) => {
        console.error('加载卖家商品失败：', err);
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  // 用商品里那份 publisher 刷新页头
  //
  // 【优先级：查出来的胜过 URL 带来的】
  //   URL 里那份是详情页离开时拍的照片，可能已经旧了
  //   （卖家刚改了昵称头像）。数据库里的是当下值。
  //   规则写在这里一处，别处不要再各自决定用谁。
  applyGoods(publisher) {
    if (!publisher) return;
    const patch = {};
    if (publisher.nickname) {
      patch['seller.nickname'] = publisher.nickname;
      wx.setNavigationBarTitle({ title: publisher.nickname + ' 的主页' });
    }
    // 头像可能是空字符串（卖家没设），那时候保留占位那份比清空要好 ——
    // 清空之后页头会退成默认头像，凭空闪一下。
    if (publisher.avatar) patch['seller.avatar'] = publisher.avatar;
    if (Object.keys(patch).length) this.setData(patch);
  },

  // 发布数 / 卖出数
  //
  // 口径和商品详情页那一行完全一致（detail.js 的 loadPublisherStats）：
  //   发布 = 这个人名下的【全部】商品，不分状态
  //   卖出 = status 是 sold 的
  // 两处必须同口径 —— 否则同一对数字在详情页和卖家主页显示得不一样，
  // 用户只会觉得其中一个在骗人。
  loadStats(openid) {
    const db = wx.cloud.database();
    return Promise.all([
      db.collection(COLLECTION.GOODS).where({ _openid: openid }).count().catch(() => ({ total: 0 })),
      db
        .collection(COLLECTION.GOODS)
        .where({ _openid: openid, status: GOODS_STATUS.SOLD })
        .count()
        .catch(() => ({ total: 0 }))
    ]).then(([publishRes, soldRes]) => {
      this.setData({
        'seller.publishCount': publishRes.total || 0,
        'seller.soldCount': soldRes.total || 0
      });
    });
  },

  // 点卡片 → 商品详情
  //
  // ID 由组件的 cardtap 事件回传（e.detail.id），不是从 data-* 读的。
  // 原因见 components/goods-card/index.js 顶部：glass-easel 下 data-* 不可靠。
  onGoodsTap(e) {
    const id = e.detail && e.detail.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  // 从详情页下单回来时，刚买的那件不该再挂在「TA 的在售商品」里。
  //
  // 【这一页原来完全没有 onShow】，所以列表只在 onLoad 拉一次 ——
  // 买完退回来，商品还在，连「TA 暂时没有在售商品」的空状态都不会更新。
  //
  // 只在【真的改动过商品】时重查，理由见 utils/goods-refresh.js 顶部
  // （总结：无条件重查会把用户翻了半天的分页打回第一页，代价更大）。
  onShow() {
    if (consumeGoodsChanged()) {
      this.loadGoods(true);
      // 统计数字也要跟着重来 —— 「卖出 N」正是卖掉一件之后会变的那个数。
      // 只刷列表不刷统计的话，页头会停在一个和列表对不上的旧值上。
      this.loadStats(this.data.seller.openid);
    }
  },

  onPullDownRefresh() {
    // 两个请求并发，谁先回来不确定 —— 所以收转圈必须等【两个都完】，
    // 不能挂在 loadGoods 的 then 里（那样统计数字可能还没到，
    // 页头上的「卖出 N」会停在旧值上）。
    // 两个方法内部都各自 catch 过了，永远不会 reject，
    // 所以这里不需要 catch，也就不会出现「出错了转圈永远不停」。
    Promise.all([this.loadGoods(true), this.loadStats(this.data.seller.openid)]).then(() =>
      wx.stopPullDownRefresh()
    );
  },

  onReachBottom() {
    this.loadGoods(false);
  }
});
