// pages/about/about.js
const { BRAND } = require('../../utils/cloud-config');

Page({
  // 【品牌名不写死在这一页】
  //   「关于」页是买家接手后最该改的地方，但名字本身不该散落在 wxml 里。
  //   统一来自 utils/cloud-config.js 的 BRAND，买家改那一处，这一页跟着变。
  data: { brand: BRAND },
  onLoad(options) {},
  onReady() {},
  onShow() {},
  onHide() {},
  onUnload() {},
  onPullDownRefresh() {},
  onReachBottom() {},
  onShareAppMessage() {}
})
