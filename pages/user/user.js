// pages/user/user.js
const { DEFAULT_AVATAR } = require('../../utils/cloud-config');
const { refreshUnreadBadge } = require('../../utils/unread');

// 菜单列表
// 「我的消息」放第一个：聊天是这个小程序里唯一「别人找你」的入口，
// 排在「我发布的」后面的话，有人发消息给你，你得翻两层才看得到
//
// 抽成模块常量而不是直接写在 data 里：下面「我是不是配送员」那个判断
// 每次刷新都要重算一遍菜单。拿 this.data.menuList 去 concat 的话，
// 第二轮就会把「配送管理」加第二遍 —— 常量每次从头拼，才不会累积。
const MENU_LIST = [
  { id: 5, title: '我的消息', icon: 'chat-o', url: '/pages/message/message' },
  { id: 1, title: '我发布的', icon: 'records', url: '/pages/my_push/my_push' },
  { id: 2, title: '我卖出的', icon: 'gold-coin-o', url: '/pages/my_sold/my_sold' },
  { id: 3, title: '我买到的', icon: 'bag-o', url: '/pages/my_buy/my_buy' },
  { id: 4, title: '我的收藏', icon: 'star-o', url: '/pages/my_favorite/my_favorite' }
];

// 只有配送员看得到的一项。单独拿出来，不塞进 MENU_LIST ——
// 它不是「默认有、按条件隐藏」，是「默认没有、按条件添加」。
//
// ⚠️ menuList 和 toolList 的 id 各自从 1 开始、【是重复的】，
//    两列并起来时不能用 id 去重。onMenuTap 实际是按 title 查表，
//    所以这一项的 title 必须和别处不重样。
const DELIVERY_MENU_ITEM = {
  id: 6,
  title: '配送管理',
  icon: 'logistics',
  url: '/pages/delivery/delivery'
};

// 工具菜单
const TOOL_LIST = [
  { id: 1, title: '地址管理', icon: 'location-o', url: '/pages/address/address' },
  { id: 2, title: '联系客服', icon: 'service-o', url: '/pages/concat/concat' },
  { id: 3, title: '意见反馈', icon: 'comment-o', url: '/pages/suggest/suggest' },
  { id: 4, title: '关于我们', icon: 'info-o', url: '/pages/about/about' }
];

