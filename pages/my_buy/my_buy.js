// pages/my_buy/my_buy.js
// 我买到的：我作为买家的订单
//
// 这个页面原来是一段写死的假数据（两个 Unsplash 图片 + 手写的昵称价格），
// 点进去还会跳到「商品不存在」。现在接上真实的 orders 集合。
//
// 页面定位：
//   我买到的  = 我下的单（不管成没成交，都要能看到，否则订单去哪了都不知道）
//   我卖出的  = 我作为卖家收到的订单 + 已成交的商品
const {
  ORDER_STATUS,
  ORDER_STATUS_TEXT,
  DELIVERY_STATUS,
  deliveryFeeOf,
  SUBSCRIBE_TEMPLATE
} = require('../../utils/cloud-config');
const { formatTime, formatPrice } = require('../../utils/util');
const { requestSubscribe, isDone } = require('../../utils/subscribe');
const { markGoodsChanged } = require('../../utils/goods-refresh');

Page({

  data: {
    orderList: [],
    // 顶部那条「订单有结果时通知我」横条要不要显示。
    // 开过一次就收起（标记存在本地，见 utils/subscribe.js）。
    subscribed: false,
    loading: false,
    emptyText: '还没有买到的商品'
  },

  // 点击卡片进商品详情
  onGoodsTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // 取消订单（只有待确认的能取消）
  onCancelTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '取消订单',
      content: '确认取消这笔订单？商品会重新上架，其他同学可以购买',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中...', mask: true });
        wx.cloud
          .callFunction({ name: 'order', data: { action: 'cancel', orderId: id } })
          .then((r) => {
            wx.hideLoading();
            const result = (r && r.result) || {};
            if (result.code !== 0) {
              wx.showToast({ title: result.message || '操作失败', icon: 'none' });
              return;
            }
            wx.showToast({ title: '已取消订单', icon: 'success' });
            // 商品被放回了货架，重新出现在在售池里
            markGoodsChanged();
            this.loadOrders();
          })
          .catch((err) => {
            wx.hideLoading();
            console.error('取消订单失败：', err);
            wx.showToast({ title: '网络异常，请重试', icon: 'none' });
          });
      }
    });
  },

  // 开启「订单状态通知」
  //
  // 买家最需要它的时刻很具体：下完单就退出小程序了，
  // 卖家什么时候点头他根本不知道，只能反复打开这个页面刷。
  // 这条通知就是为了取代「反复刷页面」。
  // onDone 只在【开启成功】时触发（见 utils/subscribe.js）：
  // 用户点了「拒绝」或权限被 ban，横条必须留着 —— 藏了就没入口了。
  onSubscribe() {
    requestSubscribe(SUBSCRIBE_TEMPLATE.ORDER_STATUS, '订单状态通知', () => {
      this.setData({ subscribed: true });
    });
  },

  loadOrders() {
    wx.showLoading({ title: '加载中...' });
    return wx.cloud
      .callFunction({ name: 'order', data: { action: 'listMine' } })
      .then((res) => {
        wx.hideLoading();
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '加载失败', icon: 'none' });
          return;
        }

        const orderList = (result.list || []).map((o) => {
          const delivery = o.delivery || {};
          // 还没人认领的单子。见下面 deliveryFee 的说明。
          const isWaiting = delivery.status === DELIVERY_STATUS.WAITING;

          return {
            id: o._id,
            goodsId: o.goodsId,
            // 商品信息来自订单里的快照，不是现查商品 ——
            // 商品被卖家删了，这条订单记录依然要能完整显示。
            // 快照里没有的原字段要给兜底，老订单可能缺字段。
            title: (o.goods || {}).title || '商品已删除',
            image: (o.goods || {}).image || '',
            price: formatPrice((o.goods || {}).price),
            campus: (o.goods || {}).campus || '',
            sellerName: (o.seller || {}).nickname || '校园用户',
            status: o.status,
            statusText: ORDER_STATUS_TEXT[o.status] || o.status,
            canCancel: o.status === ORDER_STATUS.PENDING,
            // 已关闭的订单要显示原因，否则用户只知道「被关了」，不知道为什么
            reason: o.cancelReason || '',
            time: formatTime(o.createTime),

            // 配送费。
            //
            // 买家在下单页见过这个数，但那是下完单就翻篇了 ——
            // 从下单到收货中间隔着卖家确认、配送员接单，拖几天都可能。
            // 收货那一刻要掏钱的人，得随时查得到掏多少、掏给谁，
            // 而不是站在宿舍楼下面靠回忆。
            //
            // isDelivery 单独存一个布尔：自提的单子根本没有 delivery 子文档，
            // 和「有 delivery 但费用是 0」是两回事，不能靠费用真假来判断。
            isDelivery: !!o.delivery,

            // 和配送中心池子里同一条规矩（见云函数 poolView）：
            //   还没人认领（waiting）→ 现算。这笔钱还没跟谁约定过，
            //     它只是「按商品单价算是多少」；价目表改了就该跟着改。
            //   已经被接单 → 读冻结值。那是当时跟配送员定下的账，
            //     价目表以后再怎么改都不能回头改它。
            deliveryFee: isWaiting
              ? deliveryFeeOf((o.goods || {}).price)
              : delivery.fee || 0
          };
        });

        this.setData({ orderList });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('加载订单失败：', err);
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  onShow() {
    // 放在 onShow：从详情页下完单返回，列表要立刻能看到新订单
    this.loadOrders();
    // 横条只在还没开过的时候显示，标记读本地（见 utils/subscribe.js）
    this.setData({ subscribed: isDone(SUBSCRIBE_TEMPLATE.ORDER_STATUS) });
  },

  onPullDownRefresh() {
    this.loadOrders().then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {

  }
});
