// pages/home/home.js
const { COLLECTION, GOODS_STATUS, PAGE_SIZE, BRAND } = require('../../utils/cloud-config');
const { refreshUnreadBadge } = require('../../utils/unread');
const { CATEGORIES } = require('../../utils/categories');
const { consumeGoodsChanged } = require('../../utils/goods-refresh');

Page({

  /**
   * 页面的初始数据
   */
  data: {
    searchValue: '',
    // 首页轮播图。
    //
    // 【2026-10-16 拆掉了这里的外链】
    //   原来三张图写的是 images.unsplash.com 的地址。小程序里 <image> 加载
    //   网络图同样走 downloadFile，域名不在后台「downloadFile 合法域名」里
    //   就是【三个白框】—— 而开发者工具默认不校验域名，工具里看不出任何问题。
    //   这是首页，每个用户第一眼看到的就是它。
    //   ⚠️ 同一个坑在 concat 和 about 两个页面上早就修过了，这里漏了。
    //
    // 【为什么改成「用样式画」而不是换几张本地图】
    //   换本地图只是把问题挪走：图得有，而且要三张 800x400 的。
    //   而轮播图的全部内容是【一句话】，用 CSS 渐变 + 文字就够了 ——
    //   零网络依赖、零新增图片文件、包体不涨、审核也不会问「为什么要请求站外资源」。
    //
    // 【想换成真实推广图怎么办】
    //   把下面三项换成 { id, image }，image 填云存储的 fileID（cloud:// 开头），
    //   wxml 里换回 <image src="{{item.image}}"> 即可。
    //   ⚠️ 云存储的 fileID 不受「合法域名」限制，这是它比外链好的地方。
    //   千万不要换回 https:// 开头的外链 —— 那就又回到白框了。
    bannerList: [
      { id: 1, theme: 'a', title: '校内闲置交易', desc: '只对已核验的同学开放' },
      { id: 2, theme: 'b', title: '发布你的闲置', desc: '拍照上传，几分钟就发出去' },
      { id: 3, theme: 'c', title: '自提或校内配送', desc: '配送费当面付给配送员' }
    ],
    // 分类数据
    //
    // 【这里不再自己写一份了】
    //   以前首页和发布页各写一份分类列表，靠注释互相提醒「两边要一致」。
    //   那个坑真的发生过一次：「其他」先加进了 push.js，首页漏了，
    //   于是「其他」下的商品首页点不进去 —— 商品还在商品流里飘着、
    //   详情也打得开，就是没有任何分类入口能找到它。
    //   现在唯一来源是 utils/categories.js，两边引用同一份，
    //   加分类只改那一个文件。
    //
    //   WXML 用到的 id / name / icon 三个字段都在 CATEGORIES 里。
    //   id 只用于 wx:key；真正决定查询结果的是 name ——
    //   type_list 是按 category 字段【精确匹配名字】查的，不是按 id。
    categoryList: CATEGORIES,
    // 商品列表数据（来自云数据库 goods 集合）
    goodsList: [],
    // 分页与加载状态
    page: 0,
    loading: false,
    isEnd: false
  },

  // 搜索事件
  //
  // 这里原来只有一行 console.log —— 用户打字、回车，界面上什么都不发生，
  // 只在小程序后台留一行日志。有个搜索框却搜不了，比没有搜索框更糟：
  // 用户会以为整个小程序坏了。
  //
  // van-search 的 search 事件里 e.detail 【就是输入值本身（字符串）】，
  // 不是 { value: ... }。抄错就是又一次「点了没反应」。
  onSearch(e) {
    const keyword = String(e.detail || '').trim();
    if (!keyword) {
      wx.showToast({ title: '请输入搜索关键词', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/search/search?keyword=' + encodeURIComponent(keyword)
    });
  },

  // 点击分类
  onCategoryTap(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/type_list/type_list?id=${id}&name=${encodeURIComponent(name)}`
    });
  },

  // 点击商品卡片
  //
  // id 从 goods-card 组件的 cardtap 事件里来（e.detail.id），
  // 【不是】e.currentTarget.dataset —— 组件已经不用 data-id 了。
  // 抄成 dataset 的话拿到的是 undefined，跳转地址变成 ?id=undefined，
  // 详情页只会说「商品不存在」，看不出是这里的问题。
  onGoodsTap(e) {
    const { id } = e.detail;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`
    });
  },

  // 加载商品列表（reset 为 true 时从头加载）
  loadGoods(reset) {
    if (this.data.loading) return Promise.resolve();
    if (!reset && this.data.isEnd) return Promise.resolve();

    this.setData({ loading: true });
    const page = reset ? 0 : this.data.page;
    const db = wx.cloud.database();

    return db
      .collection(COLLECTION.GOODS)
      .where({ status: GOODS_STATUS.ON_SALE })
      .orderBy('createTime', 'desc')
      .skip(page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .get()
      .then((res) => {
        const list = (res.data || []).map((item) => ({
          id: item._id,
          title: item.title,
          price: item.price,
          image: (item.images && item.images[0]) || '',
          campus: item.campus,
          views: item.views || 0,
          publisher: item.publisher || { avatar: '', nickname: '校园用户' }
        }));

        this.setData({
          goodsList: reset ? list : this.data.goodsList.concat(list),
          page: page + 1,
          isEnd: list.length < PAGE_SIZE,
          loading: false
        });
      })
      .catch((err) => {
        console.error('加载商品列表失败：', err);
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    this.loadGoods(true);
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
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().init();
      // 未读红点。三个 tab 页都要各刷一次 —— 自定义 tabBar 的实例
      // 是每个 tab 页一份，只在「我的」页刷的话，人在首页时看不到红点。
      // 放在 if 里面：没有 tabBar 就没地方显示红点，不必白查一次云函数
      refreshUnreadBadge(this);
    }
    // 发布 / 上下架 / 下单 / 交易结束后返回首页时，重查一次列表。
    //
    // 【为什么不是无条件重查】
    //   首页是分页的长列表，用户在里头翻了好几页、点进详情看一眼再退回来
    //   是常事。无条件 loadGoods(true) 会把列表打回第一页，翻过的全丢。
    //   所以只在【真的改动过商品】时才刷 —— 判断和原因见
    //   utils/goods-refresh.js 顶部。
    if (consumeGoodsChanged()) {
      this.loadGoods(true);
    }
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
    this.loadGoods(true).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {
    this.loadGoods(false);
  },

  /**
   * 用户点击右上角分享
   *
   * 首页是小程序对外的门面，分享出去的是「这个小程序本身」，
   * 所以 path 指回首页，标题写清楚它是干什么的。
   *
   * 这里【故意不给 imageUrl】：首页没有一件确定的商品图可以代表它，
   * 而随便挑一条在售商品当封面，等那件卖出去了分享卡片就变成一张
   * 已售商品的图 —— 不如让微信直接用页面截图（截图里有轮播图，效果不差）。
   * 传 undefined 等于不传，微信自动兜底。
   */
  onShareAppMessage() {
    return {
      // 品牌名和学校名来自 BRAND，不写死 —— 买家换项目只改那一处
      title: BRAND.APP_NAME + ' · ' + BRAND.SCHOOL_NAME + '校园二手交易',
      path: '/pages/home/home'
    };
  }
})