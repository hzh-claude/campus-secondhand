// pages/concat/concat.js

// 客服页。这个页面很小，但它的历史值得看一眼 —— 它被来回改过两次。
//
// 【2026-10-14：删掉「联系方式」那一整块】
//   删的是：data.contact、onCallPhone、onCopyWechat、onCopyEmail，
//   以及 wxml 里带图标的三条列表（客服电话 / 微信 / 邮箱）。
//
// 【2026-10-15：又把【邮箱】加回来了】
//   只加回邮箱一种，而且【不恢复原来那个带图标的三条列表】——
//   只在按钮下面加一行小字（见 wxml 里 .contact-email 那一行）。
//   理由见 utils/cloud-config.js 里 SERVICE_EMAIL 的注释，核心是两条：
//     1. 后台《用户隐私保护指引》第 4 节承诺了「可通过邮箱联系开发者
//        行使查阅/注销等权利」，App 里得能找得到这个邮箱；
//     2. open-type="contact" 那个按钮在后台没开通客服功能时
//        【点了毫无反应】，页面里必须有第二条路。
//
// 【为什么当时四个一起删，现在只加回一个】
//   删的时候一起删，是因为「只删 wxml」会留下 data 和三个函数变成
//   永远不会被执行的死代码 —— 看着像还在工作，实际谁也不调。
//   现在加回来，也只加回真会用到的那一个（onCopyEmail），
//   电话和微信两个 handler 不恢复：页面上没有对应的入口，
//   恢复了就是同一个死代码问题。
//
// 【历史上这里踩过的坑，值得记一笔】
//   这三个值原来在 wxml 里写一遍、在三个函数里又各写一遍，而且写岔了：
//     电话：界面显示的号码比实际拨出去的少一位（永远打不通）
//     微信：界面显示的号，和复制到剪贴板的号，【完全是两个号】
//   第二种最坑：用户点「复制客服微信」，界面上明明写着一个号，
//   粘出来却是另一个 —— 他只会以为客服给错了联系方式，
//   而想不到是页面里存了两份不同的值。这种错误【不报错、不崩溃】，
//   只是安安静静地把人引到错的地方去。
//   ⇒ 所以现在这个邮箱也是【只存一份】：值在 cloud-config 的
//     SERVICE_EMAIL 里，wxml 读 data.serviceEmail，复制读同一个常量。
//     「同一份数据存两处」这个教训和这个页面无关，以后写别的页面照样适用。
const { DEFAULT_AVATAR, SERVICE_EMAIL } = require('../../utils/cloud-config');

Page({
  data: {
    activeNames: [],
    // 客服头像。原来这里写的是一个 unsplash 的外链 ——
    // 小程序里引外链图片要先配 downloadFile 合法域名，没配就是白框，
    // 而且审核也会问「为什么要请求站外资源」。全项目别的头像都用
    // 本地这张 default-avatar.png，这里跟着统一。
    defaultAvatar: DEFAULT_AVATAR,
    // 挂到 data 上给 wxml 用 —— wxml 里读不到 require 进来的常量，
    // 只能通过 data 透传。（和 detail 页透传 DEV_ALLOW_SELF_BUY 是同一个原因）
    serviceEmail: SERVICE_EMAIL
  },

  // 折叠面板变化
  onCollapseChange(e) {
    this.setData({ activeNames: e.detail });
  },

  // 微信原生客服会话的回调
  //
  // 【这个 handler 只用来「知道用户点过」，不做任何跳转】
  //   open-type="contact" 的行为完全由微信接管：
  //   点下去直接进入微信官方的客服会话窗口，不走小程序路由。
  //   所以这里没有 wx.navigateTo，也不需要 —— 写了也会被忽略。
  //
  // 【说清楚它做不到什么，免得以后误以为有兜底】
  //   bindcontact 是【会话成功打开时】才触发的成功回调。
  //   如果 mp 后台没开通客服功能、或者没绑客服人员，
  //   点按钮是【一点反应都没有】—— 不报错、不弹窗、回调也不来。
  //   也就是说，这个函数【没有能力】发现那种情况。
  //
  //   ⚠️ 所以别把这里改成「出错了就提示」—— bindcontact 在失败时
  //      根本不会触发，那个提示永远不会出现。
  //      页面上那行邮箱才是兜底（见 wxml）。
  onContact(e) {
    console.log('已进入客服会话：', e.detail);
  },

  // 点邮箱复制到剪贴板。
  //
  // 【为什么要做成一键复制，而不是让用户自己长按选中】
  //   邮箱是要粘到邮件客户端里用的，让人拿手指去选中
  //   那串「名字@域名」的字符，很容易少复制一个字母 ——
  //   然后邮件发不出去，而他不会觉得是自己复制错了。
  //   一次点击 + 一句「已复制」的提示，把这个出错空间直接消掉。
  //
  // 值和页面显示的是同一个常量（SERVICE_EMAIL），改一处两边都变。
  onCopyEmail() {
    // 空值不复制：云函数和配置都可能给出空串，复制一个空字符串
    // 只会弹一句「已复制」而什么都没复制，比不给提示更糟。
    // wxml 那边也有 wx:if 挡着，这里是第二道。
    if (!SERVICE_EMAIL) return;

    wx.setClipboardData({
      data: SERVICE_EMAIL,
      success: () => {
        wx.showToast({ title: '邮箱已复制', icon: 'success' });
      }
    });
  },

  onLoad(options) {},
  onReady() {},
  onShow() {},
  onHide() {},
  onUnload() {},
  onPullDownRefresh() {},
  onReachBottom() {},
  onShareAppMessage() {}
})