Page({

  /**
   * 页面的初始数据
   */
  data: {
    // 用户信息（初始为空，由 loadHomeData 拉取真实数据填充）
    userInfo: {
      // 空字符串 = 没设头像，由 WXML 兜底显示默认图。
      // 这里【故意不填默认图】—— 填了会被编辑页的上传逻辑当成用户选的图片，
      // 详见 utils/cloud-config.js 里 DEFAULT_AVATAR 的说明
      avatar: '',
      nickname: '加载中...',
      realName: '',
      campus: '',
      studentId: ''
    },
    // 校内身份核验状态：true 已核验 / false 未核验 / null 还不知道
    //
    // 【初值必须是 null，不能是 false】
    //   档案拉回来之前我们并不知道用户核验过没有。填 false 的话，
    //   已注册用户每次进这一页都会先看到一瞬间的「去完成核验」提示条，
    //   再眼睁睁看它消失 —— 像页面在抖，而且那一瞬间他会以为自己
    //   的注册掉了。填 true 又会反过来骗未注册的人。
    //   WXML 里用 verified === false 渲染，null 就什么都不显示。
    verified: null,
    // 默认头像。WXML 里读不到 require 进来的常量，只能挂到 data 上再引用
    defaultAvatar: DEFAULT_AVATAR,
    // 统计数据
    statistics: {
      published: 0,
      sold: 0,
      bought: 0
    },
    loading: false,
    // 未读条数（聊天 + 站内通知），显示在「我的消息」那一行右边。
    // 由 onShow 里那次 refreshUnreadBadge 喂进来 —— 和 tabBar 上
    // 那个数字是【同一次查询、同一个数】。
    //
    // 【初值必须是 0，不能是别的】WXML 里用 unreadTotal > 0 决定显不显示，
    // 0 就是「还没查到」，显示成没有红点的样子 —— 这是对的：查失败时
    // fetchUnread 给的就是 0，我们宁可少显示一个红点，也不能凭空造一个。
    unreadTotal: 0,
    // 上面那个数字的显示形式（超过 99 变 '99+'）。
    // 在 JS 里算好再传，不在 WXML 里做判断 —— 和 custom-tab-bar 的
    // unreadText 是同一套规则，两处必须一致。
    unreadText: '',
    // 菜单列表（初始不含「配送管理」，由 loadHomeData 按身份补上）
    menuList: MENU_LIST,
    // 工具菜单
    toolList: TOOL_LIST
  },

  // 拉取档案 + 统计 + 我是不是配送员
  // 身份由云函数自己从 getWXContext 取，前端不传 openid
  loadHomeData() {
    if (this.data.loading) return Promise.resolve();
    this.setData({ loading: true });

    return Promise.all([
      wx.cloud.callFunction({ name: 'user', data: { action: 'getHomeData' } }),
      // 「我是不是配送员」走 order 云函数的 whoami，【不能】去问 user 云函数：
      // 白名单只有一份，就在 order 里（见那边 whoami 上方的注释）。
      // 在这儿问一次，比让每个页面各自猜要靠谱。
      //
      // 【失败就当他不是】用 catch 兜成 null：这是一次旁路查询，
      // 它挂了不该连累整个「我的」页面加载不出来。
      // 判错的代价只是少一个入口 —— 点进去（或者手动导航进去）
      // 仍然会被服务端拦住，门禁从来不在前端。
      wx.cloud
        .callFunction({ name: 'order', data: { action: 'whoami' } })
        .catch((err) => {
          console.warn('查询配送员身份失败，按非配送员处理：', err);
          return null;
        })
    ])
      .then(([res, whoRes]) => {
        const result = (res && res.result) || {};
        if (result.code !== 0) {
          wx.showToast({ title: result.message || '加载失败', icon: 'none' });
          this.setData({ loading: false });
          return;
        }

        const user = result.user || {};
        const stats = result.stats || {};
        const who = (whoRes && whoRes.result) || {};

        this.setData({
          verified: user.verified === true,
          userInfo: {
            avatar: user.avatar || '',
            nickname: user.nickname || '校园用户',
            // 真名只挂到 data 上，【这一页不显示它】—— 展示名是昵称。
            // 留着是为了编辑资料页回填时不必再拉一次档案。
            realName: user.realName || '',
            // 空值给个占位文案，避免页面上出现空白行
            campus: user.campus || '未设置宿舍',
            studentId: user.studentId || '未填写学号'
          },
          statistics: {
            published: stats.published || 0,
            sold: stats.sold || 0,
            bought: stats.bought || 0
          },
          // 从 MENU_LIST 重新拼，不是拿 this.data.menuList 去加 ——
          // 见 MENU_LIST 上方的说明
          menuList: who.isAdmin
            ? MENU_LIST.concat([DELIVERY_MENU_ITEM])
            : MENU_LIST,
          loading: false
        });
      })
      .catch((err) => {
        console.error('加载用户信息失败：', err);
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
      });
  },

  // 点击头像右边的编辑铅笔。
  //
  // 【改资料现在只有这一个入口了】
  //   以前「头像右边的铅笔」和左下角「设置」都跳这里，点完会发现是同一个页面。
  //   现在编辑资料归铅笔、设置归设置页，两件事不再撞车。
  onEditProfile() {
    wx.navigateTo({ url: '/pages/edit/edit' });
  },

  // 未核验提示条上的「去完成核验」。
  //
  // navigateTo 而不是 switchTab/reLaunch：注册页不是 tab 页，
  // 而且它现在是可以退出的普通页面 —— 用户填一半反悔，按返回就回到这里。
  onGoRegister() {
    wx.navigateTo({ url: '/pages/register/register' });
  },

  // 点击菜单项
  onMenuTap(e) {
    const { title } = e.currentTarget.dataset;
    const menu = [...this.data.menuList, ...this.data.toolList].find(item => item.title === title);
    if (menu && menu.url) {
      wx.navigateTo({ url: menu.url });
    }
  },

  // 点击设置
  //
  // 【原来这里跳的是 /pages/edit/edit，和上面那个铅笔同一个页面】
  //   两个入口一个去处，用户点第二次就发现「这不就是我刚编辑过的地方」。
  //   现在指向真正的设置页：通知、缓存、更新、隐私政策。
  //
  //   注意 pages/settings/settings 必须同时在 app.json 的 pages 数组里注册，
  //   否则 navigateTo 会静默失败（不报错，就是不跳）。
  onSettingTap() {
    wx.navigateTo({ url: '/pages/settings/settings' });
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
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().init();
      // 未读红点。这里是「我的」页 —— 用户读完消息从消息列表返回时，
      // 靠的就是这一次刷新把红点灭掉。
      //
      // 【这一次调用喂两处，两个数必须一致】
      //   1. tabBar 角标 —— refreshUnreadBadge 内部自己塞给 tabBar
      //   2. 「我的消息」那一行右边的条数 —— 下面 setData
      //   要是分开查两次，就可能出现 tabBar 显示 3、那一行显示 2 的场面；
      //   同一个东西在同一个屏幕上给出两个数，用户只会认为程序坏了。
      //   所以两处都从这一次的返回值里取。
      refreshUnreadBadge(this).then((counts) => {
        this.setData({
          unreadTotal: counts.total,
          // 和 custom-tab-bar/index.js 里的 99+ 是同一套规则。
          // 数字太长的角标会把那一行挤变形。
          unreadText: counts.total > 99 ? '99+' : String(counts.total)
        });
      });
    }
    // 必须放在 onShow：tabBar 页面只创建一次，
    // 从编辑页保存后返回不会重新触发 onLoad，头像昵称就刷不新
    this.loadHomeData();
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
    this.loadHomeData().then(() => wx.stopPullDownRefresh());
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
