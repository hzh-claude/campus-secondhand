// pages/my_push/my_push.js
const { COLLECTION, GOODS_STATUS } = require('../../utils/cloud-config');
const { formatTime, formatPrice } = require('../../utils/util');
const { markGoodsChanged } = require('../../utils/goods-refresh');

Page({

  /**
   * 页面的初始数据
   */
  data: {
    // 已被买家下单、等待我确认的商品（对应订单的 pending 状态）
    lockedList: [],
    activeTab: 0,
    // 出售中列表（来自云数据库，按状态过滤）
    onSaleList: [],
    // 已下架列表（来自云数据库，按状态过滤）
    offSaleList: [],
    loading: false
  },

  // 切换Tab
  onTabChange(e) {
    this.setData({
      activeTab: e.detail.index
    });
  },

  // 点击商品
  onGoodsTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`
    });
  },

  // 编辑商品（push 为 tabBar 页面，用 storage 传递商品 ID）
  onEditTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.setStorageSync('editingGoodsId', id);
    wx.switchTab({
      url: '/pages/push/push'
    });
  },

  // 下架商品
  onOffSaleTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '提示',
      content: '确认下架该商品？',
      success: (res) => {
        if (res.confirm) this.doManageAction('offSale', id, '下架成功');
      }
    });
  },

  // 重新上架
  onReSaleTap(e) {
    const { id } = e.currentTarget.dataset;
    this.doManageAction('reSale', id, '重新上架成功');
  },

  // 标记为已卖出
  // 标记后商品会从「我发布的」移出，出现在「我卖出的」里
  onMarkSoldTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '确认卖出',
      content: '确认该商品已经卖出？确认后它会从「我发布的」移到「我卖出的」',
      success: (res) => {
        if (res.confirm) this.doManageAction('markSold', id, '已标记为卖出');
      }
    });
  },

  // 删除商品（同时清理云存储图片）
  onDeleteTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '提示',
      content: '确认删除该商品？删除后无法恢复',
      success: (res) => {
        if (res.confirm) this.doManageAction('remove', id, '删除成功');
      }
    });
  },

  // 调用 manageGoods 云函数执行商品管理操作
  doManageAction(action, id, successText) {
    wx.showLoading({ title: '处理中...' });
    wx.cloud
      .callFunction({ name: 'manageGoods', data: { action, id } })
      .then((res) => {
        wx.hideLoading();
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '操作失败', icon: 'none' });
          return;
        }
        wx.showToast({ title: successText, icon: 'success' });
        markGoodsChanged();
        this.loadMine();
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('商品管理操作失败：', action, err);
        wx.showToast({ title: '操作失败，请稍后重试', icon: 'none' });
      });
  },

  // 已被预订的商品 → 去「我卖出的」处理那笔订单
  // （确认卖出 / 拒绝都在那边，因为那里能看到买家是谁、什么时候下的单）
  onGoOrdersTap() {
    wx.navigateTo({ url: '/pages/my_sold/my_sold' });
  },

  // 加载我发布的商品（云数据库 goods 集合，仅返回本人数据）
  loadMine() {
    wx.showLoading({ title: '加载中...' });
    return wx.cloud
      .callFunction({ name: 'manageGoods', data: { action: 'listMine' } })
      .then((res) => {
        wx.hideLoading();
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '加载失败', icon: 'none' });
          return;
        }
        const onSaleList = [];
        const lockedList = [];
        const offSaleList = [];
        (result.list || []).forEach((item) => {
          // 已卖出的商品归「我卖出的」页面管，不在这里重复出现
          // （两个页面都列同一批商品，用户会分不清该去哪个页面操作）
          if (item.status === GOODS_STATUS.SOLD) return;

          const view = {
            id: item._id,
            title: item.title,
            image: (item.images && item.images[0]) || '',
            // 格式化后再交给 WXML。WXML 里调不了函数，而库里可能存着
            // 1e25 这类历史脏数据，直接渲染会变成「¥1e+25」。
            price: formatPrice(item.price),
            campus: item.campus,
            views: item.views || 0,
            publishTime: formatTime(item.createTime),
            offSaleTime: formatTime(item.updateTime)
          };

          // 三种状态分三个 tab。
          // locked（已被买家下单）必须单独一格 —— 它既不是「在售」
          // （别人买不了），也不是「已下架」（还在交易流程里），
          // 塞进任何一边都会让这一格的标题变成谎话。
          if (item.status === GOODS_STATUS.ON_SALE) {
            onSaleList.push(view);
          } else if (item.status === GOODS_STATUS.LOCKED) {
            lockedList.push(view);
          } else {
            offSaleList.push(view);
          }
        });
        this.setData({ onSaleList, lockedList, offSaleList });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('加载我的发布失败：', err);
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {

  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    this.loadMine();
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {
    this.loadMine().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {

  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {

  }
})
