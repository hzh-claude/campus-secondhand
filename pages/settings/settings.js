// pages/settings/settings.js
//
// 【这个页面为什么存在】
//   原来「我的」页面底部那一格「设置」点进去，跳的是 /pages/edit/edit ——
//   和头像右边那个「编辑」铅笔图标【是同一个页面】。
//   两个入口、一个去处，用户点第二次就会发现「这不就是我刚编辑过的地方吗」。
//
//   现在这一格指向真正的设置页，编辑资料的入口只留头像右边那个铅笔。
//   路径不同、内容不同，重复感就没了。
//
// 【为什么不做「字体大小」】
//   这是最初想放进来的一项，但它在小程序里不是一个「简单的小设置」：
//   全项目 21 个页面的字号写的都是 rpx，而 rpx 是按屏幕宽度固定换算的 ——
//   750rpx 永远等于屏幕宽度，放大字号必须换成 rem，
//   再给每个页面挂 page-meta 的 root-font-size。那是一次覆盖所有页面的
//   机械改造，适合单独立项，不适合混在这个页面里顺手做。
//   真要做的时候，入口就加在下面「通用」那一组里。
const { SUBSCRIBE_TEMPLATE, BRAND } = require('../../utils/cloud-config');
const { requestSubscribe } = require('../../utils/subscribe');

