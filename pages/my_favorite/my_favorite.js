// pages/my_favorite/my_favorite.js
// 我的收藏：我点过「收藏」的商品
//
// 数据来自 favorites 集合（关联表），不是本地 Storage。
// 所以换台手机登录同一个微信，收藏依然在 —— 这是这次改造的核心目的。
const { GOODS_STATUS } = require('../../utils/cloud-config');
const { formatTime, formatPrice } = require('../../utils/util');

// 收藏的商品可能已经不是「出售中」了：
// 卖家可能下架了，或者已经被别人买走了。
// 这种要显式标出来，否则用户点进去才发现买不了，体验很差。
function statusLabel(status) {
  if (status === GOODS_STATUS.SOLD) return '已售出';
  if (status === GOODS_STATUS.OFF_SALE) return '已下架';
  return '在售';
}

Page({

  data: {
    favoriteList: [],
    loading: false,
    // 空列表时的提示文案，加载后按实际情况改写
    emptyText: '还没有收藏任何商品'
  },

  // 点击商品进详情
  onGoodsTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // 取消收藏（列表页直接取消，不用点进详情）
  onCancelTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '取消收藏',
      content: '确认不再收藏这件商品？',
      success: (res) => {
        if (!res.confirm) return;
        wx.cloud
          .callFunction({
            name: 'favorite',
            data: { action: 'toggle', goodsId: id }
          })
          .then((r) => {
            const result = (r && r.result) || {};
            if (result.code !== 0) {
              wx.showToast({ title: result.message || '操作失败', icon: 'none' });
              return;
            }
            wx.showToast({ title: '已取消收藏', icon: 'success' });
            // 直接从列表里剔掉，不重新拉一次接口 —— 少一次请求，
            // 而且避免「刚取消完又从列表消失/闪现」的抖动
            this.setData({
              favoriteList: this.data.favoriteList.filter((item) => item.id !== id)
            });
          })
          .catch((err) => {
            console.error('取消收藏失败：', err);
            wx.showToast({ title: '网络异常，请重试', icon: 'none' });
          });
      }
    });
  },

  // 加载收藏列表
  loadFavorites() {
    wx.showLoading({ title: '加载中...' });
    return wx.cloud
      .callFunction({ name: 'favorite', data: { action: 'list' } })
      .then((res) => {
        wx.hideLoading();
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '加载失败', icon: 'none' });
          return;
        }
        const favoriteList = (result.list || []).map((item) => ({
          id: item._id,
          title: item.title,
          image: item.image,
          price: formatPrice(item.price),
          campus: item.campus,
          status: item.status,
          statusText: statusLabel(item.status),
          // 只有还在售的才高亮，其余用灰色表示「已经买不到了」
          available: item.status === GOODS_STATUS.ON_SALE,
          favTime: formatTime(item.favTime)
        }));

        // 列表空了才打诊断 —— 那才是需要它的时候。
        // 原来是不管什么情况都打一遍，既刷屏，也把「把整个对象原样倒出来」
        // 养成了习惯。这个习惯正是上一次那个漏洞露出来的原因：
        // 云函数曾经在 diag 里夹带陌生人的 openid 原文，而这一行把它打印了。
        //
        // 现在两边都改了两道：云函数那边不再带别人的数据
        // （见 cloudfunctions/favorite/index.js），这里也不再无脑倒整个对象，
        // 只报真正用得上的那几个数。哪边先失守都不会直接把数据摆出来。
        //
        // 这几个数分别说明什么：
        //   favCount = 0                   → where({_openid}) 一条都没匹配到
        //   favCount > 0 但 goodsFound = 0 → 收藏记录在，但商品都查不到
        if (favoriteList.length === 0) {
          const d = result.diag || {};
          console.log(
            '【收藏列表诊断】favCount=' + d.favCount +
            ' goodsFound=' + d.goodsFound +
            ' 库内总条数=' + d.totalInCollection
          );
        }

        // 空列表分两种：真的没收藏过，还是收藏的商品都被删了。
        // 原来都显示「还没有收藏任何商品」，后者是在骗用户。
        let emptyText = '还没有收藏任何商品';
        if (favoriteList.length === 0 && (result.diag || {}).favCount > 0) {
          emptyText = '收藏的商品已被卖家删除';
        }

        this.setData({ favoriteList, emptyText });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('加载收藏失败：', err);
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  onShow() {
    // 放在 onShow 而不是 onLoad：用户可能刚在详情页收藏了商品再退回来，
    // onLoad 只跑一次，列表就不会更新
    this.loadFavorites();
  },

  onPullDownRefresh() {
    this.loadFavorites().then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {

  }
});
