// pages/my_sold/my_sold.js
// 我卖出的：我作为卖家的订单 + 已成交商品的归档
// 页面定位与「我发布的」区分开：
//   我发布的 = 还在我手上、需要管理的（出售中 / 已被预订 / 已下架）
//   我卖出的 = 跟成交有关的（待我确认的订单 / 已经卖掉的）
//
// 分两段：
//   1. 待确认订单 —— 买家下了单，等我点头。这是【需要我行动】的，放最上面。
//   2. 已卖出     —— 成交归档，只读。
const {
  ORDER_STATUS,
  ORDER_STATUS_TEXT,
  SUBSCRIBE_TEMPLATE
} = require('../../utils/cloud-config');
const { formatTime, formatPrice } = require('../../utils/util');
const { requestSubscribe, isDone } = require('../../utils/subscribe');
const { markGoodsChanged } = require('../../utils/goods-refresh');

Page({

  data: {
    orderList: [], // 待我确认的订单
    soldList: [], // 已卖出的商品
    // 我自己的手机号（卖家视角）。留过一次就存在用户资料里，
    // 以后再遇到配送单就不用问了。
    myPhone: '',
    // 顶部那条「有人下单时通知我」横条要不要显示。
    // 开过一次就收起（标记存在本地，见 utils/subscribe.js）。
    subscribed: false,
    loading: false
  },

  // 点击商品
  onGoodsTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // 从列表里找出这一单。
  // 用 filter 而不是 find —— 小程序的 JS 环境在老基础库上没有 find。
  findOrder(id) {
    return this.data.orderList.filter((o) => o.id === id)[0] || null;
  },

  // 确认卖出
  onConfirmTap(e) {
    const { id } = e.currentTarget.dataset;
    const order = this.findOrder(id);

    // 配送单 + 我还没留过电话 → 先问电话，再确认。
    //
    // 问在【确认之前】，不是确认之后：确认之后商品就标成已售出了，
    // 这时候再说「请补充电话」，卖家关掉弹窗就卡在那儿了 ——
    // 配送员到了楼下联系不上人，只能干等。
    if (order && order.isDelivery && !this.data.myPhone) {
      this.promptSellerPhone(id, '已确认卖出');
      return;
    }

    wx.showModal({
      title: '确认卖出',
      content: '确认把这件商品卖给这位买家？确认后商品会标记为已售出',
      confirmText: '确认卖出',
      success: (res) => {
        if (!res.confirm) return;
        this.callOrder('confirm', id, '已确认卖出');
      }
    });
  },

  // 收一个取货电话。
  //
  // 用 wx.showModal 的 editable 模式，而不是自己写弹层：
  // 这里只要一个输入框，为了它引一整个 van-dialog 到页面里不划算。
  //
  // 为什么这件事只有配送单要做：自提是买卖双方自己约时间地点，
  // 平台不参与取货。而且问到的号会存进用户资料，一辈子只问一次。
  promptSellerPhone(orderId, successText) {
    wx.showModal({
      title: '留个取货电话',
      content: this.data.myPhone || '',
      editable: true,
      placeholderText: '配送员上门取货时联系你',
      confirmText: '确认卖出',
      success: (res) => {
        if (!res.confirm) return;
        const phone = String(res.content || '').trim();

        // 前端先挡一道，是为了让用户【当场】改 —— 而不是提交完
        // 转一圈回来才告诉他格式不对。云函数那边还会再校验一次，
        // 那一道才是真正算数的（前端挡不住改请求的人）。
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          wx.showToast({ title: '手机号格式不对', icon: 'none' });
          return;
        }

        this.callOrder('confirm', orderId, successText, {
          sellerPhone: phone
        });
      }
    });
  },

  // 拒绝订单
  onRejectTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '拒绝订单',
      content: '确认拒绝？商品会重新上架，其他同学可以购买',
      success: (res) => {
        if (!res.confirm) return;
        this.callOrder('reject', id, '已拒绝订单');
      }
    });
  },

  // confirm / reject 的公共调用逻辑
  //
  // extra：额外的请求参数（目前只有 confirm 会用，带 sellerPhone）。
  //   单独开一个参数，而不是让调用方自己拼 data 对象 —— 这样
  //   action/orderId 永远拼在正确的位置上，不会因为调用方手滑漏掉。
  callOrder(action, orderId, successText, extra) {
    wx.showLoading({ title: '处理中...', mask: true });
    wx.cloud
      .callFunction({
        name: 'order',
        data: Object.assign({ action, orderId }, extra || {})
      })
      .then((r) => {
        wx.hideLoading();
        const result = (r && r.result) || {};
        if (result.code !== 0) {
          // 云函数说「这单得要个电话」= 前端漏问了。
          // 什么时候会漏：用户资料里存着的号格式不对（早期填的、后端没校验），
          // 前端看到「有值」就以为万事大吉。这种情况把用户晾在一句
          // 红色 toast 上没意义 —— 他不知道该干什么。直接回到输入框。
          //
          // 不会死循环：promptSellerPhone 会先用同样的正则挡一道，
          // 输错了根本不会发请求。
          if (result.code === 2 && result.needPhone) {
            this.promptSellerPhone(orderId, successText);
            return;
          }
          // 失败原因可能是「商品状态已变化」这类并发冲突，必须原样告诉用户，
          // 不能统一吞成「操作失败」—— 他需要知道该刷新还是该重试
          wx.showToast({ title: result.message || '操作失败', icon: 'none' });
          return;
        }
        wx.showToast({ title: successText, icon: 'success' });
        // 确认卖出 → 商品变 sold；拒绝 → 商品回到 on_sale。
        // 两种都改动了在售池，所以首页/分类页那边要重查。
        markGoodsChanged();
        this.loadAll();
      })
      .catch((err) => {
        wx.hideLoading();
        console.error(action + ' 失败：', err);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      });
  },

  // 撤销卖出：点错了能救回来，商品会回到「我发布的 · 出售中」
  onUndoSoldTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '撤销卖出',
      content: '确认撤销？该商品会重新回到「我发布的 · 出售中」',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中...' });
        wx.cloud
          .callFunction({ name: 'manageGoods', data: { action: 'undoSold', id } })
          .then((r) => {
            wx.hideLoading();
            const result = (r && r.result) || {};
            if (result.code !== 0) {
              wx.showToast({ title: result.message || '操作失败', icon: 'none' });
              return;
            }
            wx.showToast({ title: result.message || '已撤销卖出', icon: 'success' });
            // 商品从 sold 回到了 on_sale —— 它重新出现在在售池里了
            markGoodsChanged();
            this.loadAll();
          })
          .catch((err) => {
            wx.hideLoading();
            console.error('撤销卖出失败：', err);
            wx.showToast({ title: '操作失败，请稍后重试', icon: 'none' });
          });
      }
    });
  },

  // 开启「新订单通知」
  //
  // 为什么放在这个页面：「我卖出的」是卖家唯一会主动打开看订单的地方，
  // 入口放这里，他第一次进来就能看到。
  //
  // 为什么得让他反复点：微信只开放「一次性订阅」，一次授权只能发一条。
  // 点一次攒一条额度，有人下单时用掉一条。
  // 【2026-10-14】界面上不再写「1 条」这句提示了（产品要求），
  // 但事实没变 —— 所以 toast 只说到「已开启」为止，别升级成
  // 「有新消息会通知你」那种兑现不了的承诺。
  //
  // onDone 是【开启成功之后】才触发的：用户点了「拒绝」或者被
  // 微信 ban 掉，横条都不该消失 —— 那等于把唯一的入口藏了。
  onSubscribe() {
    requestSubscribe(SUBSCRIBE_TEMPLATE.NEW_ORDER, '新订单通知', () => {
      this.setData({ subscribed: true });
    });
  },

  // 加载订单 + 已卖出商品
  loadAll() {
    wx.showLoading({ title: '加载中...' });

    // 【为什么两个请求各自兜底，而不是直接 Promise.all】
    //
    //   原来是裸的 Promise.all —— 两个请求里任意一个失败，就一起进 .catch：
    //   「待我确认」和「已卖出」两个区【同时变空】。
    //   而真相可能只是 listSold 那一个接口抖了一下。
    //
    //   ⚠️ 这比「加载失败」更糟：它给出了一个错误的事实。
    //      卖家打开这一页看到的两栏都是空的，第一反应是
    //      「我的订单和货都没了」—— 而页面本来只是想说「网络不好」。
    //
    //   所以改成谁失败谁兜底（返回空对象），另一块照常显示，
    //   最后单独提示是哪一块没拉到。
    //
    // ⚠️ 兜底值必须是 {} 而不是 undefined —— 下面直接取 .list，
    //    兜成 undefined 会在 map 那里崩掉，那就从「少显示一栏」
    //    变成「整页白」。
    const pick = (p) =>
      p.then(
        (res) => ({ ok: true, result: (res && res.result) || {} }),
        (err) => {
          console.error('我卖出的：子请求失败', err);
          return { ok: false, result: {} };
        }
      );

    return Promise.all([
      pick(wx.cloud.callFunction({ name: 'order', data: { action: 'listReceived' } })),
      pick(wx.cloud.callFunction({ name: 'manageGoods', data: { action: 'listSold' } }))
    ])
      .then(([orderRes, soldRes]) => {
        wx.hideLoading();

        const orderResult = orderRes.result;
        const soldResult = soldRes.result;

        const orders = orderResult.list || [];

        // 待我确认的
        const orderList = orders
          .filter((o) => o.status === ORDER_STATUS.PENDING)
          .map((o) => ({
            id: o._id,
            goodsId: o.goodsId,
            title: (o.goods || {}).title || '商品已删除',
            image: (o.goods || {}).image || '',
            price: formatPrice((o.goods || {}).price),
            buyerName: (o.buyer || {}).nickname || '校园用户',
            statusText: ORDER_STATUS_TEXT[o.status] || o.status,
            time: formatTime(o.createTime),
            // 是不是配送单。自提单上根本没有 delivery 这个字段
            // （云函数是「有才写」，不是写个 null 占位），所以直接判有无就行。
            //
            // 不取 delivery.sellerPhone：待确认的订单上它一定是空的 ——
            // 那个号本来就是「确认这一步」才填进去的。
            isDelivery: !!o.delivery
          }));

        // 已完成的订单：拿来做 goodsId → 买家昵称 的映射。
        // 「我卖出的」原来只显示商品，看不出卖给谁了 —— 这个信息其实一直
        // 存在于订单里，只是没取出来用。
        const buyerMap = {};
        orders.forEach((o) => {
          if (o.status === ORDER_STATUS.COMPLETED) {
            buyerMap[o.goodsId] = (o.buyer || {}).nickname || '校园用户';
          }
        });

        const soldList = (soldResult.list || []).map((item) => ({
          id: item._id,
          title: item.title,
          image: (item.images && item.images[0]) || '',
          price: formatPrice(item.price),
          campus: item.campus,
          // 有订单记录的显示买家，线下直接卖掉的（没有订单）留空
          buyerName: buyerMap[item._id] || '',
          soldTime: formatTime(item.soldTime)
        }));

        // 我自己的手机号。有值的话，确认配送单时就不用再问一遍。
        // `|| ''` 兜底：云函数查不到用户记录（理论上不会，但别赌）时
        // 返回 undefined，setData 出去 WXML 里就成了 "undefined" 字符串。
        this.setData({ orderList, soldList, myPhone: orderResult.myPhone || '' });

        // 把「哪一块没拉到」说出来。只提示失败的那一栏，不写成泛泛的
        // 「加载失败」—— 用户下拉重试时至少知道该盯哪儿。
        const failed = [];
        if (!orderRes.ok) failed.push('待确认订单');
        if (!soldRes.ok) failed.push('已卖出');
        if (failed.length > 0) {
          wx.showToast({
            title: failed.join('、') + '加载失败，请下拉重试',
            icon: 'none'
          });
        }
      })
      .catch((err) => {
        // 走到这里说明是 setData / map 这类同步错误，不是网络问题（网络已被 pick 吃掉）。
        // 留着是安全网，别删。
        wx.hideLoading();
        console.error('我卖出的：渲染失败', err);
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  onShow() {
    // 横条显不显示是纯展示层的事，读本地标记就够，不用问服务器。
    // 放在 onShow 而不是 onLoad：用户点完「开启」横条收起，
    // 从别的页面再回来时也不该重新冒出来。
    this.setData({ subscribed: isDone(SUBSCRIBE_TEMPLATE.NEW_ORDER) });
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {

  }
});