Page({

  data: {
    // 品牌名。页脚那行小字用它，见 WXML。
    // 不写死在 wxml 里，理由同 about 页：买家换项目只改 BRAND 一处。
    brand: BRAND,
    // 本地缓存占用，'0KB' 这种直接可读的字符串
    cacheSize: '0KB',
    // 微信的自动更新检查结果。初始是「还没查出来」，
    // 三种状态对应三种文案，见 WXML
    updateState: 'unknown' // unknown | latest | ready | failed
  },

  onLoad() {
    this.refreshCacheSize();
    this.watchUpdate();
  },

  // ============================================================
  // 通知
  // ============================================================

  // 有人下单时通知我（卖家侧）
  onSubscribeNewOrder() {
    requestSubscribe(SUBSCRIBE_TEMPLATE.NEW_ORDER, '新订单通知');
  },

  // 订单有结果时通知我（买家侧）
  onSubscribeOrderStatus() {
    requestSubscribe(SUBSCRIBE_TEMPLATE.ORDER_STATUS, '订单状态通知');
  },

  // ============================================================
  // 缓存
  // ============================================================

  refreshCacheSize() {
    try {
      const info = wx.getStorageInfoSync();
      const kb = info.currentSize || 0;
      this.setData({
        // 小于 1MB 显示 KB，否则显示 MB。
        // getStorageInfoSync 给的单位是 KB。
        cacheSize: kb >= 1024 ? (kb / 1024).toFixed(1) + 'MB' : kb + 'KB'
      });
    } catch (err) {
      console.warn('读取缓存占用失败：', err);
      this.setData({ cacheSize: '未知' });
    }
  },

  // 清除缓存
  //
  // 【这里清得很干净是安全的，因为这个项目本地不存任何有价值的东西】
  //   身份是云函数从 getWXContext 拿的，本地没有登录态、没有 token。
  //   storage 里一共三个键：
  //     needRefreshGoods —— 「商品在售状态变了，列表页下次显示时重查一次」。
  //                         用的是 utils/goods-refresh.js 里的那两个函数，
  //                         谁写谁读那张名单在那个文件顶部。
  //     editingGoodsId  —— 「我发布的」点编辑时传给发布页的商品 ID
  //     searchHistory   —— 搜索页的搜索历史（最多 10 条，
  //                         见 pages/search/search.js 的 HISTORY_KEY）
  //   前两个是「用完即弃的标记」，丢了只是「本来要做的那一下不做了」。
  //   ⚠️ 第三个不一样：它是用户一条条攒出来的，清掉是【真的会少】的。
  //      所以下面那句提示文案里点明了它，否则用户点完「清除」回到搜索页
  //      发现历史空了，会以为是把数据弄丢了。
  //      不必为它加确认或保留策略 —— 它只存在本机、云端没有副本，
  //      攒回来只是再搜几次；这是「只存本地」这个选择的代价，不是 bug。
  //
  //   真正的用户数据（档案、商品、订单、聊天）全在云端，
  //   清本地缓存碰不到它们 —— 这一点必须跟用户说清楚，
  //   否则「清除缓存」四个字会让人以为要丢东西，谁都不敢点。
  onClearCache() {
    wx.showModal({
      title: '清除缓存',
      content:
        '只清理本机的临时数据（含搜索历史，当前 ' +
        this.data.cacheSize +
        '）。你的账号、发布的商品、订单和聊天记录都在云端，不会被删除。',
      confirmText: '清除',
      confirmColor: '#FF9500',
      success: (res) => {
        if (!res.confirm) return;
        try {
          wx.clearStorageSync();
        } catch (err) {
          console.warn('清除缓存失败：', err);
        }
        this.refreshCacheSize();
        wx.showToast({ title: '已清除', icon: 'success' });
      }
    });
  },

  // ============================================================
  // 更新
  // ============================================================

  // 【为什么用 getUpdateManager，而不是自己写个版本号比对】
  //   小程序的代码包本来就是微信在冷启动时自动拉新的，开发者能做的只有
  //   「发现新版本 → 提示用户 → 重启应用生效」这一件事，
  //   getUpdateManager 就是干这个的。自己维护版本号反而会变成
  //   一个永远追不上微信的假功能。
  //
  //   监听器只在 onLoad 注册一次：getUpdateManager 返回的是同一个单例，
  //   每点一次就注册一遍的话，回调会越堆越多，
  //   点十次「检查更新」就弹十次。
  watchUpdate() {
    if (typeof wx.getUpdateManager !== 'function') {
      // 低版本基础库没有这个 API。不是错误，就是这台设备查不了
      this.setData({ updateState: 'unknown' });
      return;
    }

    const um = wx.getUpdateManager();

    um.onCheckForUpdate((res) => {
      this.setData({ updateState: res.hasUpdate ? 'ready' : 'latest' });
    });

    um.onUpdateReady(() => {
      this.setData({ updateState: 'ready' });
      wx.showModal({
        title: '发现新版本',
        content: '新版本已经准备好了，重启小程序即可使用',
        confirmText: '立即重启',
        confirmColor: '#FF9500',
        success: (r) => {
          if (r.confirm) um.applyUpdate();
        }
      });
    });

    um.onUpdateFailed(() => {
      this.setData({ updateState: 'failed' });
    });
  },

  // 点「检查更新」：把已经拿到的结果显示出来
  //
  // 说清楚为什么是「已经拿到的结果」而不是现查一次：
  // 微信在 SDK 里没有提供「立刻联网查一次」的接口 ——
  // onCheckForUpdate 报的是本次启动时那次检查的结果。
  // 假装能现查，只会写出一段永远显示「已是最新」的代码。
  onCheckUpdate() {
    const map = {
      unknown: '当前环境无法检查更新',
      latest: '已是最新版本',
      ready: '发现新版本，正在下载',
      failed: '新版本下载失败，请重启小程序'
    };
    wx.showToast({
      title: map[this.data.updateState] || '已是最新版本',
      icon: 'none',
      duration: 2000
    });
  },

  // ============================================================
  // 跳转
  // ============================================================

  // 【这一组只有隐私政策，不是漏写了】
  //   「意见反馈」「关于我们」在「我的 → 工具箱」里已经有了。
  //   把它们再抄一份进设置页，就是新造一组重复 ——
  //   而这一页存在的全部理由，恰恰是消掉「设置 == 编辑资料」那种重复。
  //   所以这里只放一个【除了设置页没别处能进】的隐私政策。
  onOpenPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  }
});
