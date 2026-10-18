// pages/address/address.js
Page({
  data: {
    addressList: [],
    loading: false
  },

  // 加载我的地址列表（走 address 云函数，云函数里已按 _openid 过滤）
  loadList() {
    wx.showLoading({ title: '加载中...' });
    return wx.cloud
      .callFunction({ name: 'address', data: { action: 'list' } })
      .then((res) => {
        wx.hideLoading();
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '加载失败', icon: 'none' });
          return;
        }
        // 云数据库的字段叫 _id，wxml 里用的是 id，这里转换一道
        const addressList = (result.list || []).map((item) => ({
          id: item._id,
          name: item.name,
          phone: item.phone,
          campus: item.campus,
          detail: item.detail,
          isDefault: !!item.isDefault
        }));
        this.setData({ addressList });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('加载地址失败：', err);
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  // 【2026-10-16 删掉了 onSelectAddress】
  //
  // 它原来长这样：整个函数体只有一行 console.log('选中地址：', id)，
  // 注释写的是「预留：将来下单页可选收货地址」。而 wxml 里
  // 地址卡片【整块】挂着 bindtap="onSelectAddress"。
  //
  // 于是用户看到的是：一张看起来能点的卡片，点下去【什么都不发生】。
  // 这正是最难被当成 bug 的那种 bug —— 不报错、不弹窗、没有 toast，
  // 用户只会反复点几次，然后认为「这个小程序有点卡」。
  //
  // 为什么是删而不是把它实现掉：全项目只有「我的 → 地址管理」一个入口
  // （搜 pages/address/address 只命中 user.js 那一处），下单选地址走的是
  // detail 页自己的弹层，从来不需要这个页面返回什么。
  // 也就是说这里【根本没有「选中」这个语义】—— 预留的是个不存在的需求。
  //
  // ⚠️ 将来真要做「从地址页选一个带回去」，要先给页面加个入口参数
  //   （比如 ?select=1），再按那个参数决定要不要挂 bindtap。
  //   不要无条件把 bindtap 挂回去。

  // 新增地址
  onAddAddress() {
    wx.navigateTo({ url: '/pages/address_edit/address_edit' });
  },

  // 编辑地址
  onEditAddress(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/address_edit/address_edit?id=${id}` });
  },

  // 删除地址（先确认，再调云函数）
  onDeleteAddress(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '提示',
      content: '确认删除该地址？',
      success: (res) => {
        if (res.confirm) this.doDelete(id);
      }
    });
  },

  // 调云函数删除；云函数会校验这条地址是不是本人的
  doDelete(id) {
    wx.showLoading({ title: '删除中...' });
    wx.cloud
      .callFunction({ name: 'address', data: { action: 'remove', id } })
      .then((res) => {
        wx.hideLoading();
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '删除失败', icon: 'none' });
          return;
        }
        wx.showToast({ title: '删除成功', icon: 'success' });
        this.loadList(); // 重新拉一遍，保证页面和数据库一致
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('删除地址失败：', err);
        wx.showToast({ title: '删除失败，请稍后重试', icon: 'none' });
      });
  },

  onLoad(options) {},

  onReady() {},

  // 用 onShow 而不是 onLoad：从编辑页返回时也要刷新
  onShow() {
    this.loadList();
  },

  onHide() {},

  onUnload() {},

  onPullDownRefresh() {
    this.loadList().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {},

  onShareAppMessage() {}
});
